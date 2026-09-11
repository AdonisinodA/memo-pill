import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { User } from '../users/user.entity';
import { AuthService } from './auth.service';

/** Cookie do refresh token: HttpOnly, Secure, SameSite=Lax (ADR-001 §2.4). */
export const REFRESH_COOKIE = 'refresh_token';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

/**
 * Autentica a requisição pelo refresh token do cookie.
 *
 * É o cookie que sustenta a navegação SSR: o access token vive apenas em
 * memória no cliente e não sobrevive a um page load.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');

    req.user = await this.auth.userFromToken(token);
    return true;
  }
}
