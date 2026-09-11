import {
  Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Redirect,
  Render, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { SessionGuard } from '../auth/session.guard';
import { setFlash } from '../common/flash/flash';
import { Clock } from '../common/time/clock';
import { wantsHtml } from '../common/wants-html';
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
    return {
      title: 'Histórico',
      csrfToken: req.csrfToken,
      user: { name: user.name },
      summary,
      doses,
    };
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
  recordTaken(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.record(req, res, id, DoseStatus.TAKEN);
  }

  @Post('doses/:id/skipped')
  recordSkipped(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.record(req, res, id, DoseStatus.SKIPPED);
  }

  /**
   * Formulário HBS espera redirect; o Service Worker espera JSON.
   * O `Accept` da requisição decide.
   *
   * A resposta é escrita à mão, e não devolvida ao Nest: o formato varia por
   * requisição, e `@Redirect()` — o caminho declarativo — redireciona sempre.
   * Sem ele, o objeto `{ url, statusCode }` voltava serializado como JSON na
   * tela do navegador, em vez de recarregar o dia.
   */
  private async record(
    req: Request,
    res: Response,
    id: string,
    status: RecordableStatus,
  ): Promise<void> {
    const dose = await this.doses.record(req.user!.id, id, status);

    if (wantsHtml(req)) {
      const name = dose.medication?.name ?? 'Dose';
      setFlash(res, {
        type: 'success',
        message:
          status === DoseStatus.TAKEN
            ? `${name} registrada como tomada.`
            : `${name} marcada como pulada.`,
      });
      res.redirect(HttpStatus.SEE_OTHER, '/doses/hoje');
      return;
    }

    res.status(HttpStatus.CREATED).json({ id: dose.id, status: dose.status });
  }
}
