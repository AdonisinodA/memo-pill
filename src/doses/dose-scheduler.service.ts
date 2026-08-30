import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { MedicationsService } from '../medications/medications.service';
import { PushService } from '../push/push.service';
import { DoseLog } from './dose-log.entity';
import { DoseStatus } from './dose-status.enum';

/**
 * Tolerância de atraso em segundos (ADR-001 §2.3).
 *
 * Sem esse limite inferior, o retorno de uma indisponibilidade de horas
 * dispararia de uma vez todas as notificações atrasadas.
 */
export const JANELA_TOLERANCIA_SEG = 30 * 60;

@Injectable()
export class DoseSchedulerService {
  private readonly logger = new Logger(DoseSchedulerService.name);

  constructor(
    @InjectRepository(DoseLog) private readonly doses: Repository<DoseLog>,
    private readonly push: PushService,
    private readonly medicamentos: MedicationsService,
    private readonly clock: Clock,
  ) {}

  /**
   * Roda a cada minuto. Depende de instância única
   * (PM2 `exec_mode: fork`, `instances: 1` — ADR-001 §2.3).
   */
  @Cron('* * * * *')
  async tick(): Promise<void> {
    const perdidas = await this.marcarPerdidas();
    const notificadas = await this.dispararPendentes();
    if (perdidas || notificadas) {
      this.logger.log(`${notificadas} dose(s) notificada(s), ${perdidas} perdida(s)`);
    }
  }

  /** Job diário que empurra o horizonte de pré-geração adiante. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async estenderHorizonte(): Promise<void> {
    const criadas = await this.medicamentos.estenderHorizonte();
    this.logger.log(`Horizonte estendido: ${criadas} dose(s) criada(s)`);
  }

  /**
   * Doses cujo horário passou da tolerância sem resposta viram MISSED.
   * Permanecem no histórico de adesão, mas não geram alerta fora de hora.
   */
  async marcarPerdidas(): Promise<number> {
    const limite = this.clock.nowSeconds() - JANELA_TOLERANCIA_SEG;
    const { affected } = await this.doses.update(
      { status: DoseStatus.PENDING, scheduledFor: LessThan(limite) },
      { status: DoseStatus.MISSED },
    );
    return affected ?? 0;
  }

  /**
   * Seleciona as doses vencidas dentro da janela e ainda não notificadas.
   * O filtro usa a coluna de igualdade (`status`) e depois a de faixa
   * (`scheduled_for`), na mesma ordem do índice composto.
   */
  async dispararPendentes(): Promise<number> {
    const agora = this.clock.nowSeconds();

    const candidatas = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('d.status = :pendente', { pendente: DoseStatus.PENDING })
      .andWhere('d.notified_at IS NULL')
      .andWhere('d.scheduled_for <= :agora', { agora })
      .andWhere('d.scheduled_for >= :limite', {
        limite: agora - JANELA_TOLERANCIA_SEG,
      })
      .orderBy('d.scheduled_for', 'ASC')
      .getMany();

    let notificadas = 0;
    for (const dose of candidatas) {
      if (!(await this.reivindicar(dose.id, agora))) continue;
      await this.push.notificarDose(dose.medication!.userId, dose.id);
      notificadas++;
    }
    return notificadas;
  }

  /**
   * Claim atômico: apenas a execução que efetivamente atualizar a linha
   * dispara a notificação. Protege contra envio duplicado caso mais de uma
   * instância do agendador venha a existir (ADR-001 §2.3).
   */
  private async reivindicar(doseId: string, agora: number): Promise<boolean> {
    const { affected } = await this.doses
      .createQueryBuilder()
      .update(DoseLog)
      .set({ notifiedAt: agora })
      .where('id = :doseId', { doseId })
      .andWhere('notified_at IS NULL')
      .execute();
    return (affected ?? 0) > 0;
  }
}
