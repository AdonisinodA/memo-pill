import { DataSource } from 'typeorm';
import { User } from '../../src/users/user.entity';
import { Medication } from '../../src/medications/medication.entity';
import { DoseLog } from '../../src/doses/dose-log.entity';
import { PushSubscription } from '../../src/push/push-subscription.entity';
import { aplicarPragmas } from '../../src/database/sqlite-options';

export const ENTITIES = [User, Medication, DoseLog, PushSubscription];

/**
 * DataSource SQLite em memória com o mesmo schema e os mesmos PRAGMAs da
 * produção, para que os testes exerçam FK, índices e soft delete de verdade.
 */
export async function criarDataSourceDeTeste(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: ENTITIES,
    synchronize: true,
    dropSchema: true,
    prepareDatabase: (db) => aplicarPragmas(db),
  });
  await ds.initialize();
  return ds;
}
