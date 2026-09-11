import type { Request, Response } from 'express';

/** Cookie de vida curta que carrega a mensagem entre o POST e o redirect. */
export const FLASH_COOKIE = 'flash';

/**
 * Teto de tamanho da mensagem. Cookies têm limite prático de ~4 KB e uma
 * mensagem estourada seria descartada pelo navegador — o usuário ficaria sem
 * aviso nenhum. Truncar mantém o toast, ainda que abreviado.
 */
const MAX_MESSAGE = 300;

/**
 * Janela de validade. O cookie normalmente é consumido no próximo request, mas
 * se a resposta se perder ele não pode sobreviver para aparecer fora de hora.
 */
const TTL_SECONDS = 60;

export type FlashType = 'success' | 'error' | 'info';

export interface Flash {
  type: FlashType;
  message: string;
}

/**
 * Mensagem exibida uma única vez, na página seguinte a um redirect
 * (padrão POST/Redirect/GET). É o que transforma um erro do back em toast:
 * sem isto, o redirect faria a página recarregar sem vestígio do que houve.
 */
export function setFlash(res: Response, flash: Flash): void {
  const payload = JSON.stringify({
    type: flash.type,
    message: flash.message.slice(0, MAX_MESSAGE),
  });

  res.cookie(FLASH_COOKIE, payload, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_SECONDS * 1000,
  });
}

/**
 * Lê e valida o cookie. Conteúdo malformado — cookie adulterado à mão, sobra de
 * uma versão anterior — é descartado em silêncio: o toast é acessório e não
 * pode derrubar a renderização da página.
 */
export function readFlash(req: Request): Flash | null {
  const raw = req.cookies?.[FLASH_COOKIE] as unknown;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { type, message } = parsed as Record<string, unknown>;
    if (typeof message !== 'string' || message.trim() === '') return null;
    if (type !== 'success' && type !== 'error' && type !== 'info') return null;

    return { type, message: message.slice(0, MAX_MESSAGE) };
  } catch {
    return null;
  }
}
