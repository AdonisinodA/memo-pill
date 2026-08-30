import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Redirect,
  Render, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import { SessaoGuard } from '../auth/sessao.guard';
import { Clock } from '../common/time/clock';
import { DoseStatus } from './dose-status.enum';
import { DosesService, StatusRegistravel } from './doses.service';

@Controller()
@UseGuards(SessaoGuard)
export class DosesController {
  constructor(
    private readonly doses: DosesService,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Redirect('/doses/hoje')
  raiz(): void {}

  @Get('doses/hoje')
  @Render('dashboard')
  async hoje(@Req() req: Request) {
    const user = req.user!;
    return {
      title: 'Hoje',
      csrfToken: req.csrfToken,
      usuario: { nome: user.nome },
      dataAtual: DateTime.fromSeconds(this.clock.nowSeconds(), {
        zone: user.timezone,
      })
        .setLocale('pt-BR')
        .toFormat("cccc, d 'de' LLLL"),
      medicamentos: await this.doses.doDia(user.id, user.timezone),
    };
  }

  @Get('historico')
  @Render('historico')
  async historico(@Req() req: Request) {
    const user = req.user!;
    const { resumo, doses } = await this.doses.historico(user.id, user.timezone);
    return { title: 'Histórico', csrfToken: req.csrfToken, resumo, doses };
  }

  /**
   * Resumo consumido pelo Service Worker ao receber o push. O payload push
   * carrega só o id da dose; o nome do medicamento é buscado aqui, na própria
   * origem, e não trafega pelo push service (ADR-001 §2.4).
   */
  @Get('doses/:id/resumo')
  async resumo(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user!;
    const doses = await this.doses.doDia(user.id, user.timezone);
    const dose = doses.find((d) => d.id === id);
    return dose ?? { id, nome: 'Seu medicamento', dosagem: '', horario: '' };
  }

  @Post('doses/:id/taken')
  registrarTomada(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.registrar(req, id, DoseStatus.TAKEN);
  }

  @Post('doses/:id/skipped')
  registrarPulo(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.registrar(req, id, DoseStatus.SKIPPED);
  }

  /**
   * Formulário HBS espera redirect; o Service Worker espera JSON.
   * O `Accept` da requisição decide.
   */
  private async registrar(req: Request, id: string, status: StatusRegistravel) {
    const dose = await this.doses.registrar(req.user!.id, id, status);
    if (req.accepts(['html', 'json']) === 'html') {
      return { url: '/doses/hoje', statusCode: 303 };
    }
    return { id: dose.id, status: dose.status };
  }
}
