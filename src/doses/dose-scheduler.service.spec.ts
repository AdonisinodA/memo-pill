import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { MedicationsService } from '../medications/medications.service';
import { PushService } from '../push/push.service';
import { criarDataSourceDeTeste } from '../../test/helpers/db';
import { criarMedicamento, criarUsuario, seg } from '../../test/helpers/fixtures';
import { DoseLog } from './dose-log.entity';
import { DoseStatus } from './dose-status.enum';
import { DoseSchedulerService, JANELA_TOLERANCIA_SEG } from './dose-scheduler.service';

const AGORA = seg('2026-08-30T12:00:00Z');
const MIN = 60;

describe('DoseSchedulerService', () => {
  let ds: DataSource;
  let scheduler: DoseSchedulerService;
  let clock: FixedClock;
  let push: { notificarDose: jest.Mock };
  let medicamentos: { estenderHorizonte: jest.Mock };
  let medicationId: string;
  let userId: string;

  const criarDose = (scheduledFor: number, over: Partial<DoseLog> = {}) =>
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

  const recarregar = (id: string) =>
    ds.getRepository(DoseLog).findOneByOrFail({ id });

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    clock = new FixedClock(AGORA);
    push = { notificarDose: jest.fn().mockResolvedValue({ entregues: 1, removidas: 0, falhas: 0 }) };
    medicamentos = { estenderHorizonte: jest.fn().mockResolvedValue(7) };

    const mod = await Test.createTestingModule({
      providers: [
        DoseSchedulerService,
        { provide: Clock, useValue: clock },
        { provide: PushService, useValue: push },
        { provide: MedicationsService, useValue: medicamentos },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();

    scheduler = mod.get(DoseSchedulerService);
    const user = await criarUsuario(ds);
    userId = user.id;
    medicationId = (await criarMedicamento(ds, userId)).id;
  });

  afterEach(() => ds.destroy());

  describe('dispararPendentes', () => {
    it('notifica dose cujo horário chegou', async () => {
      const dose = await criarDose(AGORA);
      expect(await scheduler.dispararPendentes()).toBe(1);
      expect(push.notificarDose).toHaveBeenCalledWith(userId, dose.id);
    });

    it('marca a entrega em notified_at sem alterar o status de adesão', async () => {
      const dose = await criarDose(AGORA - MIN);
      await scheduler.dispararPendentes();

      const depois = await recarregar(dose.id);
      expect(depois.notifiedAt).toBe(AGORA);
      expect(depois.status).toBe(DoseStatus.PENDING);
    });

    it('NÃO renotifica a mesma dose no minuto seguinte', async () => {
      await criarDose(AGORA);
      await scheduler.dispararPendentes();

      clock.advance(MIN);
      expect(await scheduler.dispararPendentes()).toBe(0);
      expect(push.notificarDose).toHaveBeenCalledTimes(1);
    });

    it('não notifica dose futura', async () => {
      await criarDose(AGORA + 5 * MIN);
      expect(await scheduler.dispararPendentes()).toBe(0);
    });

    it('não notifica dose já respondida', async () => {
      await criarDose(AGORA, { status: DoseStatus.TAKEN });
      await criarDose(AGORA, { status: DoseStatus.SKIPPED });
      await criarDose(AGORA, { status: DoseStatus.CANCELED });
      expect(await scheduler.dispararPendentes()).toBe(0);
    });

    it('não notifica dose fora da janela de tolerância', async () => {
      await criarDose(AGORA - JANELA_TOLERANCIA_SEG - 1);
      expect(await scheduler.dispararPendentes()).toBe(0);
    });

    it('notifica dose no limite exato da tolerância', async () => {
      await criarDose(AGORA - JANELA_TOLERANCIA_SEG);
      expect(await scheduler.dispararPendentes()).toBe(1);
    });

    it('dispara em ordem cronológica', async () => {
      const tarde = await criarDose(AGORA - 2 * MIN);
      const cedo = await criarDose(AGORA - 20 * MIN);
      await scheduler.dispararPendentes();

      expect(push.notificarDose.mock.calls.map((c) => c[1])).toEqual([
        cedo.id,
        tarde.id,
      ]);
    });

    it('entrega uma única notificação sob execução concorrente (claim atômico)', async () => {
      await criarDose(AGORA);
      const [a, b] = await Promise.all([
        scheduler.dispararPendentes(),
        scheduler.dispararPendentes(),
      ]);
      expect(a + b).toBe(1);
      expect(push.notificarDose).toHaveBeenCalledTimes(1);
    });
  });

  describe('marcarPerdidas', () => {
    it('marca como MISSED a dose que passou da tolerância sem resposta', async () => {
      const dose = await criarDose(AGORA - JANELA_TOLERANCIA_SEG - 1);
      expect(await scheduler.marcarPerdidas()).toBe(1);
      expect((await recarregar(dose.id)).status).toBe(DoseStatus.MISSED);
    });

    it('marca como MISSED mesmo a dose que chegou a ser notificada', async () => {
      const dose = await criarDose(AGORA - 2 * JANELA_TOLERANCIA_SEG, {
        notifiedAt: AGORA - 2 * JANELA_TOLERANCIA_SEG,
      });
      await scheduler.marcarPerdidas();
      expect((await recarregar(dose.id)).status).toBe(DoseStatus.MISSED);
    });

    it('não mexe em dose dentro da janela', async () => {
      const dose = await criarDose(AGORA - MIN);
      expect(await scheduler.marcarPerdidas()).toBe(0);
      expect((await recarregar(dose.id)).status).toBe(DoseStatus.PENDING);
    });

    it('não reabre dose já respondida', async () => {
      const dose = await criarDose(AGORA - 10 * JANELA_TOLERANCIA_SEG, {
        status: DoseStatus.TAKEN,
      });
      await scheduler.marcarPerdidas();
      expect((await recarregar(dose.id)).status).toBe(DoseStatus.TAKEN);
    });
  });

  describe('recuperação após indisponibilidade (ADR-001 §2.3)', () => {
    it('não dispara avalanche: notifica só o que está na janela e perde o resto', async () => {
      // Seis horas de queda, uma dose a cada hora.
      const atrasadas = [];
      for (let h = 6; h >= 1; h--) atrasadas.push(await criarDose(AGORA - h * 3600));
      const recente = await criarDose(AGORA - 10 * MIN);

      await scheduler.tick();

      expect(push.notificarDose).toHaveBeenCalledTimes(1);
      expect(push.notificarDose).toHaveBeenCalledWith(userId, recente.id);
      for (const dose of atrasadas) {
        expect((await recarregar(dose.id)).status).toBe(DoseStatus.MISSED);
      }
    });
  });

  describe('estenderHorizonte', () => {
    it('delega ao serviço de medicamentos', async () => {
      await scheduler.estenderHorizonte();
      expect(medicamentos.estenderHorizonte).toHaveBeenCalledTimes(1);
    });
  });
});
