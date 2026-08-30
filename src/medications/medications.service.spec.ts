import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { DoseLog } from '../doses/dose-log.entity';
import { DoseStatus } from '../doses/dose-status.enum';
import { HORIZONTE_DIAS } from '../doses/dose-schedule';
import { criarDataSourceDeTeste } from '../../test/helpers/db';
import { SP, criarUsuario, seg } from '../../test/helpers/fixtures';
import { Medication } from './medication.entity';
import { MedicationsService } from './medications.service';

const AGORA = seg('2026-08-30T09:00:00Z'); // 06:00 em São Paulo
const DIA = 86_400;

describe('MedicationsService', () => {
  let ds: DataSource;
  let service: MedicationsService;
  let clock: FixedClock;
  let userId: string;

  const dosesDe = (medicationId: string) =>
    ds.getRepository(DoseLog).find({
      where: { medicationId },
      order: { scheduledFor: 'ASC' },
    });

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    clock = new FixedClock(AGORA);

    const mod = await Test.createTestingModule({
      providers: [
        MedicationsService,
        { provide: Clock, useValue: clock },
        { provide: getDataSourceToken(), useValue: ds },
        { provide: getRepositoryToken(Medication), useValue: ds.getRepository(Medication) },
      ],
    }).compile();

    service = mod.get(MedicationsService);
    userId = (await criarUsuario(ds)).id;
  });

  afterEach(() => ds.destroy());

  const criar = (over = {}) =>
    service.criar(userId, SP, {
      nome: 'Losartana',
      dosagem: '50 mg',
      horarios: ['08:00', '20:00'],
      inicioEm: '2026-08-30',
      fimEm: null,
      ...over,
    });

  describe('criar', () => {
    it('materializa as doses do horizonte de 90 dias', async () => {
      const med = await criar();
      expect(await dosesDe(med.id)).toHaveLength(HORIZONTE_DIAS * 2);
    });

    it('materializa o tratamento inteiro quando ele cabe no horizonte', async () => {
      const med = await criar({ fimEm: '2026-09-05' });
      expect(await dosesDe(med.id)).toHaveLength(14);
    });

    it('grava os instantes em UTC, convertidos do fuso do usuário', async () => {
      const med = await criar({ horarios: ['08:00'] });
      const [primeira] = await dosesDe(med.id);
      expect(primeira.scheduledFor).toBe(seg('2026-08-30T11:00:00Z'));
    });

    it('cria toda dose com status PENDING e sem marca de entrega', async () => {
      const med = await criar({ fimEm: '2026-08-31' });
      const doses = await dosesDe(med.id);
      expect(doses.every((d) => d.status === DoseStatus.PENDING)).toBe(true);
      expect(doses.every((d) => d.notifiedAt === null)).toBe(true);
    });

    it('não materializa doses já passadas no dia do cadastro', async () => {
      clock.set(seg('2026-08-30T15:00:00Z')); // 12:00 em SP, depois da dose das 08:00
      const med = await criar({ horarios: ['08:00', '20:00'], fimEm: '2026-08-30' });
      const doses = await dosesDe(med.id);
      expect(doses).toHaveLength(1);
      expect(doses[0].scheduledFor).toBe(seg('2026-08-30T23:00:00Z'));
    });
  });

  describe('remover (soft delete)', () => {
    it('não apaga fisicamente o medicamento', async () => {
      const med = await criar();
      await service.remover(userId, med.id);
      const salvo = await ds.getRepository(Medication).findOneBy({ id: med.id });
      expect(salvo).not.toBeNull();
      expect(salvo!.deletedAt).toBe(AGORA);
    });

    it('preserva o histórico de doses já respondidas', async () => {
      const med = await criar({ fimEm: '2026-09-05' });
      const doses = await dosesDe(med.id);
      await ds.getRepository(DoseLog).update(doses[0].id, {
        status: DoseStatus.TAKEN,
        respondedAt: AGORA,
      });

      await service.remover(userId, med.id);

      const depois = await ds.getRepository(DoseLog).findOneBy({ id: doses[0].id });
      expect(depois!.status).toBe(DoseStatus.TAKEN);
    });

    it('cancela apenas as doses futuras ainda pendentes', async () => {
      clock.set(seg('2026-09-01T15:00:00Z'));
      const med = await criar({ inicioEm: '2026-08-30', fimEm: '2026-09-05' });
      const antes = await dosesDe(med.id);
      const passadas = antes.filter((d) => d.scheduledFor <= clock.nowSeconds()).length;

      await service.remover(userId, med.id);

      const depois = await dosesDe(med.id);
      const canceladas = depois.filter((d) => d.status === DoseStatus.CANCELED);
      const pendentes = depois.filter((d) => d.status === DoseStatus.PENDING);
      expect(canceladas).toHaveLength(depois.length - passadas);
      expect(pendentes).toHaveLength(passadas);
    });

    it('some da listagem depois de removido', async () => {
      const med = await criar();
      await service.remover(userId, med.id);
      expect(await service.listar(userId)).toHaveLength(0);
    });

    it('recusa remover medicamento de outro usuário', async () => {
      const outro = await criarUsuario(ds);
      const med = await criar();
      await expect(service.remover(outro.id, med.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('atualizar', () => {
    it('cancela as doses futuras obsoletas e regera pela nova posologia', async () => {
      const med = await criar({ horarios: ['08:00'], fimEm: '2026-09-05' });
      expect(await dosesDe(med.id)).toHaveLength(7);

      await service.atualizar(userId, SP, med.id, {
        nome: 'Losartana',
        dosagem: '50 mg',
        horarios: ['08:00', '14:00', '20:00'],
        inicioEm: '2026-08-30',
        fimEm: '2026-09-05',
      });

      const doses = await dosesDe(med.id);
      const canceladas = doses.filter((d) => d.status === DoseStatus.CANCELED);
      const pendentes = doses.filter((d) => d.status === DoseStatus.PENDING);
      expect(canceladas).toHaveLength(7);
      expect(pendentes).toHaveLength(21);
    });

    it('não deixa dose órfã da posologia antiga em estado pendente', async () => {
      const med = await criar({ horarios: ['08:00'], fimEm: '2026-09-05' });
      await service.atualizar(userId, SP, med.id, {
        nome: 'Losartana',
        dosagem: '50 mg',
        horarios: ['21:00'],
        inicioEm: '2026-08-30',
        fimEm: '2026-09-05',
      });

      const pendentes = (await dosesDe(med.id)).filter(
        (d) => d.status === DoseStatus.PENDING,
      );
      const horas = new Set(
        pendentes.map((d) => (d.scheduledFor % DIA) / 3600),
      );
      expect(horas).toEqual(new Set([0])); // 21:00 em SP = 00:00 UTC
    });
  });

  describe('estenderHorizonte', () => {
    it('é idempotente: nada a criar quando o horizonte já está cheio', async () => {
      await criar();
      expect(await service.estenderHorizonte()).toBe(0);
    });

    it('empurra o horizonte adiante conforme o tempo passa', async () => {
      const med = await criar();
      const antes = (await dosesDe(med.id)).length;

      clock.advance(10 * DIA);
      const criadas = await service.estenderHorizonte();

      expect(criadas).toBe(20); // 10 dias × 2 doses
      expect(await dosesDe(med.id)).toHaveLength(antes + 20);
    });

    it('não estende tratamento com fim definido já materializado', async () => {
      await criar({ fimEm: '2026-09-05' });
      clock.advance(10 * DIA);
      expect(await service.estenderHorizonte()).toBe(0);
    });

    it('ignora medicamentos removidos', async () => {
      const med = await criar();
      await service.remover(userId, med.id);
      clock.advance(10 * DIA);
      expect(await service.estenderHorizonte()).toBe(0);
    });

    it('não duplica doses no instante de fronteira', async () => {
      const med = await criar();
      clock.advance(DIA);
      await service.estenderHorizonte();
      await service.estenderHorizonte();

      const doses = await dosesDe(med.id);
      expect(new Set(doses.map((d) => d.scheduledFor)).size).toBe(doses.length);
    });
  });
});
