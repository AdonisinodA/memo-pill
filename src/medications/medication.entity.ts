import {
  Column, CreateDateColumn, Entity, Index, JoinColumn,
  ManyToOne, PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('medications')
@Index(['userId', 'deletedAt'])
export class Medication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column()
  name!: string;

  @Column()
  dosage!: string;

  /** Horários locais no formato "HH:mm", ex.: ["08:00","20:00"]. */
  @Column({ name: 'times', type: 'simple-json' })
  times!: string[];

  /** Data local de início, "YYYY-MM-DD". */
  @Column({ name: 'starts_on' })
  startsOn!: string;

  /** Data local de término, "YYYY-MM-DD". Nulo = uso contínuo. */
  @Column({ name: 'ends_on', type: 'text', nullable: true })
  endsOn!: string | null;

  /**
   * Soft delete (ADR-001 §2.2): preserva o histórico analítico de doses já
   * tomadas. Unix seconds UTC.
   */
  @Column({ name: 'deleted_at', type: 'integer', nullable: true })
  deletedAt!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
