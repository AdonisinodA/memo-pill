import { MigrationInterface, QueryRunner } from "typeorm";

export class Inicial1788115296524 implements MigrationInterface {
    name = 'Inicial1788115296524'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "password_hash" varchar NOT NULL, "nome" varchar NOT NULL, "timezone" varchar NOT NULL DEFAULT ('America/Sao_Paulo'), "consent_at" integer NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`CREATE TABLE "medications" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "nome" varchar NOT NULL, "dosagem" varchar NOT NULL, "horarios" text NOT NULL, "inicio_em" varchar NOT NULL, "fim_em" text, "deleted_at" integer, "created_at" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7d2b0a3593514c787bed9715d5" ON "medications" ("user_id", "deleted_at") `);
        await queryRunner.query(`CREATE TABLE "dose_logs" ("id" varchar PRIMARY KEY NOT NULL, "medication_id" varchar NOT NULL, "scheduled_for" integer NOT NULL, "status" text NOT NULL DEFAULT ('PENDING'), "notified_at" integer, "responded_at" integer)`);
        await queryRunner.query(`CREATE INDEX "IDX_5d6d5860e5e358914ad7aa4154" ON "dose_logs" ("medication_id") `);
        await queryRunner.query(`CREATE INDEX "idx_dose_logs_status_scheduled" ON "dose_logs" ("status", "scheduled_for") `);
        await queryRunner.query(`CREATE TABLE "push_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "endpoint" varchar NOT NULL, "p256dh" varchar NOT NULL, "auth" varchar NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_0008bdfd174e533a3f98bf9af16" UNIQUE ("endpoint"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6771f119f1c06d2ccf38f23866" ON "push_subscriptions" ("user_id") `);
        await queryRunner.query(`DROP INDEX "IDX_7d2b0a3593514c787bed9715d5"`);
        await queryRunner.query(`CREATE TABLE "temporary_medications" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "nome" varchar NOT NULL, "dosagem" varchar NOT NULL, "horarios" text NOT NULL, "inicio_em" varchar NOT NULL, "fim_em" text, "deleted_at" integer, "created_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_3e8541ed0c975ed90ca265bb468" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
        await queryRunner.query(`INSERT INTO "temporary_medications"("id", "user_id", "nome", "dosagem", "horarios", "inicio_em", "fim_em", "deleted_at", "created_at") SELECT "id", "user_id", "nome", "dosagem", "horarios", "inicio_em", "fim_em", "deleted_at", "created_at" FROM "medications"`);
        await queryRunner.query(`DROP TABLE "medications"`);
        await queryRunner.query(`ALTER TABLE "temporary_medications" RENAME TO "medications"`);
        await queryRunner.query(`CREATE INDEX "IDX_7d2b0a3593514c787bed9715d5" ON "medications" ("user_id", "deleted_at") `);
        await queryRunner.query(`DROP INDEX "IDX_5d6d5860e5e358914ad7aa4154"`);
        await queryRunner.query(`DROP INDEX "idx_dose_logs_status_scheduled"`);
        await queryRunner.query(`CREATE TABLE "temporary_dose_logs" ("id" varchar PRIMARY KEY NOT NULL, "medication_id" varchar NOT NULL, "scheduled_for" integer NOT NULL, "status" text NOT NULL DEFAULT ('PENDING'), "notified_at" integer, "responded_at" integer, CONSTRAINT "FK_5d6d5860e5e358914ad7aa41549" FOREIGN KEY ("medication_id") REFERENCES "medications" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
        await queryRunner.query(`INSERT INTO "temporary_dose_logs"("id", "medication_id", "scheduled_for", "status", "notified_at", "responded_at") SELECT "id", "medication_id", "scheduled_for", "status", "notified_at", "responded_at" FROM "dose_logs"`);
        await queryRunner.query(`DROP TABLE "dose_logs"`);
        await queryRunner.query(`ALTER TABLE "temporary_dose_logs" RENAME TO "dose_logs"`);
        await queryRunner.query(`CREATE INDEX "IDX_5d6d5860e5e358914ad7aa4154" ON "dose_logs" ("medication_id") `);
        await queryRunner.query(`CREATE INDEX "idx_dose_logs_status_scheduled" ON "dose_logs" ("status", "scheduled_for") `);
        await queryRunner.query(`DROP INDEX "IDX_6771f119f1c06d2ccf38f23866"`);
        await queryRunner.query(`CREATE TABLE "temporary_push_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "endpoint" varchar NOT NULL, "p256dh" varchar NOT NULL, "auth" varchar NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_0008bdfd174e533a3f98bf9af16" UNIQUE ("endpoint"), CONSTRAINT "FK_6771f119f1c06d2ccf38f238664" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`);
        await queryRunner.query(`INSERT INTO "temporary_push_subscriptions"("id", "user_id", "endpoint", "p256dh", "auth", "created_at") SELECT "id", "user_id", "endpoint", "p256dh", "auth", "created_at" FROM "push_subscriptions"`);
        await queryRunner.query(`DROP TABLE "push_subscriptions"`);
        await queryRunner.query(`ALTER TABLE "temporary_push_subscriptions" RENAME TO "push_subscriptions"`);
        await queryRunner.query(`CREATE INDEX "IDX_6771f119f1c06d2ccf38f23866" ON "push_subscriptions" ("user_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_6771f119f1c06d2ccf38f23866"`);
        await queryRunner.query(`ALTER TABLE "push_subscriptions" RENAME TO "temporary_push_subscriptions"`);
        await queryRunner.query(`CREATE TABLE "push_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "endpoint" varchar NOT NULL, "p256dh" varchar NOT NULL, "auth" varchar NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_0008bdfd174e533a3f98bf9af16" UNIQUE ("endpoint"))`);
        await queryRunner.query(`INSERT INTO "push_subscriptions"("id", "user_id", "endpoint", "p256dh", "auth", "created_at") SELECT "id", "user_id", "endpoint", "p256dh", "auth", "created_at" FROM "temporary_push_subscriptions"`);
        await queryRunner.query(`DROP TABLE "temporary_push_subscriptions"`);
        await queryRunner.query(`CREATE INDEX "IDX_6771f119f1c06d2ccf38f23866" ON "push_subscriptions" ("user_id") `);
        await queryRunner.query(`DROP INDEX "idx_dose_logs_status_scheduled"`);
        await queryRunner.query(`DROP INDEX "IDX_5d6d5860e5e358914ad7aa4154"`);
        await queryRunner.query(`ALTER TABLE "dose_logs" RENAME TO "temporary_dose_logs"`);
        await queryRunner.query(`CREATE TABLE "dose_logs" ("id" varchar PRIMARY KEY NOT NULL, "medication_id" varchar NOT NULL, "scheduled_for" integer NOT NULL, "status" text NOT NULL DEFAULT ('PENDING'), "notified_at" integer, "responded_at" integer)`);
        await queryRunner.query(`INSERT INTO "dose_logs"("id", "medication_id", "scheduled_for", "status", "notified_at", "responded_at") SELECT "id", "medication_id", "scheduled_for", "status", "notified_at", "responded_at" FROM "temporary_dose_logs"`);
        await queryRunner.query(`DROP TABLE "temporary_dose_logs"`);
        await queryRunner.query(`CREATE INDEX "idx_dose_logs_status_scheduled" ON "dose_logs" ("status", "scheduled_for") `);
        await queryRunner.query(`CREATE INDEX "IDX_5d6d5860e5e358914ad7aa4154" ON "dose_logs" ("medication_id") `);
        await queryRunner.query(`DROP INDEX "IDX_7d2b0a3593514c787bed9715d5"`);
        await queryRunner.query(`ALTER TABLE "medications" RENAME TO "temporary_medications"`);
        await queryRunner.query(`CREATE TABLE "medications" ("id" varchar PRIMARY KEY NOT NULL, "user_id" varchar NOT NULL, "nome" varchar NOT NULL, "dosagem" varchar NOT NULL, "horarios" text NOT NULL, "inicio_em" varchar NOT NULL, "fim_em" text, "deleted_at" integer, "created_at" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "medications"("id", "user_id", "nome", "dosagem", "horarios", "inicio_em", "fim_em", "deleted_at", "created_at") SELECT "id", "user_id", "nome", "dosagem", "horarios", "inicio_em", "fim_em", "deleted_at", "created_at" FROM "temporary_medications"`);
        await queryRunner.query(`DROP TABLE "temporary_medications"`);
        await queryRunner.query(`CREATE INDEX "IDX_7d2b0a3593514c787bed9715d5" ON "medications" ("user_id", "deleted_at") `);
        await queryRunner.query(`DROP INDEX "IDX_6771f119f1c06d2ccf38f23866"`);
        await queryRunner.query(`DROP TABLE "push_subscriptions"`);
        await queryRunner.query(`DROP INDEX "idx_dose_logs_status_scheduled"`);
        await queryRunner.query(`DROP INDEX "IDX_5d6d5860e5e358914ad7aa4154"`);
        await queryRunner.query(`DROP TABLE "dose_logs"`);
        await queryRunner.query(`DROP INDEX "IDX_7d2b0a3593514c787bed9715d5"`);
        await queryRunner.query(`DROP TABLE "medications"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
