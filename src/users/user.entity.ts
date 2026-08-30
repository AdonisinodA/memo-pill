import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  /** Hash bcrypt (ADR-001 §2.4). A senha em claro nunca é persistida. */
  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column()
  name!: string;

  /**
   * Fuso IANA do usuário (ADR-001 §2.2). Usado apenas para converter o horário
   * informado no cadastro para UTC e para reexibir. Toda persistência é em UTC.
   */
  @Column({ default: 'America/Sao_Paulo' })
  timezone!: string;

  /**
   * Consentimento específico e destacado para tratamento de dado sensível
   * de saúde (LGPD, Art. 11, I — ADR-001 §2.4). Unix seconds UTC.
   */
  @Column({ name: 'consent_at', type: 'integer' })
  consentAt!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
