import type { CookieOptions, Response } from 'express';
import { CSRF_COOKIE } from '../common/csrf/csrf.service';
import { REFRESH_COOKIE } from './session.guard';

/**
 * Atributos do cookie de sessão, em um lugar só.
 *
 * O navegador só apaga um cookie quando os atributos batem com os da criação.
 * Divergir entre o `set` e o `clear` deixaria o refresh token no aparelho
 * depois do "Sair" — exatamente o que o logout existe para impedir.
 */
export const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // Lax, e não Strict: Strict suprimiria o cookie na navegação vinda do clique
  // na notificação push, que é o fluxo central (ADR-001 §2.4).
  sameSite: 'lax',
  path: '/',
};

/**
 * Apaga os cookies que sustentam a sessão.
 *
 * O token CSRF vai junto: ele é vinculado à sessão, e mantê-lo faria a próxima
 * pessoa a usar o aparelho herdar o token de quem saiu. O CsrfMiddleware emite
 * um novo na requisição seguinte.
 */
export function clearSessionCookies(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.clearCookie(CSRF_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}
