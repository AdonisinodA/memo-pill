import type { Request } from 'express';
import { wantsHtml } from './wants-html';

const req = (accept?: string) => ({ headers: accept ? { accept } : {} }) as Request;

describe('wantsHtml', () => {
  it('reconhece a navegação do navegador', () => {
    expect(
      wantsHtml(req('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')),
    ).toBe(true);
  });

  it('trata chamada de API como não-navegação', () => {
    expect(wantsHtml(req('application/json'))).toBe(false);
  });

  // O `fetch` sem cabeçalhos — o caso do Service Worker — manda o curinga. Se
  // isso contasse como navegação, a confirmação da dose receberia um redirect
  // de volta ao HTML em vez do JSON que o SW espera.
  it('não considera navegação o Accept curinga', () => {
    expect(wantsHtml(req('*/*'))).toBe(false);
  });

  it('não considera navegação a ausência de Accept', () => {
    expect(wantsHtml(req())).toBe(false);
  });
});
