import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { FLASH_COOKIE, readFlash } from './flash';

/**
 * Entrega a mensagem pendente à view e apaga o cookie no mesmo movimento —
 * a mensagem é de uso único e não pode reaparecer no próximo carregamento.
 *
 * `res.locals` é o canal certo: o Express o mescla nas opções de `res.render`,
 * então o toast fica disponível no layout sem que cada controller precise
 * repassá-lo no modelo da view.
 */
@Injectable()
export class FlashMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const flash = readFlash(req);
    if (!flash) return next();

    res.locals.flash = flash;
    res.clearCookie(FLASH_COOKIE, { path: '/' });
    next();
  }
}
