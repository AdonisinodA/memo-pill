import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateTime } from 'luxon';
import { Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { DoseLog } from './dose-log.entity';
import { DoseStatus, TERMINAL_STATUSES } from './dose-status.enum';

/** Modelo de view consumido por `views/dashboard.hbs`. */
export interface DoseDoDia {
  id: string;
  nome: string;
  dosagem: string;
  /** Horário local "HH:mm", já convertido do UTC para o fuso do usuário. */
  horario: string;
  /** Instante em UTC, para o atributo `datetime` do elemento <time>. */
  horarioISO: string;
  status: DoseStatus;
}

export interface ResumoAdesao {
  dias: number;
  total: number;
  tomadas: number;
  puladas: number;
  perdidas: number;
  pendentes: number;
  /** Percentual de doses tomadas sobre as já respondidas; nulo se não houver. */
  adesao: number | null;
}

/** Status que o usuário pode registrar a partir de uma dose pendente. */
export type StatusRegistravel = DoseStatus.TAKEN | DoseStatus.SKIPPED;

@Injectable()
export class DosesService {
  constructor(
    @InjectRepository(DoseLog) private readonly doses: Repository<DoseLog>,
    private readonly clock: Clock,
  ) {}

  /**
   * Doses do dia corrente no fuso do usuário. Canceladas não aparecem: elas
   * representam posologia que deixou de valer, não adesão.
   */
  async doDia(userId: string, timezone: string): Promise<DoseDoDia[]> {
    const agora = DateTime.fromSeconds(this.clock.nowSeconds(), { zone: timezone });
    const inicio = Math.floor(agora.startOf('day').toSeconds());
    const fim = Math.floor(agora.endOf('day').toSeconds());

    const registros = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('m.user_id = :userId', { userId })
      .andWhere('d.scheduled_for BETWEEN :inicio AND :fim', { inicio, fim })
      .andWhere('d.status != :cancelada', { cancelada: DoseStatus.CANCELED })
      .orderBy('d.scheduled_for', 'ASC')
      .getMany();

    return registros.map((d) => this.paraView(d, timezone));
  }

  private paraView(d: DoseLog, timezone: string): DoseDoDia {
    return {
      id: d.id,
      nome: d.medication!.nome,
      dosagem: d.medication!.dosagem,
      horario: DateTime.fromSeconds(d.scheduledFor, { zone: timezone }).toFormat('HH:mm'),
      horarioISO: DateTime.fromSeconds(d.scheduledFor, { zone: 'utc' }).toISO()!,
      status: d.status,
    };
  }

  /**
   * Histórico analítico de adesão dos últimos `dias` (requisito 3 do ADR-001).
   * Inclui doses de medicamentos removidos: o soft delete existe justamente
   * para que esse histórico não desapareça.
   */
  async historico(
    userId: string,
    timezone: string,
    dias = 30,
  ): Promise<{ resumo: ResumoAdesao; doses: DoseDoDia[] }> {
    const agora = DateTime.fromSeconds(this.clock.nowSeconds(), { zone: timezone });
    const inicio = Math.floor(agora.minus({ days: dias }).startOf('day').toSeconds());
    const fim = Math.floor(agora.endOf('day').toSeconds());

    const registros = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('m.user_id = :userId', { userId })
      .andWhere('d.scheduled_for BETWEEN :inicio AND :fim', { inicio, fim })
      .andWhere('d.status != :cancelada', { cancelada: DoseStatus.CANCELED })
      .orderBy('d.scheduled_for', 'DESC')
      .getMany();

    const doses = registros.map((d) => this.paraView(d, timezone));
    const conta = (s: DoseStatus) => doses.filter((d) => d.status === s).length;
    const tomadas = conta(DoseStatus.TAKEN);
    const respondidas = tomadas + conta(DoseStatus.SKIPPED) + conta(DoseStatus.MISSED);

    return {
      resumo: {
        dias,
        total: doses.length,
        tomadas,
        puladas: conta(DoseStatus.SKIPPED),
        perdidas: conta(DoseStatus.MISSED),
        pendentes: conta(DoseStatus.PENDING),
        // Adesão só faz sentido sobre doses cujo horário já passou.
        adesao: respondidas === 0 ? null : Math.round((tomadas / respondidas) * 100),
      },
      doses,
    };
  }

  /**
   * Registra a adesão de uma dose pendente.
   *
   * É idempotente para o mesmo status — o usuário pode tocar duas vezes na ação
   * da notificação, e o segundo toque não deve virar erro.
   */
  async registrar(
    userId: string,
    doseId: string,
    status: StatusRegistravel,
  ): Promise<DoseLog> {
    const dose = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('d.id = :doseId', { doseId })
      .andWhere('m.user_id = :userId', { userId })
      .getOne();

    if (!dose) throw new NotFoundException('Dose não encontrada');
    if (dose.status === status) return dose;
    if (TERMINAL_STATUSES.includes(dose.status)) {
      throw new ConflictException(
        `Esta dose já foi registrada como ${dose.status}`,
      );
    }

    dose.status = status;
    dose.respondedAt = this.clock.nowSeconds();
    return this.doses.save(dose);
  }
}
