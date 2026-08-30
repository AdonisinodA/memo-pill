import {
  Body, Controller, Get, Post, Render, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService, REFRESH_TTL_SEG } from './auth.service';

/** Limite mais rigoroso para rotas de credencial (ADR-001 §2.4). */
const LIMITE_CREDENCIAL = { default: { ttl: 60_000, limit: 5 } };
import { LoginDto, RegistrarDto } from './dto/auth.dto';
import { REFRESH_COOKIE, SessaoGuard } from './sessao.guard';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('login')
  @Render('login')
  paginaLogin(@Req() req: Request) {
    return { title: 'Entrar', csrfToken: req.csrfToken, modo: 'login' };
  }

  @Get('cadastro')
  @Render('login')
  paginaCadastro(@Req() req: Request) {
    return { title: 'Criar conta', csrfToken: req.csrfToken, modo: 'cadastro' };
  }

  @Post('auth/login')
  @Throttle(LIMITE_CREDENCIAL)
  async login(@Body() dto: LoginDto, @Res() res: Response): Promise<void> {
    const sessao = await this.auth.login(dto);
    this.gravarCookie(res, sessao.refreshToken);
    res.redirect('/doses/hoje');
  }

  @Post('auth/cadastro')
  @Throttle(LIMITE_CREDENCIAL)
  async cadastrar(@Body() dto: RegistrarDto, @Res() res: Response): Promise<void> {
    const sessao = await this.auth.registrar(dto);
    this.gravarCookie(res, sessao.refreshToken);
    res.redirect('/doses/hoje');
  }

  @Post('auth/logout')
  logout(@Res() res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    res.redirect('/login');
  }

  /** Troca o refresh do cookie por um access token de curta duração. */
  @Post('auth/refresh')
  @UseGuards(SessaoGuard)
  async refresh(@Req() req: Request): Promise<{ accessToken: string }> {
    const token = req.cookies[REFRESH_COOKIE] as string;
    const { accessToken } = await this.auth.renovar(token);
    return { accessToken };
  }

  private gravarCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // Lax, e não Strict: Strict suprimiria o cookie na navegação vinda do
      // clique na notificação push, que é o fluxo central (ADR-001 §2.4).
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TTL_SEG * 1000,
    });
  }
}
