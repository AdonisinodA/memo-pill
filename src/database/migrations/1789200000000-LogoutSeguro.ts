import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Revogação de sessão (ADR-001 §2.4).
 *
 * O refresh token é um JWT de 30 dias: assinado, vale por si só, e apagar o
 * cookie não o desfaz. Estas duas estruturas dão a ele um fim antecipado —
 * `revoked_tokens` para um aparelho, `sessions_version` para todos.
 */
export class LogoutSeguro1789200000000 implements MigrationInterface {
  name = 'LogoutSeguro1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "revoked_tokens" ("id" varchar PRIMARY KEY NOT NULL, "jti" varchar NOT NULL, "user_id" varchar NOT NULL, "expires_at" integer NOT NULL, "revoked_at" integer NOT NULL, CONSTRAINT "UQ_revoked_tokens_jti" UNIQUE ("jti"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_revoked_tokens_expires" ON "revoked_tokens" ("expires_at")`,
    );
    // 0 como padrão: o token emitido antes desta versão não carrega a geração,
    // é lido como 0 e continua valendo — a migration não desloga ninguém.
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "sessions_version" integer NOT NULL DEFAULT (0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "sessions_version"`);
    await queryRunner.query(`DROP INDEX "idx_revoked_tokens_expires"`);
    await queryRunner.query(`DROP TABLE "revoked_tokens"`);
  }
}
