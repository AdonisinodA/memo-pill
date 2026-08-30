import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { criarDataSourceDeTeste } from '../../test/helpers/db';
import { SP, criarMedicamento, criarUsuario, seg } from '../../test/helpers/fixtures';
import { Medication } from '../medications/medication.entity';
import { DoseLog } from './dose-log.entity';
import { DoseStatus } from './dose-status.enum';
import { DosesService } from './doses.service';

const AGORA = seg('2026-08-30T15:00:00Z'); // 12:00 em São Paulo

describe('DosesService', () => {
  let ds: DataSource;
  let service: DosesService;
  let clock: FixedClock;
  let userId: string;
  let medicationId: string;

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

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    clock = new FixedClock(AGORA);

    const mod = await Test.createTestingModule({
      providers: [
        DosesService,
        { provide: Clock, useValue: clock },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();

    service = mod.get(DosesService);
    userId = (await criarUsuario(ds)).id;
    medicationId = (await criarMedicamento(ds, userId, {
      nome: 'Losartana',
      dosagem: '50 mg',
    })).id;
  });

  afterEach(() => ds.destroy());

  describe('doDia', () => {
    it('entrega o modelo que a dashboard.hbs consome', async () => {
      await criarDose(seg('2026-08-30T11:00:00Z'));
      const [dose] = await service.doDia(userId, SP);

      expect(dose).toEqual({
        id: expect.any(String),
        nome: 'Losartana',
        dosagem: '50 mg',
        horario: '08:00', // 11:00 UTC exibido no fuso de São Paulo
        horarioISO: '2026-08-30T11:00:00.000Z',
        status: DoseStatus.PENDING,
      });
    });

    it('recorta o dia pelo fuso do usuário, não pelo UTC', async () => {
      // 02:00 UTC do dia 31 ainda é 23:00 do dia 30 em São Paulo.
      await criarDose(seg('2026-08-31T02:00:00Z'));
      // 02:00 UTC do dia 30 é 23:00 do dia 29 em São Paulo — fora.
      await criarDose(seg('2026-08-30T02:00:00Z'));

      const doses = await service.doDia(userId, SP);
      expect(doses).toHaveLength(1);
      expect(doses[0].horario).toBe('23:00');
    });

    it('ordena por horário crescente', async () => {
      await criarDose(seg('2026-08-30T23:00:00Z'));
      await criarDose(seg('2026-08-30T11:00:00Z'));
      expect((await service.doDia(userId, SP)).map((d) => d.horario)).toEqual([
        '08:00',
        '20:00',
      ]);
    });

    it('omite doses canceladas, que não representam adesão', async () => {
      await criarDose(seg('2026-08-30T11:00:00Z'), { status: DoseStatus.CANCELED });
      expect(await service.doDia(userId, SP)).toHaveLength(0);
    });

    it('inclui os demais status para a tela refletir o dia inteiro', async () => {
      await criarDose(seg('2026-08-30T10:00:00Z'), { status: DoseStatus.TAKEN });
      await criarDose(seg('2026-08-30T11:00:00Z'), { status: DoseStatus.MISSED });
      await criarDose(seg('2026-08-30T12:00:00Z'), { status: DoseStatus.SKIPPED });
      expect(await service.doDia(userId, SP)).toHaveLength(3);
    });

    it('não vaza dose de outro usuário', async () => {
      const outro = await criarUsuario(ds);
      const medOutro = await criarMedicamento(ds, outro.id);
      await ds.getRepository(DoseLog).save(
        ds.getRepository(DoseLog).create({
          medicationId: medOutro.id,
          scheduledFor: seg('2026-08-30T11:00:00Z'),
          status: DoseStatus.PENDING,
          notifiedAt: null,
          respondedAt: null,
        }),
      );
      expect(await service.doDia(userId, SP)).toHaveLength(0);
    });
  });

  describe('registrar', () => {
    it('transiciona PENDING para TAKEN e carimba a resposta', async () => {
      const dose = await criarDose(AGORA);
      const salva = await service.registrar(userId, dose.id, DoseStatus.TAKEN);
      expect(salva.status).toBe(DoseStatus.TAKEN);
      expect(salva.respondedAt).toBe(AGORA);
    });

    it('transiciona PENDING para SKIPPED', async () => {
      const dose = await criarDose(AGORA);
      const salva = await service.registrar(userId, dose.id, DoseStatus.SKIPPED);
      expect(salva.status).toBe(DoseStatus.SKIPPED);
    });

    it('é idempotente: o segundo toque na notificação não vira erro', async () => {
      const dose = await criarDose(AGORA);
      await service.registrar(userId, dose.id, DoseStatus.TAKEN);
      await expect(
        service.registrar(userId, dose.id, DoseStatus.TAKEN),
      ).resolves.toMatchObject({ status: DoseStatus.TAKEN });
    });

    it('recusa mudar uma dose já registrada com outro status', async () => {
      const dose = await criarDose(AGORA);
      await service.registrar(userId, dose.id, DoseStatus.TAKEN);
      await expect(
        service.registrar(userId, dose.id, DoseStatus.SKIPPED),
      ).rejects.toThrow(ConflictException);
    });

    it('recusa registrar dose já perdida — MISSED é terminal', async () => {
      const dose = await criarDose(AGORA - 7200, { status: DoseStatus.MISSED });
      await expect(
        service.registrar(userId, dose.id, DoseStatus.TAKEN),
      ).rejects.toThrow(ConflictException);
    });

    it('recusa registrar dose de outro usuário', async () => {
      const outro = await criarUsuario(ds);
      const dose = await criarDose(AGORA);
      await expect(
        service.registrar(outro.id, dose.id, DoseStatus.TAKEN),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('DosesService.historico', () => {
  let ds: DataSource;
  let service: DosesService;
  let userId: string;
  let medicationId: string;

  const criarDose = (scheduledFor: number, status: DoseStatus) =>
    ds.getRepository(DoseLog).save(
      ds.getRepository(DoseLog).create({
        medicationId, scheduledFor, status, notifiedAt: null, respondedAt: null,
      }),
    );

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    const mod = await Test.createTestingModule({
      providers: [
        DosesService,
        { provide: Clock, useValue: new FixedClock(AGORA) },
        { provide: getRepositoryToken(DoseLog), useValue: ds.getRepository(DoseLog) },
      ],
    }).compile();
    service = mod.get(DosesService);
    userId = (await criarUsuario(ds)).id;
    medicationId = (await criarMedicamento(ds, userId)).id;
  });

  afterEach(() => ds.destroy());

  it('calcula adesão sobre as doses já respondidas', async () => {
    const ontem = AGORA - 86_400;
    await criarDose(ontem, DoseStatus.TAKEN);
    await criarDose(ontem + 60, DoseStatus.TAKEN);
    await criarDose(ontem + 120, DoseStatus.TAKEN);
    await criarDose(ontem + 180, DoseStatus.MISSED);

    const { resumo } = await service.historico(userId, SP);
    expect(resumo).toMatchObject({ tomadas: 3, perdidas: 1, adesao: 75 });
  });

  it('não conta doses ainda pendentes no denominador da adesão', async () => {
    await criarDose(AGORA - 86_400, DoseStatus.TAKEN);
    await criarDose(AGORA + 3600, DoseStatus.PENDING); // ainda hoje, sem resposta

    const { resumo } = await service.historico(userId, SP);
    expect(resumo).toMatchObject({ pendentes: 1, adesao: 100 });
  });

  it('devolve adesão nula quando nada foi respondido ainda', async () => {
    await criarDose(AGORA + 3600, DoseStatus.PENDING);
    const { resumo } = await service.historico(userId, SP);
    expect(resumo.adesao).toBeNull();
  });

  it('preserva o histórico de medicamento removido (soft delete)', async () => {
    await criarDose(AGORA - 86_400, DoseStatus.TAKEN);
    await ds.getRepository(Medication).update(medicationId, { deletedAt: AGORA });

    const { resumo, doses } = await service.historico(userId, SP);
    expect(doses).toHaveLength(1);
    expect(resumo.tomadas).toBe(1);
  });

  it('ordena do mais recente para o mais antigo', async () => {
    await criarDose(AGORA - 3 * 86_400, DoseStatus.TAKEN);
    await criarDose(AGORA - 86_400, DoseStatus.TAKEN);
    const { doses } = await service.historico(userId, SP);
    expect(doses[0].horarioISO > doses[1].horarioISO).toBe(true);
  });

  it('ignora doses fora da janela de dias pedida', async () => {
    await criarDose(AGORA - 40 * 86_400, DoseStatus.TAKEN);
    const { resumo } = await service.historico(userId, SP, 30);
    expect(resumo.total).toBe(0);
  });
});
