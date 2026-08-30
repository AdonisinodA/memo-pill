import { DataSource } from 'typeorm';
import { DateTime } from 'luxon';
import { User } from '../../src/users/user.entity';
import { Medication } from '../../src/medications/medication.entity';

export const SP = 'America/Sao_Paulo';

export const seg = (iso: string, zone = 'utc') =>
  Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());

export async function criarUsuario(
  ds: DataSource,
  over: Partial<User> = {},
): Promise<User> {
  return ds.getRepository(User).save(
    ds.getRepository(User).create({
      email: `user-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: 'hash-fake',
      nome: 'Adonis',
      timezone: SP,
      consentAt: seg('2026-08-01T00:00:00Z'),
      ...over,
    }),
  );
}

export async function criarMedicamento(
  ds: DataSource,
  userId: string,
  over: Partial<Medication> = {},
): Promise<Medication> {
  return ds.getRepository(Medication).save(
    ds.getRepository(Medication).create({
      userId,
      nome: 'Losartana',
      dosagem: '50 mg',
      horarios: ['08:00', '20:00'],
      inicioEm: '2026-08-30',
      fimEm: null,
      deletedAt: null,
      ...over,
    }),
  );
}
