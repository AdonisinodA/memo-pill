import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Redirect,
  Render, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DateTime } from 'luxon';
import { SessionGuard } from '../auth/session.guard';
import { Clock } from '../common/time/clock';
import { DoseStatus } from './dose-status.enum';
import { DosesService, RecordableStatus } from './doses.service';

@Controller()
@UseGuards(SessionGuard)
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
  async today(@Req() req: Request) {
    const user = req.user!;
    return {
      title: 'Hoje',
      csrfToken: req.csrfToken,
      user: { name: user.name },
      currentDate: DateTime.fromSeconds(this.clock.nowSeconds(), {
        zone: user.timezone,
      })
        .setLocale('pt-BR')
        .toFormat("cccc, d 'de' LLLL"),
      doses: await this.doses.forToday(user.id, user.timezone),
    };
  }

  @Get('historico')
  @Render('history')
  async history(@Req() req: Request) {
    const user = req.user!;
    const { summary, doses } = await this.doses.history(user.id, user.timezone);
    return { title: 'Histórico', csrfToken: req.csrfToken, summary, doses };
  }

  /**
   * Resumo consumido pelo Service Worker ao receber o push. O payload push
   * carrega só o id da dose; o nome do medicamento é buscado aqui, na própria
   * origem, e não trafega pelo push service (ADR-001 §2.4).
   */
  @Get('doses/:id/resumo')
  async summary(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const user = req.user!;
    const doses = await this.doses.forToday(user.id, user.timezone);
    const dose = doses.find((d) => d.id === id);
    return dose ?? { id, name: 'Seu medicamento', dosage: '', time: '' };
  }

  @Post('doses/:id/taken')
  recordTaken(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.record(req, id, DoseStatus.TAKEN);
  }

  @Post('doses/:id/skipped')
  recordSkipped(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.record(req, id, DoseStatus.SKIPPED);
  }

  /**
   * Formulário HBS espera redirect; o Service Worker espera JSON.
   * O `Accept` da requisição decide.
   */
  private async record(req: Request, id: string, status: RecordableStatus) {
    const dose = await this.doses.record(req.user!.id, id, status);
    if (req.accepts(['html', 'json']) === 'html') {
      return { url: '/doses/hoje', statusCode: 303 };
    }
    return { id: dose.id, status: dose.status };
  }
}
