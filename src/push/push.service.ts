import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushSubscription } from './push-subscription.entity';
import { PushDeliveryError, WebPushTransport } from './web-push.transport';

export const SLEEP = Symbol('SLEEP');
export type Sleep = (ms: number) => Promise<void>;

/** Status que indicam inscrição morta — devem ser removidas (ADR-001 §2.1). */
const DEAD_SUBSCRIPTION_STATUSES = [404, 410];
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface DeliveryResult {
  delivered: number;
  removed: number;
  failed: number;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
    private readonly transport: WebPushTransport,
    @Inject(SLEEP) private readonly sleep: Sleep,
  ) {}

  subscribe(
    userId: string,
    data: { endpoint: string; p256dh: string; auth: string },
  ): Promise<PushSubscription> {
    return this.subscriptions.save(
      this.subscriptions.create({ userId, ...data }),
    );
  }

  /**
   * Envia a todas as inscrições do usuário.
   *
   * O payload carrega apenas o identificador da dose: o nome do medicamento é
   * resolvido pelo Service Worker via API, para não trafegar dado de saúde pelo
   * push service (ADR-001 §2.4).
   */
  async notifyDose(userId: string, doseId: string): Promise<DeliveryResult> {
    const subscriptions = await this.subscriptions.findBy({ userId });
    const payload = JSON.stringify({ doseId });
    const result: DeliveryResult = { delivered: 0, removed: 0, failed: 0 };

    for (const subscription of subscriptions) {
      const status = await this.deliverWithRetry(subscription, payload);
      if (status === 'delivered') result.delivered++;
      else if (status === 'removed') result.removed++;
      else result.failed++;
    }
    return result;
  }

  private async deliverWithRetry(
    subscription: PushSubscription,
    payload: string,
  ): Promise<'delivered' | 'removed' | 'failed'> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.transport.send(subscription, payload);
        return 'delivered';
      } catch (error) {
        const status =
          error instanceof PushDeliveryError ? error.statusCode : 0;

        // Inscrição morta: não adianta insistir, ela nunca mais vai responder.
        if (DEAD_SUBSCRIPTION_STATUSES.includes(status)) {
          await this.subscriptions.delete({ id: subscription.id });
          this.logger.log(
            `Inscrição ${subscription.id} removida após HTTP ${status}`,
          );
          return 'removed';
        }

        const lastAttempt = attempt === MAX_ATTEMPTS;
        if (lastAttempt) {
          this.logger.warn(
            `Falha ao entregar em ${subscription.id} após ${MAX_ATTEMPTS} tentativas (HTTP ${status})`,
          );
          return 'failed';
        }
        await this.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    return 'failed';
  }
}
