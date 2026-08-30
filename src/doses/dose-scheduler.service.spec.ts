import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { MedicationsService } from '../medications/medications.service';
import { PushService } from '../push/push.service';
import { createTestDataSource } from '../../test/helpers/db';
import { createMedication, createUser, sec } from '../../test/helpers/fixtures';
import { DoseLog } from './dose-log.entity';
import { DoseStatus } from './dose-status.enum';
import { DoseSchedulerService, TOLERANCE_WINDOW_SEC } from './dose-scheduler.service';

const NOW = sec('2026-08-30T12:00:00Z');
const MIN = 60;

describe('DoseSchedulerService', () => {
  let ds: DataSource;
  let scheduler: DoseSchedulerService;
  let clock: FixedClock;
  let push: { notifyDose: jest.Mock };
  let medications: { extendHorizon: jest.Mock };
  let medicationId: string;
  let userId: string;

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

  const reload = (id: string) =>
    ds.getRepository(DoseLog).findOneByOrFail({ id });

  beforeEach(async () => {
    ds = await createTestDataSource();
    clock = new FixedClock(NOW);
    push = { notifyDose: jest.fn().mockResolvedValue({ delivered: 1, removed: 0, failed: 0 }) };
    medications = { extendHorizon: jest.fn().mockResolvedValue(7) };

    const mod = await Test.createTestingModule({
      providers: [
        DoseSchedulerService,
        { provide: Clock, useValue: clock },
        { provide: PushService, useValue: push },
        { provide: MedicationsService, useValue: medications },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();

    scheduler = mod.get(DoseSchedulerService);
    const user = await createUser(ds);
    userId = user.id;
    medicationId = (await createMedication(ds, userId)).id;
  });

  afterEach(() => ds.destroy());

  describe('dispararPendentes', () => {
    it('notifica dose cujo horário chegou', async () => {
      const dose = await createDose(NOW);
      expect(await scheduler.dispatchDue()).toBe(1);
      expect(push.notifyDose).toHaveBeenCalledWith(userId, dose.id);
    });

    it('marca a entrega em notified_at sem alterar o status de adesão', async () => {
      const dose = await createDose(NOW - MIN);
      await scheduler.dispatchDue();

      const after = await reload(dose.id);
      expect(after.notifiedAt).toBe(NOW);
      expect(after.status).toBe(DoseStatus.PENDING);
    });

    it('NÃO renotifica a mesma dose no minuto seguinte', async () => {
      await createDose(NOW);
      await scheduler.dispatchDue();

      clock.advance(MIN);
      expect(await scheduler.dispatchDue()).toBe(0);
      expect(push.notifyDose).toHaveBeenCalledTimes(1);
    });

    it('não notifica dose futura', async () => {
      await createDose(NOW + 5 * MIN);
      expect(await scheduler.dispatchDue()).toBe(0);
    });

    it('não notifica dose já respondida', async () => {
      await createDose(NOW, { status: DoseStatus.TAKEN });
      await createDose(NOW, { status: DoseStatus.SKIPPED });
      await createDose(NOW, { status: DoseStatus.CANCELED });
      expect(await scheduler.dispatchDue()).toBe(0);
    });

    it('não notifica dose fora da janela de tolerância', async () => {
      await createDose(NOW - TOLERANCE_WINDOW_SEC - 1);
      expect(await scheduler.dispatchDue()).toBe(0);
    });

    it('notifica dose no limite exato da tolerância', async () => {
      await createDose(NOW - TOLERANCE_WINDOW_SEC);
      expect(await scheduler.dispatchDue()).toBe(1);
    });

    it('dispara em ordem cronológica', async () => {
      const late = await createDose(NOW - 2 * MIN);
      const early = await createDose(NOW - 20 * MIN);
      await scheduler.dispatchDue();

      expect(push.notifyDose.mock.calls.map((c) => c[1])).toEqual([
        early.id,
        late.id,
      ]);
    });

    it('entrega uma única notificação sob execução concorrente (claim atômico)', async () => {
      await createDose(NOW);
      const [a, b] = await Promise.all([
        scheduler.dispatchDue(),
        scheduler.dispatchDue(),
      ]);
      expect(a + b).toBe(1);
      expect(push.notifyDose).toHaveBeenCalledTimes(1);
    });
  });

  describe('marcarPerdidas', () => {
    it('marca como MISSED a dose que passou da tolerância sem resposta', async () => {
      const dose = await createDose(NOW - TOLERANCE_WINDOW_SEC - 1);
      expect(await scheduler.markMissed()).toBe(1);
      expect((await reload(dose.id)).status).toBe(DoseStatus.MISSED);
    });

    it('marca como MISSED mesmo a dose que chegou a ser notificada', async () => {
      const dose = await createDose(NOW - 2 * TOLERANCE_WINDOW_SEC, {
        notifiedAt: NOW - 2 * TOLERANCE_WINDOW_SEC,
      });
      await scheduler.markMissed();
      expect((await reload(dose.id)).status).toBe(DoseStatus.MISSED);
    });

    it('não mexe em dose dentro da janela', async () => {
      const dose = await createDose(NOW - MIN);
      expect(await scheduler.markMissed()).toBe(0);
      expect((await reload(dose.id)).status).toBe(DoseStatus.PENDING);
    });

    it('não reabre dose já respondida', async () => {
      const dose = await createDose(NOW - 10 * TOLERANCE_WINDOW_SEC, {
        status: DoseStatus.TAKEN,
      });
      await scheduler.markMissed();
      expect((await reload(dose.id)).status).toBe(DoseStatus.TAKEN);
    });
  });

  describe('recuperação após indisponibilidade (ADR-001 §2.3)', () => {
    it('não dispara avalanche: notifica só o que está na janela e perde o resto', async () => {
      // Seis horas de queda, uma dose a cada hora.
      const overdue = [];
      for (let h = 6; h >= 1; h--) overdue.push(await createDose(NOW - h * 3600));
      const recent = await createDose(NOW - 10 * MIN);

      await scheduler.tick();

      expect(push.notifyDose).toHaveBeenCalledTimes(1);
      expect(push.notifyDose).toHaveBeenCalledWith(userId, recent.id);
      for (const dose of overdue) {
        expect((await reload(dose.id)).status).toBe(DoseStatus.MISSED);
      }
    });
  });

  describe('estenderHorizonte', () => {
    it('delega ao serviço de medicamentos', async () => {
      await scheduler.extendHorizon();
      expect(medications.extendHorizon).toHaveBeenCalledTimes(1);
    });
  });
});
