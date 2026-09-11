import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Refresh token invalidado antes de expirar (logout deste aparelho).
 *
 * O refresh token é um JWT de 30 dias: assinado, ele vale por si só, e apagar o
 * cookie no navegador não o desfaz. Quem tiver uma cópia — backup de perfil,
 * aparelho compartilhado, malware — continuaria entrando por um mês depois do
 * "Sair". Esta tabela é o que dá a um token sem estado um fim antecipado.
 */
@Entity('revoked_tokens')
// Varredura por vencimento na limpeza diária.
@Index('idx_revoked_tokens_expires', ['expiresAt'])
export class RevokedToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `jti` do token revogado — o identificador único de cada emissão. */
  @Column({ unique: true })
  jti!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  /**
   * `exp` do próprio token. Passado esse instante o JWT já não é aceito pela
   * verificação de assinatura, e a linha aqui deixa de ter função: é o que
   * permite a tabela não crescer para sempre.
   */
  @Column({ name: 'expires_at', type: 'integer' })
  expiresAt!: number;

  @Column({ name: 'revoked_at', type: 'integer' })
  revokedAt!: number;
}
