import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CSRF_COOKIE, CSRF_HEADER, CsrfService } from './csrf.service';

/** Métodos sem efeito colateral dispensam validação. */
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'express-serve-static-core' {
  interface Request {
    csrfToken?: string;
  }
}

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private readonly csrf: CsrfService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    let token = req.cookies?.[CSRF_COOKIE] as string | undefined;

    if (!token) {
      token = this.csrf.gerar();
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
    }
    req.csrfToken = token;

    if (METODOS_SEGUROS.has(req.method)) return next();

    const enviado =
      (req.body as Record<string, unknown> | undefined)?._csrf ??
      req.headers[CSRF_HEADER];

    if (!this.csrf.conferir(token, enviado)) {
      throw new ForbiddenException('Token CSRF inválido ou ausente');
    }

    // O token é dado de transporte, não de domínio: consumido aqui, ele não
    // chega aos DTOs — que rodam com forbidNonWhitelisted ligado.
    if (req.body && typeof req.body === 'object') {
      delete (req.body as Record<string, unknown>)._csrf;
    }
    next();
  }
}
