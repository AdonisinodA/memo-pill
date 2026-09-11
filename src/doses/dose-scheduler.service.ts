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
export const TOLERANCE_WINDOW_SEC = 30 * 60;

@Injectable()
export class DoseSchedulerService {
  private readonly logger = new Logger(DoseSchedulerService.name);

  constructor(
    @InjectRepository(DoseLog) private readonly doses: Repository<DoseLog>,
    private readonly push: PushService,
    private readonly medications: MedicationsService,
    private readonly clock: Clock,
  ) {}

  /**
   * Roda a cada minuto. Depende de instância única
   * (PM2 `exec_mode: fork`, `instances: 1` — ADR-001 §2.3).
   */
  @Cron('* * * * *')
  async tick(): Promise<void> {
    const missed = await this.markMissed();
    const dispatched = await this.dispatchDue();
    if (missed || dispatched) {
      // "despachada" e não "notificada": o que este número mede é a dose
      // reivindicada para envio. Se a entrega chegou a algum aparelho é outra
      // conta, e quem avisa é o warning de `dispatchDue`.
      this.logger.log(`${dispatched} dose(s) despachada(s), ${missed} perdida(s)`);
    }
  }

  /** Job diário que empurra o horizonte de pré-geração adiante. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async extendHorizon(): Promise<void> {
    const created = await this.medications.extendHorizon();
    this.logger.log(`Horizonte estendido: ${created} dose(s) criada(s)`);
  }

  /**
   * Doses cujo horário passou da tolerância sem resposta viram MISSED.
   * Permanecem no histórico de adesão, mas não geram alerta fora de hora.
   */
  async markMissed(): Promise<number> {
    const threshold = this.clock.nowSeconds() - TOLERANCE_WINDOW_SEC;
    const { affected } = await this.doses.update(
      { status: DoseStatus.PENDING, scheduledFor: LessThan(threshold) },
      { status: DoseStatus.MISSED },
    );
    return affected ?? 0;
  }

  /**
   * Seleciona as doses vencidas dentro da janela e ainda não notificadas.
   * O filtro usa a coluna de igualdade (`status`) e depois a de faixa
   * (`scheduled_for`), na mesma ordem do índice composto.
   */
  async dispatchDue(): Promise<number> {
    const now = this.clock.nowSeconds();

    const candidates = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('d.status = :pending', { pending: DoseStatus.PENDING })
      .andWhere('d.notified_at IS NULL')
      .andWhere('d.scheduled_for <= :now', { now })
      .andWhere('d.scheduled_for >= :threshold', {
        threshold: now - TOLERANCE_WINDOW_SEC,
      })
      .orderBy('d.scheduled_for', 'ASC')
      .getMany();

    let dispatched = 0;
    for (const dose of candidates) {
      if (!(await this.claim(dose.id, now))) continue;

      const result = await this.push.notifyDose(dose.medication!.userId, dose.id);
      dispatched++;

      // Dose despachada que não alcançou aparelho nenhum: o usuário não tem
      // inscrição push ativa. Sem este aviso a falha é invisível — a dose fica
      // com `notified_at` preenchido, o contador sobe e nada chega ao celular.
      if (result.delivered === 0) {
        this.logger.warn(
          `Dose ${dose.id} não chegou a nenhum aparelho: ` +
            `usuário ${dose.medication!.userId} não tem inscrição push ativa`,
        );
      }
    }
    return dispatched;
  }

  /**
   * Claim atômico: apenas a execução que efetivamente atualizar a linha
   * dispara a notificação. Protege contra envio duplicado caso mais de uma
   * instância do agendador venha a existir (ADR-001 §2.3).
   */
  private async claim(doseId: string, now: number): Promise<boolean> {
    const { affected } = await this.doses
      .createQueryBuilder()
      .update(DoseLog)
      .set({ notifiedAt: now })
      .where('id = :doseId', { doseId })
      .andWhere('notified_at IS NULL')
      .execute();
    return (affected ?? 0) > 0;
  }
}
