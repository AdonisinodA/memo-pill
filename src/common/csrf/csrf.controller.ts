import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../../auth/session.guard';

/**
 * Expõe o token CSRF a consumidores que não passam pela renderização do
 * Handlebars — notadamente o Service Worker, que busca o token imediatamente
 * antes de confirmar uma dose (ADR-001 §2.4).
 */
@Controller('csrf')
@UseGuards(SessionGuard)
export class CsrfController {
  // O `no-store` desta resposta vem do NoStoreInterceptor global — o token não
  // pode ser retido pelo Service Worker nem pelo navegador.
  @Get()
  token(@Req() req: Request): { csrfToken: string } {
    return { csrfToken: req.csrfToken! };
  }
}
