import { Injectable } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Nome do cookie que guarda o token CSRF da sessão. */
export const CSRF_COOKIE = 'csrf_token';
/** Cabeçalho aceito além do campo `_csrf` do formulário. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Token CSRF sintético vinculado à sessão (ADR-001 §2.4).
 *
 * `SameSite=Lax` sozinho não cobre todos os cenários — e foi escolhido no lugar
 * de `Strict` para não quebrar a navegação vinda do clique na notificação push.
 */
@Injectable()
export class CsrfService {
  gerar(): string {
    return randomBytes(32).toString('hex');
  }

  /** Comparação em tempo constante, para não vazar o token por temporização. */
  conferir(doCookie: string | undefined, doPedido: unknown): boolean {
    if (typeof doCookie !== 'string' || typeof doPedido !== 'string') return false;
    if (doCookie.length === 0 || doCookie.length !== doPedido.length) return false;
    return timingSafeEqual(Buffer.from(doCookie), Buffer.from(doPedido));
  }
}
