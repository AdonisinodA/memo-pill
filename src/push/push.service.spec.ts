import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste } from '../../test/helpers/db';
import { criarUsuario } from '../../test/helpers/fixtures';
import { PushSubscription } from './push-subscription.entity';
import { PushService, SLEEP } from './push.service';
import { PushDeliveryError, WebPushTransport } from './web-push.transport';

describe('PushService', () => {
  let ds: DataSource;
  let service: PushService;
  let enviar: jest.Mock;
  let userId: string;

  const inscricoesNoBanco = () =>
    ds.getRepository(PushSubscription).findBy({ userId });

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    enviar = jest.fn().mockResolvedValue(undefined);

    const mod = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: WebPushTransport, useValue: { enviar } },
        { provide: SLEEP, useValue: async () => undefined },
        {
          provide: getRepositoryToken(PushSubscription),
          useValue: ds.getRepository(PushSubscription),
        },
      ],
    }).compile();

    service = mod.get(PushService);
    userId = (await criarUsuario(ds)).id;
  });

  afterEach(() => ds.destroy());

  const inscrever = (endpoint: string) =>
    service.registrar(userId, { endpoint, p256dh: 'chave', auth: 'auth' });

  describe('notificarDose', () => {
    it('entrega a todas as inscrições do usuário', async () => {
      await inscrever('https://fcm.example/1');
      await inscrever('https://fcm.example/2');

      const r = await service.notificarDose(userId, 'dose-1');
      expect(r).toEqual({ entregues: 2, removidas: 0, falhas: 0 });
    });

    it('envia apenas o identificador da dose, sem dado de saúde (ADR-001 §2.4)', async () => {
      await inscrever('https://fcm.example/1');
      await service.notificarDose(userId, 'dose-1');

      const payload = JSON.parse(enviar.mock.calls[0][1]);
      expect(payload).toEqual({ doseId: 'dose-1' });
    });

    it('não entrega a inscrição de outro usuário', async () => {
      const outro = await criarUsuario(ds);
      await service.registrar(outro.id, {
        endpoint: 'https://fcm.example/outro',
        p256dh: 'k',
        auth: 'a',
      });
      const r = await service.notificarDose(userId, 'dose-1');
      expect(r.entregues).toBe(0);
      expect(enviar).not.toHaveBeenCalled();
    });
  });

  describe('inscrições mortas (404/410 Gone)', () => {
    it.each([404, 410])('remove a inscrição após HTTP %i', async (status) => {
      await inscrever('https://fcm.example/morta');
      enviar.mockRejectedValue(new PushDeliveryError(status, 'Gone'));

      const r = await service.notificarDose(userId, 'dose-1');
      expect(r).toEqual({ entregues: 0, removidas: 1, falhas: 0 });
      expect(await inscricoesNoBanco()).toHaveLength(0);
    });

    it('não insiste em inscrição morta', async () => {
      await inscrever('https://fcm.example/morta');
      enviar.mockRejectedValue(new PushDeliveryError(410, 'Gone'));

      await service.notificarDose(userId, 'dose-1');
      expect(enviar).toHaveBeenCalledTimes(1);
    });

    it('preserva as inscrições vivas ao remover uma morta', async () => {
      await inscrever('https://fcm.example/viva');
      await inscrever('https://fcm.example/morta');
      enviar
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new PushDeliveryError(410, 'Gone'));

      const r = await service.notificarDose(userId, 'dose-1');
      expect(r).toEqual({ entregues: 1, removidas: 1, falhas: 0 });
      expect(await inscricoesNoBanco()).toHaveLength(1);
    });
  });

  describe('falhas transitórias (429/5xx)', () => {
    it('reenvia com backoff e conclui quando o serviço se recupera', async () => {
      await inscrever('https://fcm.example/1');
      enviar
        .mockRejectedValueOnce(new PushDeliveryError(503, 'Unavailable'))
        .mockResolvedValueOnce(undefined);

      const r = await service.notificarDose(userId, 'dose-1');
      expect(r.entregues).toBe(1);
      expect(enviar).toHaveBeenCalledTimes(2);
    });

    it('desiste após três tentativas e mantém a inscrição', async () => {
      await inscrever('https://fcm.example/1');
      enviar.mockRejectedValue(new PushDeliveryError(429, 'Too Many Requests'));

      const r = await service.notificarDose(userId, 'dose-1');
      expect(r).toEqual({ entregues: 0, removidas: 0, falhas: 1 });
      expect(enviar).toHaveBeenCalledTimes(3);
      expect(await inscricoesNoBanco()).toHaveLength(1);
    });

    it('espera mais a cada tentativa (backoff exponencial)', async () => {
      const esperas: number[] = [];
      const mod = await Test.createTestingModule({
        providers: [
          PushService,
          { provide: WebPushTransport, useValue: { enviar } },
          {
            provide: SLEEP,
            useValue: async (ms: number) => {
              esperas.push(ms);
            },
          },
          {
            provide: getRepositoryToken(PushSubscription),
            useValue: ds.getRepository(PushSubscription),
          },
        ],
      }).compile();

      await inscrever('https://fcm.example/1');
      enviar.mockRejectedValue(new PushDeliveryError(500, 'Server Error'));
      await mod.get(PushService).notificarDose(userId, 'dose-1');

      expect(esperas).toEqual([500, 1000]);
    });
  });
});
