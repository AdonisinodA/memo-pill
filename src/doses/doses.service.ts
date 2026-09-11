import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DateTime } from 'luxon';
import { Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { DoseLog } from './dose-log.entity';
import { DoseStatus, STATUS_LABELS, TERMINAL_STATUSES } from './dose-status.enum';

/** Modelo de view consumido por `views/dashboard.hbs`. */
export interface DoseView {
  id: string;
  name: string;
  dosage: string;
  /** Horário local "HH:mm", já convertido do UTC para o fuso do usuário. */
  time: string;
  /** Instante em UTC, para o atributo `datetime` do elemento <time>. */
  timeISO: string;
  status: DoseStatus;
}

export interface AdherenceSummary {
  days: number;
  total: number;
  taken: number;
  skipped: number;
  missed: number;
  pending: number;
  /** Percentual de doses tomadas sobre as já respondidas; nulo se não houver. */
  adherence: number | null;
}

/** Status que o usuário pode registrar a partir de uma dose pendente. */
export type RecordableStatus = DoseStatus.TAKEN | DoseStatus.SKIPPED;

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
  async forToday(userId: string, timezone: string): Promise<DoseView[]> {
    const now = DateTime.fromSeconds(this.clock.nowSeconds(), { zone: timezone });
    const start = Math.floor(now.startOf('day').toSeconds());
    const end = Math.floor(now.endOf('day').toSeconds());

    const records = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('m.user_id = :userId', { userId })
      .andWhere('d.scheduled_for BETWEEN :start AND :end', { start, end })
      .andWhere('d.status != :canceled', { canceled: DoseStatus.CANCELED })
      .orderBy('d.scheduled_for', 'ASC')
      .getMany();

    return records.map((d) => this.toView(d, timezone));
  }

  private toView(d: DoseLog, timezone: string): DoseView {
    return {
      id: d.id,
      name: d.medication!.name,
      dosage: d.medication!.dosage,
      time: DateTime.fromSeconds(d.scheduledFor, { zone: timezone }).toFormat('HH:mm'),
      timeISO: DateTime.fromSeconds(d.scheduledFor, { zone: 'utc' }).toISO()!,
      status: d.status,
    };
  }

  /**
   * Histórico analítico de adesão dos últimos `dias` (requisito 3 do ADR-001).
   * Inclui doses de medicamentos removidos: o soft delete existe justamente
   * para que esse histórico não desapareça.
   */
  async history(
    userId: string,
    timezone: string,
    days = 30,
  ): Promise<{ summary: AdherenceSummary; doses: DoseView[] }> {
    const now = DateTime.fromSeconds(this.clock.nowSeconds(), { zone: timezone });
    const start = Math.floor(now.minus({ days: days }).startOf('day').toSeconds());
    const end = Math.floor(now.endOf('day').toSeconds());

    const records = await this.doses
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.medication', 'm')
      .where('m.user_id = :userId', { userId })
      .andWhere('d.scheduled_for BETWEEN :start AND :end', { start, end })
      .andWhere('d.status != :canceled', { canceled: DoseStatus.CANCELED })
      .orderBy('d.scheduled_for', 'DESC')
      .getMany();

    const doses = records.map((d) => this.toView(d, timezone));
    const count = (s: DoseStatus) => doses.filter((d) => d.status === s).length;
    const taken = count(DoseStatus.TAKEN);
    const answered = taken + count(DoseStatus.SKIPPED) + count(DoseStatus.MISSED);

    return {
      summary: {
        days,
        total: doses.length,
        taken,
        skipped: count(DoseStatus.SKIPPED),
        missed: count(DoseStatus.MISSED),
        pending: count(DoseStatus.PENDING),
        // Adesão só faz sentido sobre doses cujo horário já passou.
        adherence: answered === 0 ? null : Math.round((taken / answered) * 100),
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
  async record(
    userId: string,
    doseId: string,
    status: RecordableStatus,
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
        `Esta dose já foi ${STATUS_LABELS[dose.status]} e não pode mais ser alterada.`,
      );
    }

    dose.status = status;
    dose.respondedAt = this.clock.nowSeconds();
    return this.doses.save(dose);
  }
}
