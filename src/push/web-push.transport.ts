import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PushSubscription } from './push-subscription.entity';

/** Erro de entrega que preserva o status HTTP devolvido pelo push service. */
export class PushDeliveryError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'PushDeliveryError';
  }
}

/**
 * Fronteira de rede do envio push. Abstraída para que o agendador seja
 * testável sem tocar em FCM/APNs.
 */
export abstract class WebPushTransport {
  abstract enviar(inscricao: PushSubscription, payload: string): Promise<void>;
}

@Injectable()
export class WebPushHttpTransport extends WebPushTransport {
  constructor(config: ConfigService) {
    super();
    webpush.setVapidDetails(
      config.getOrThrow<string>('vapid.subject'),
      config.getOrThrow<string>('vapid.publicKey'),
      config.getOrThrow<string>('vapid.privateKey'),
    );
  }

  async enviar(inscricao: PushSubscription, payload: string): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: inscricao.endpoint,
          keys: { p256dh: inscricao.p256dh, auth: inscricao.auth },
        },
        payload,
      );
    } catch (erro) {
      const status = (erro as { statusCode?: number }).statusCode ?? 0;
      throw new PushDeliveryError(status, (erro as Error).message);
    }
  }
}
