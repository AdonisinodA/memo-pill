import {
  Body, Controller, Get, Post, Render, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, REFRESH_TTL_SEG } from './auth.service';
import { REFRESH_COOKIE_OPTIONS } from './refresh-cookie';

/** Limite mais rigoroso para rotas de credencial (ADR-001 §2.4). */
const CREDENTIAL_RATE_LIMIT = { default: { ttl: 60_000, limit: 5 } };
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { REFRESH_COOKIE, SessionGuard } from './session.guard';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('login')
  @Render('login')
  loginPage(@Req() req: Request) {
    return { title: 'Entrar', csrfToken: req.csrfToken, mode: 'login' };
  }

  @Get('cadastro')
  @Render('login')
  registerPage(@Req() req: Request) {
    return { title: 'Criar conta', csrfToken: req.csrfToken, mode: 'register' };
  }

  @Post('auth/login')
  @Throttle(CREDENTIAL_RATE_LIMIT)
  async login(@Body() dto: LoginDto, @Res() res: Response): Promise<void> {
    const session = await this.auth.login(dto);
    this.setRefreshCookie(res, session.refreshToken);
    res.redirect('/doses/hoje');
  }

  @Post('auth/cadastro')
  @Throttle(CREDENTIAL_RATE_LIMIT)
  async register(@Body() dto: RegisterDto, @Res() res: Response): Promise<void> {
    const session = await this.auth.register(dto);
    this.setRefreshCookie(res, session.refreshToken);
    res.redirect('/doses/hoje');
  }

  /** Troca o refresh do cookie por um access token de curta duração. */
  @Post('auth/refresh')
  @UseGuards(SessionGuard)
  async refresh(@Req() req: Request): Promise<{ accessToken: string }> {
    const token = req.cookies[REFRESH_COOKIE] as string;
    const { accessToken } = await this.auth.refresh(token);
    return { accessToken };
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...REFRESH_COOKIE_OPTIONS,
      maxAge: REFRESH_TTL_SEG * 1000,
    });
  }

}
