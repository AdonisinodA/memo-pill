import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createTestDataSource } from '../../test/helpers/db';
import { createUser } from '../../test/helpers/fixtures';
import { PushSubscription } from './push-subscription.entity';
import { PushService, SLEEP } from './push.service';
import { PushDeliveryError, WebPushTransport } from './web-push.transport';

describe('PushService', () => {
  let ds: DataSource;
  let service: PushService;
  let send: jest.Mock;
  let userId: string;

  const storedSubscriptions = () =>
    ds.getRepository(PushSubscription).findBy({ userId });

  beforeEach(async () => {
    ds = await createTestDataSource();
    send = jest.fn().mockResolvedValue(undefined);

    const mod = await Test.createTestingModule({
      providers: [
        PushService,
        { provide: WebPushTransport, useValue: { send } },
        { provide: SLEEP, useValue: async () => undefined },
        {
          provide: getRepositoryToken(PushSubscription),
          useValue: ds.getRepository(PushSubscription),
        },
      ],
    }).compile();

    service = mod.get(PushService);
    userId = (await createUser(ds)).id;
  });

  afterEach(() => ds.destroy());

  const subscribe = (endpoint: string) =>
    service.subscribe(userId, { endpoint, p256dh: 'chave', auth: 'auth' });

  /**
   * O navegador reinscreve a cada visita e devolve o mesmo `endpoint`, que é
   * único na tabela. Sem o upsert, a segunda visita virava 500 e o aparelho
   * ficava sem lembrete.
   */
  describe('inscrever', () => {
    const dados = (over = {}) => ({
      endpoint: 'https://fcm.example/mesmo-aparelho',
      p256dh: 'chave-1',
      auth: 'auth-1',
      ...over,
    });

    it('não duplica a inscrição do mesmo aparelho', async () => {
      await service.subscribe(userId, dados());
      await service.subscribe(userId, dados());

      expect(await ds.getRepository(PushSubscription).count()).toBe(1);
    });

    it('atualiza as chaves quando o navegador as renova', async () => {
      await service.subscribe(userId, dados());
      await service.subscribe(userId, dados({ p256dh: 'chave-2', auth: 'auth-2' }));

      const inscricao = await ds.getRepository(PushSubscription).findOneByOrFail({
        endpoint: dados().endpoint,
      });
      expect(inscricao).toMatchObject({ p256dh: 'chave-2', auth: 'auth-2' });
    });

    // Aparelho compartilhado: os lembretes passam a ser de quem entrou por
    // último, e não dos dois ao mesmo tempo.
    it('transfere o aparelho para a última conta que se inscreveu', async () => {
      const outro = await createUser(ds);
      await service.subscribe(userId, dados());
      await service.subscribe(outro.id, dados());

      expect((await service.notifyDose(userId, 'dose-1')).delivered).toBe(0);
      expect((await service.notifyDose(outro.id, 'dose-1')).delivered).toBe(1);
    });
  });

  describe('notificarDose', () => {
    it('entrega a todas as inscrições do usuário', async () => {
      await subscribe('https://fcm.example/1');
      await subscribe('https://fcm.example/2');

      const r = await service.notifyDose(userId, 'dose-1');
      expect(r).toEqual({ delivered: 2, removed: 0, failed: 0 });
    });

    it('envia apenas o identificador da dose, sem dado de saúde (ADR-001 §2.4)', async () => {
      await subscribe('https://fcm.example/1');
      await service.notifyDose(userId, 'dose-1');

      const payload = JSON.parse(send.mock.calls[0][1]);
      expect(payload).toEqual({ doseId: 'dose-1' });
    });

    it('não entrega a inscrição de outro usuário', async () => {
      const other = await createUser(ds);
      await service.subscribe(other.id, {
        endpoint: 'https://fcm.example/outro',
        p256dh: 'k',
        auth: 'a',
      });
      const r = await service.notifyDose(userId, 'dose-1');
      expect(r.delivered).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('inscrições mortas (404/410 Gone)', () => {
    it.each([404, 410])('remove a inscrição após HTTP %i', async (status) => {
      await subscribe('https://fcm.example/morta');
      send.mockRejectedValue(new PushDeliveryError(status, 'Gone'));

      const r = await service.notifyDose(userId, 'dose-1');
      expect(r).toEqual({ delivered: 0, removed: 1, failed: 0 });
      expect(await storedSubscriptions()).toHaveLength(0);
    });

    it('não insiste em inscrição morta', async () => {
      await subscribe('https://fcm.example/morta');
      send.mockRejectedValue(new PushDeliveryError(410, 'Gone'));

      await service.notifyDose(userId, 'dose-1');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('preserva as inscrições vivas ao remover uma morta', async () => {
      await subscribe('https://fcm.example/viva');
      await subscribe('https://fcm.example/morta');
      send
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new PushDeliveryError(410, 'Gone'));

      const r = await service.notifyDose(userId, 'dose-1');
      expect(r).toEqual({ delivered: 1, removed: 1, failed: 0 });
      expect(await storedSubscriptions()).toHaveLength(1);
    });
  });

  describe('falhas transitórias (429/5xx)', () => {
    it('reenvia com backoff e conclui quando o serviço se recupera', async () => {
      await subscribe('https://fcm.example/1');
      send
        .mockRejectedValueOnce(new PushDeliveryError(503, 'Unavailable'))
        .mockResolvedValueOnce(undefined);

      const r = await service.notifyDose(userId, 'dose-1');
      expect(r.delivered).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('desiste após três tentativas e mantém a inscrição', async () => {
      await subscribe('https://fcm.example/1');
      send.mockRejectedValue(new PushDeliveryError(429, 'Too Many Requests'));

      const r = await service.notifyDose(userId, 'dose-1');
      expect(r).toEqual({ delivered: 0, removed: 0, failed: 1 });
      expect(send).toHaveBeenCalledTimes(3);
      expect(await storedSubscriptions()).toHaveLength(1);
    });

    it('espera mais a cada tentativa (backoff exponencial)', async () => {
      const waits: number[] = [];
      const mod = await Test.createTestingModule({
        providers: [
          PushService,
          { provide: WebPushTransport, useValue: { send } },
          {
            provide: SLEEP,
            useValue: async (ms: number) => {
              waits.push(ms);
            },
          },
          {
            provide: getRepositoryToken(PushSubscription),
            useValue: ds.getRepository(PushSubscription),
          },
        ],
      }).compile();

      await subscribe('https://fcm.example/1');
      send.mockRejectedValue(new PushDeliveryError(500, 'Server Error'));
      await mod.get(PushService).notifyDose(userId, 'dose-1');

      expect(waits).toEqual([500, 1000]);
    });
  });
});
