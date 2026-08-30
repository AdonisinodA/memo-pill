import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { DoseLog } from '../doses/dose-log.entity';
import { Medication } from '../medications/medication.entity';
import { PushSubscription } from '../push/push-subscription.entity';
import { User } from '../users/user.entity';
import { applyPragmas } from './sqlite-options';

/**
 * DataSource usado apenas pela CLI do TypeORM (gerar e rodar migrations).
 * A aplicação monta sua própria conexão em `app.module.ts`.
 */
export default new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_PATH ?? 'data/app.db',
  entities: [User, Medication, DoseLog, PushSubscription],
  migrations: ['src/database/migrations/*.ts'],
  prepareDatabase: applyPragmas,
});
