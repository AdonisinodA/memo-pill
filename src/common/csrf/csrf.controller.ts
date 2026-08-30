import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessaoGuard } from '../../auth/sessao.guard';

/**
 * Expõe o token CSRF a consumidores que não passam pela renderização do
 * Handlebars — notadamente o Service Worker, que busca o token imediatamente
 * antes de confirmar uma dose (ADR-001 §2.4).
 */
@Controller('csrf')
@UseGuards(SessaoGuard)
export class CsrfController {
  // Sem cache: o token não pode ser retido pelo Service Worker nem pelo browser.
  @Get()
  @Header('Cache-Control', 'no-store')
  token(@Req() req: Request): { csrfToken: string } {
    return { csrfToken: req.csrfToken! };
  }
}
