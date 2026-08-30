import {
  Column, CreateDateColumn, Entity, Index, JoinColumn,
  ManyToOne, PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('push_subscriptions')
@Index(['userId'])
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ unique: true })
  endpoint!: string;

  @Column({ name: 'p256dh' })
  p256dh!: string;

  @Column({ name: 'auth' })
  auth!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
