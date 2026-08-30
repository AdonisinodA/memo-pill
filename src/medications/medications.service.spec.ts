import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { DoseLog } from '../doses/dose-log.entity';
import { DoseStatus } from '../doses/dose-status.enum';
import { HORIZON_DAYS } from '../doses/dose-schedule';
import { createTestDataSource } from '../../test/helpers/db';
import { SP, createUser, sec } from '../../test/helpers/fixtures';
import { Medication } from './medication.entity';
import { MedicationsService } from './medications.service';

const NOW = sec('2026-08-30T09:00:00Z'); // 06:00 em São Paulo
const DIA = 86_400;

describe('MedicationsService', () => {
  let ds: DataSource;
  let service: MedicationsService;
  let clock: FixedClock;
  let userId: string;

  const dosesOf = (medicationId: string) =>
    ds.getRepository(DoseLog).find({
      where: { medicationId },
      order: { scheduledFor: 'ASC' },
    });

  beforeEach(async () => {
    ds = await createTestDataSource();
    clock = new FixedClock(NOW);

    const mod = await Test.createTestingModule({
      providers: [
        MedicationsService,
        { provide: Clock, useValue: clock },
        { provide: getDataSourceToken(), useValue: ds },
        { provide: getRepositoryToken(Medication), useValue: ds.getRepository(Medication) },
      ],
    }).compile();

    service = mod.get(MedicationsService);
    userId = (await createUser(ds)).id;
  });

  afterEach(() => ds.destroy());

  const create = (over = {}) =>
    service.create(userId, SP, {
      name: 'Losartana',
      dosage: '50 mg',
      times: ['08:00', '20:00'],
      startsOn: '2026-08-30',
      endsOn: null,
      ...over,
    });

  describe('criar', () => {
    it('materializa as doses do horizonte de 90 dias', async () => {
      const medication = await create();
      expect(await dosesOf(medication.id)).toHaveLength(HORIZON_DAYS * 2);
    });

    it('materializa o tratamento inteiro quando ele cabe no horizonte', async () => {
      const medication = await create({ endsOn: '2026-09-05' });
      expect(await dosesOf(medication.id)).toHaveLength(14);
    });

    it('grava os instantes em UTC, convertidos do fuso do usuário', async () => {
      const medication = await create({ times: ['08:00'] });
      const [primeira] = await dosesOf(medication.id);
      expect(primeira.scheduledFor).toBe(sec('2026-08-30T11:00:00Z'));
    });

    it('cria toda dose com status PENDING e sem marca de entrega', async () => {
      const medication = await create({ endsOn: '2026-08-31' });
      const doses = await dosesOf(medication.id);
      expect(doses.every((d) => d.status === DoseStatus.PENDING)).toBe(true);
      expect(doses.every((d) => d.notifiedAt === null)).toBe(true);
    });

    it('não materializa doses já passadas no dia do cadastro', async () => {
      clock.set(sec('2026-08-30T15:00:00Z')); // 12:00 em SP, depois da dose das 08:00
      const medication = await create({ times: ['08:00', '20:00'], endsOn: '2026-08-30' });
      const doses = await dosesOf(medication.id);
      expect(doses).toHaveLength(1);
      expect(doses[0].scheduledFor).toBe(sec('2026-08-30T23:00:00Z'));
    });
  });

  describe('remover (soft delete)', () => {
    it('não apaga fisicamente o medicamento', async () => {
      const medication = await create();
      await service.remove(userId, medication.id);
      const stored = await ds.getRepository(Medication).findOneBy({ id: medication.id });
      expect(stored).not.toBeNull();
      expect(stored!.deletedAt).toBe(NOW);
    });

    it('preserva o histórico de doses já respondidas', async () => {
      const medication = await create({ endsOn: '2026-09-05' });
      const doses = await dosesOf(medication.id);
      await ds.getRepository(DoseLog).update(doses[0].id, {
        status: DoseStatus.TAKEN,
        respondedAt: NOW,
      });

      await service.remove(userId, medication.id);

      const after = await ds.getRepository(DoseLog).findOneBy({ id: doses[0].id });
      expect(after!.status).toBe(DoseStatus.TAKEN);
    });

    it('cancela apenas as doses futuras ainda pendentes', async () => {
      clock.set(sec('2026-09-01T15:00:00Z'));
      const medication = await create({ startsOn: '2026-08-30', endsOn: '2026-09-05' });
      const before = await dosesOf(medication.id);
      const past = before.filter((d) => d.scheduledFor <= clock.nowSeconds()).length;

      await service.remove(userId, medication.id);

      const after = await dosesOf(medication.id);
      const canceled = after.filter((d) => d.status === DoseStatus.CANCELED);
      const pending = after.filter((d) => d.status === DoseStatus.PENDING);
      expect(canceled).toHaveLength(after.length - past);
      expect(pending).toHaveLength(past);
    });

    it('some da listagem depois de removido', async () => {
      const medication = await create();
      await service.remove(userId, medication.id);
      expect(await service.list(userId)).toHaveLength(0);
    });

    it('recusa remover medicamento de outro usuário', async () => {
      const other = await createUser(ds);
      const medication = await create();
      await expect(service.remove(other.id, medication.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('atualizar', () => {
    it('cancela as doses futuras obsoletas e regera pela nova posologia', async () => {
      const medication = await create({ times: ['08:00'], endsOn: '2026-09-05' });
      expect(await dosesOf(medication.id)).toHaveLength(7);

      await service.update(userId, SP, medication.id, {
        name: 'Losartana',
        dosage: '50 mg',
        times: ['08:00', '14:00', '20:00'],
        startsOn: '2026-08-30',
        endsOn: '2026-09-05',
      });

      const doses = await dosesOf(medication.id);
      const canceled = doses.filter((d) => d.status === DoseStatus.CANCELED);
      const pending = doses.filter((d) => d.status === DoseStatus.PENDING);
      expect(canceled).toHaveLength(7);
      expect(pending).toHaveLength(21);
    });

    it('não deixa dose órfã da posologia antiga em estado pendente', async () => {
      const medication = await create({ times: ['08:00'], endsOn: '2026-09-05' });
      await service.update(userId, SP, medication.id, {
        name: 'Losartana',
        dosage: '50 mg',
        times: ['21:00'],
        startsOn: '2026-08-30',
        endsOn: '2026-09-05',
      });

      const pending = (await dosesOf(medication.id)).filter(
        (d) => d.status === DoseStatus.PENDING,
      );
      const hours = new Set(
        pending.map((d) => (d.scheduledFor % DIA) / 3600),
      );
      expect(hours).toEqual(new Set([0])); // 21:00 em SP = 00:00 UTC
    });
  });

  describe('estenderHorizonte', () => {
    it('é idempotente: nada a criar quando o horizonte já está cheio', async () => {
      await create();
      expect(await service.extendHorizon()).toBe(0);
    });

    it('empurra o horizonte adiante conforme o tempo passa', async () => {
      const medication = await create();
      const before = (await dosesOf(medication.id)).length;

      clock.advance(10 * DIA);
      const created = await service.extendHorizon();

      expect(created).toBe(20); // 10 dias × 2 doses
      expect(await dosesOf(medication.id)).toHaveLength(before + 20);
    });

    it('não estende tratamento com fim definido já materializado', async () => {
      await create({ endsOn: '2026-09-05' });
      clock.advance(10 * DIA);
      expect(await service.extendHorizon()).toBe(0);
    });

    it('ignora medicamentos removidos', async () => {
      const medication = await create();
      await service.remove(userId, medication.id);
      clock.advance(10 * DIA);
      expect(await service.extendHorizon()).toBe(0);
    });

    it('não duplica doses no instante de fronteira', async () => {
      const medication = await create();
      clock.advance(DIA);
      await service.extendHorizon();
      await service.extendHorizon();

      const doses = await dosesOf(medication.id);
      expect(new Set(doses.map((d) => d.scheduledFor)).size).toBe(doses.length);
    });
  });
});
