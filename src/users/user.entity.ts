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

  /**
   * Geração das sessões válidas (ADR-001 §2.4). Todo refresh token carrega a
   * versão vigente na emissão; "Sair de todos os aparelhos" incrementa este
   * número e, com isso, recusa de uma vez todos os tokens já emitidos.
   *
   * Contador, e não instante de corte: com timestamp, o token emitido no mesmo
   * segundo do logout escaparia — e o login logo em seguida cairia no próprio
   * corte que acabou de ser criado. O contador não tem granularidade para
   * errar.
   *
   * Cobre o caso que a revogação por `jti` não cobre: a conta comprometida, em
   * que o dono não conhece o token do atacante para revogá-lo individualmente.
   */
  @Column({ name: 'sessions_version', type: 'integer', default: 0 })
  sessionsVersion!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
