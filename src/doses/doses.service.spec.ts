import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { createTestDataSource } from '../../test/helpers/db';
import { SP, createMedication, createUser, sec } from '../../test/helpers/fixtures';
import { Medication } from '../medications/medication.entity';
import { DoseLog } from './dose-log.entity';
import { DoseStatus } from './dose-status.enum';
import { DosesService } from './doses.service';

const NOW = sec('2026-08-30T15:00:00Z'); // 12:00 em São Paulo

describe('DosesService', () => {
  let ds: DataSource;
  let service: DosesService;
  let clock: FixedClock;
  let userId: string;
  let medicationId: string;

  const createDose = (scheduledFor: number, over: Partial<DoseLog> = {}) =>
    ds.getRepository(DoseLog).save(
      ds.getRepository(DoseLog).create({
        medicationId,
        scheduledFor,
        status: DoseStatus.PENDING,
        notifiedAt: null,
        respondedAt: null,
        ...over,
      }),
    );

  beforeEach(async () => {
    ds = await createTestDataSource();
    clock = new FixedClock(NOW);

    const mod = await Test.createTestingModule({
      providers: [
        DosesService,
        { provide: Clock, useValue: clock },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();

    service = mod.get(DosesService);
    userId = (await createUser(ds)).id;
    medicationId = (await createMedication(ds, userId, {
      name: 'Losartana',
      dosage: '50 mg',
    })).id;
  });

  afterEach(() => ds.destroy());

  describe('doDia', () => {
    it('entrega o modelo que a dashboard.hbs consome', async () => {
      await createDose(sec('2026-08-30T11:00:00Z'));
      const [dose] = await service.forToday(userId, SP);

      expect(dose).toEqual({
        id: expect.any(String),
        name: 'Losartana',
        dosage: '50 mg',
        time: '08:00', // 11:00 UTC exibido no fuso de São Paulo
        timeISO: '2026-08-30T11:00:00.000Z',
        status: DoseStatus.PENDING,
      });
    });

    it('recorta o dia pelo fuso do usuário, não pelo UTC', async () => {
      // 02:00 UTC do dia 31 ainda é 23:00 do dia 30 em São Paulo.
      await createDose(sec('2026-08-31T02:00:00Z'));
      // 02:00 UTC do dia 30 é 23:00 do dia 29 em São Paulo — fora.
      await createDose(sec('2026-08-30T02:00:00Z'));

      const doses = await service.forToday(userId, SP);
      expect(doses).toHaveLength(1);
      expect(doses[0].time).toBe('23:00');
    });

    it('ordena por horário crescente', async () => {
      await createDose(sec('2026-08-30T23:00:00Z'));
      await createDose(sec('2026-08-30T11:00:00Z'));
      expect((await service.forToday(userId, SP)).map((d) => d.time)).toEqual([
        '08:00',
        '20:00',
      ]);
    });

    it('omite doses canceladas, que não representam adesão', async () => {
      await createDose(sec('2026-08-30T11:00:00Z'), { status: DoseStatus.CANCELED });
      expect(await service.forToday(userId, SP)).toHaveLength(0);
    });

    it('inclui os demais status para a tela refletir o dia inteiro', async () => {
      await createDose(sec('2026-08-30T10:00:00Z'), { status: DoseStatus.TAKEN });
      await createDose(sec('2026-08-30T11:00:00Z'), { status: DoseStatus.MISSED });
      await createDose(sec('2026-08-30T12:00:00Z'), { status: DoseStatus.SKIPPED });
      expect(await service.forToday(userId, SP)).toHaveLength(3);
    });

    it('não vaza dose de outro usuário', async () => {
      const other = await createUser(ds);
      const medOutro = await createMedication(ds, other.id);
      await ds.getRepository(DoseLog).save(
        ds.getRepository(DoseLog).create({
          medicationId: medOutro.id,
          scheduledFor: sec('2026-08-30T11:00:00Z'),
          status: DoseStatus.PENDING,
          notifiedAt: null,
          respondedAt: null,
        }),
      );
      expect(await service.forToday(userId, SP)).toHaveLength(0);
    });
  });

  describe('registrar', () => {
    it('transiciona PENDING para TAKEN e carimba a resposta', async () => {
      const dose = await createDose(NOW);
      const stored = await service.record(userId, dose.id, DoseStatus.TAKEN);
      expect(stored.status).toBe(DoseStatus.TAKEN);
      expect(stored.respondedAt).toBe(NOW);
    });

    it('transiciona PENDING para SKIPPED', async () => {
      const dose = await createDose(NOW);
      const stored = await service.record(userId, dose.id, DoseStatus.SKIPPED);
      expect(stored.status).toBe(DoseStatus.SKIPPED);
    });

    it('é idempotente: o segundo toque na notificação não vira erro', async () => {
      const dose = await createDose(NOW);
      await service.record(userId, dose.id, DoseStatus.TAKEN);
      await expect(
        service.record(userId, dose.id, DoseStatus.TAKEN),
      ).resolves.toMatchObject({ status: DoseStatus.TAKEN });
    });

    it('recusa mudar uma dose já registrada com outro status', async () => {
      const dose = await createDose(NOW);
      await service.record(userId, dose.id, DoseStatus.TAKEN);
      await expect(
        service.record(userId, dose.id, DoseStatus.SKIPPED),
      ).rejects.toThrow(ConflictException);
    });

    it('recusa registrar dose já perdida — MISSED é terminal', async () => {
      const dose = await createDose(NOW - 7200, { status: DoseStatus.MISSED });
      await expect(
        service.record(userId, dose.id, DoseStatus.TAKEN),
      ).rejects.toThrow(ConflictException);
    });

    it('recusa registrar dose de outro usuário', async () => {
      const other = await createUser(ds);
      const dose = await createDose(NOW);
      await expect(
        service.record(other.id, dose.id, DoseStatus.TAKEN),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('DosesService.historico', () => {
  let ds: DataSource;
  let service: DosesService;
  let userId: string;
  let medicationId: string;

  const createDose = (scheduledFor: number, status: DoseStatus) =>
    ds.getRepository(DoseLog).save(
      ds.getRepository(DoseLog).create({
        medicationId, scheduledFor, status, notifiedAt: null, respondedAt: null,
      }),
    );

  beforeEach(async () => {
    ds = await createTestDataSource();
    const mod = await Test.createTestingModule({
      providers: [
        DosesService,
        { provide: Clock, useValue: new FixedClock(NOW) },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();
    service = mod.get(DosesService);
    userId = (await createUser(ds)).id;
    medicationId = (await createMedication(ds, userId)).id;
  });

  afterEach(() => ds.destroy());

  it('calcula adesão sobre as doses já respondidas', async () => {
    const yesterday = NOW - 86_400;
    await createDose(yesterday, DoseStatus.TAKEN);
    await createDose(yesterday + 60, DoseStatus.TAKEN);
    await createDose(yesterday + 120, DoseStatus.TAKEN);
    await createDose(yesterday + 180, DoseStatus.MISSED);

    const { summary } = await service.history(userId, SP);
    expect(summary).toMatchObject({ taken: 3, missed: 1, adherence: 75 });
  });

  it('não conta doses ainda pendentes no denominador da adesão', async () => {
    await createDose(NOW - 86_400, DoseStatus.TAKEN);
    await createDose(NOW + 3600, DoseStatus.PENDING); // ainda hoje, sem resposta

    const { summary } = await service.history(userId, SP);
    expect(summary).toMatchObject({ pending: 1, adherence: 100 });
  });

  it('devolve adesão nula quando nada foi respondido ainda', async () => {
    await createDose(NOW + 3600, DoseStatus.PENDING);
    const { summary } = await service.history(userId, SP);
    expect(summary.adherence).toBeNull();
  });

  it('preserva o histórico de medicamento removido (soft delete)', async () => {
    await createDose(NOW - 86_400, DoseStatus.TAKEN);
    await ds.getRepository(Medication).update(medicationId, { deletedAt: NOW });

    const { summary, doses } = await service.history(userId, SP);
    expect(doses).toHaveLength(1);
    expect(summary.taken).toBe(1);
  });

  it('ordena do mais recente para o mais antigo', async () => {
    await createDose(NOW - 3 * 86_400, DoseStatus.TAKEN);
    await createDose(NOW - 86_400, DoseStatus.TAKEN);
    const { doses } = await service.history(userId, SP);
    expect(doses[0].timeISO > doses[1].timeISO).toBe(true);
  });

  it('ignora doses fora da janela de dias pedida', async () => {
    await createDose(NOW - 40 * 86_400, DoseStatus.TAKEN);
    const { summary } = await service.history(userId, SP, 30);
    expect(summary.total).toBe(0);
  });
});
