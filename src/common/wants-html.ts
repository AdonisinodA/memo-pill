import type { Request } from 'express';

/**
 * Distingue navegação de página de chamada programática.
 *
 * A checagem é pelo `text/html` explícito, e não por `req.accepts(...)`: sem
 * cabeçalho `Accept` — o caso de `fetch` sem headers e dos testes — o Express
 * considera qualquer tipo aceitável e devolveria "html" para uma chamada de
 * API, que deve continuar recebendo JSON.
 */
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}
