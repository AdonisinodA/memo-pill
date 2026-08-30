import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushSubscription } from './push-subscription.entity';
import { PushDeliveryError, WebPushTransport } from './web-push.transport';

export const SLEEP = Symbol('SLEEP');
export type Sleep = (ms: number) => Promise<void>;

/** Status que indicam inscrição morta — devem ser removidas (ADR-001 §2.1). */
const STATUS_INSCRICAO_MORTA = [404, 410];
const MAX_TENTATIVAS = 3;
const BASE_BACKOFF_MS = 500;

export interface ResultadoEnvio {
  entregues: number;
  removidas: number;
  falhas: number;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectRepository(PushSubscription)
    private readonly inscricoes: Repository<PushSubscription>,
    private readonly transport: WebPushTransport,
    @Inject(SLEEP) private readonly sleep: Sleep,
  ) {}

  registrar(
    userId: string,
    dados: { endpoint: string; p256dh: string; auth: string },
  ): Promise<PushSubscription> {
    return this.inscricoes.save(
      this.inscricoes.create({ userId, ...dados }),
    );
  }

  /**
   * Envia a todas as inscrições do usuário.
   *
   * O payload carrega apenas o identificador da dose: o nome do medicamento é
   * resolvido pelo Service Worker via API, para não trafegar dado de saúde pelo
   * push service (ADR-001 §2.4).
   */
  async notificarDose(userId: string, doseId: string): Promise<ResultadoEnvio> {
    const inscricoes = await this.inscricoes.findBy({ userId });
    const payload = JSON.stringify({ doseId });
    const resultado: ResultadoEnvio = { entregues: 0, removidas: 0, falhas: 0 };

    for (const inscricao of inscricoes) {
      const status = await this.entregarComRetentativa(inscricao, payload);
      if (status === 'entregue') resultado.entregues++;
      else if (status === 'removida') resultado.removidas++;
      else resultado.falhas++;
    }
    return resultado;
  }

  private async entregarComRetentativa(
    inscricao: PushSubscription,
    payload: string,
  ): Promise<'entregue' | 'removida' | 'falha'> {
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      try {
        await this.transport.enviar(inscricao, payload);
        return 'entregue';
      } catch (erro) {
        const status =
          erro instanceof PushDeliveryError ? erro.statusCode : 0;

        // Inscrição morta: não adianta insistir, ela nunca mais vai responder.
        if (STATUS_INSCRICAO_MORTA.includes(status)) {
          await this.inscricoes.delete({ id: inscricao.id });
          this.logger.log(
            `Inscrição ${inscricao.id} removida após HTTP ${status}`,
          );
          return 'removida';
        }

        const ultimaTentativa = tentativa === MAX_TENTATIVAS;
        if (ultimaTentativa) {
          this.logger.warn(
            `Falha ao entregar em ${inscricao.id} após ${MAX_TENTATIVAS} tentativas (HTTP ${status})`,
          );
          return 'falha';
        }
        await this.sleep(BASE_BACKOFF_MS * 2 ** (tentativa - 1));
      }
    }
    return 'falha';
  }
}
