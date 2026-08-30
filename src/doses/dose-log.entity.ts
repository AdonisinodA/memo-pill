import {
  Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn,
} from 'typeorm';
import { Medication } from '../medications/medication.entity';
import { DoseStatus } from './dose-status.enum';

/**
 * Dose pré-gerada (ADR-001 §2.2). O horizonte de geração é
 * min(fim do tratamento, hoje + 90 dias).
 */
@Entity('dose_logs')
// Coluna de IGUALDADE antes da coluna de FAIXA: permite seek direto no
// conjunto PENDING seguido de varredura ordenada (ADR-001 §2.3).
@Index('idx_dose_logs_status_scheduled', ['status', 'scheduledFor'])
@Index(['medicationId'])
export class DoseLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'medication_id' })
  medicationId!: string;

  @ManyToOne(() => Medication, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'medication_id' })
  medication?: Medication;

  /** Instante do disparo em UTC (unix seconds). */
  @Column({ name: 'scheduled_for', type: 'integer' })
  scheduledFor!: number;

  /** Estado de ADESÃO. Ver DoseStatus. */
  @Column({ type: 'text', default: DoseStatus.PENDING })
  status!: DoseStatus;

  /**
   * Estado de ENTREGA: instante em que a notificação foi despachada.
   * Nulo = ainda não notificada. Serve de claim atômico contra disparo
   * duplicado (ADR-001 §2.3).
   */
  @Column({ name: 'notified_at', type: 'integer', nullable: true })
  notifiedAt!: number | null;

  /** Instante da resposta do usuário, em UTC. */
  @Column({ name: 'responded_at', type: 'integer', nullable: true })
  respondedAt!: number | null;
}
