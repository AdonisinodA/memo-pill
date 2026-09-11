import {
  Body, Controller, HttpStatus, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { clearSessionCookies } from '../auth/refresh-cookie';
import { REFRESH_COOKIE, SessionGuard } from '../auth/session.guard';
import { setFlash } from '../common/flash/flash';
import { PushService } from '../push/push.service';

/** O aparelho que está saindo, informado por /js/push.js no formulário. */
export class LogoutDto {
  @IsOptional() @IsString() @MaxLength(1000)
  pushEndpoint?: string;
}

/**
 * Encerramento de sessão.
 *
 * Apagar o cookie não bastaria: o refresh token é um JWT de 30 dias e vale por
 * si só onde quer que exista uma cópia dele. Sair, aqui, desfaz quatro coisas:
 * o token no servidor, os cookies no navegador, a inscrição push do aparelho e
 * o cache das páginas já visitadas (`NoStoreInterceptor`).
 */
@Controller('auth')
export class LogoutController {
  constructor(
    private readonly auth: AuthService,
    private readonly push: PushService,
  ) {}

  /**
   * Sai deste aparelho. Sem guard de sessão de propósito: sair com a sessão já
   * vencida tem que levar ao mesmo lugar que sair com ela válida.
   */
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Body() dto: LogoutDto,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.auth.logout(
      req.cookies?.[REFRESH_COOKIE] as string | undefined,
    );

    // A notificação carrega nome de medicamento e horário. Mantê-la ativa
    // entregaria dado de saúde a quem usar o aparelho depois (ADR-001 §2.4).
    if (user && dto.pushEndpoint) {
      await this.push.removeDevice(user.id, dto.pushEndpoint);
    }

    this.finish(res, 'Você saiu da sua conta.');
  }

  /**
   * Sai de todos os aparelhos — o caminho de quem suspeita que a conta foi
   * acessada por outra pessoa. Exige sessão válida: é preciso saber de quem
   * são as sessões a derrubar.
   */
  @Post('sair-de-todos')
  @UseGuards(SessionGuard)
  async logoutAllDevices(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = req.user!.id;
    await this.auth.logoutAllDevices(userId);
    await this.push.removeAllDevices(userId);

    this.finish(
      res,
      'Você saiu de todos os aparelhos e as notificações foram desligadas em todos eles.',
    );
  }

  private finish(res: Response, message: string): void {
    clearSessionCookies(res);
    setFlash(res, { type: 'success', message });
    res.redirect(HttpStatus.SEE_OTHER, '/login');
  }
}
