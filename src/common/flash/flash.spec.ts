import type { Request, Response } from 'express';
import { FLASH_COOKIE, readFlash, setFlash } from './flash';
import { FlashMiddleware } from './flash.middleware';

const res = () => {
  const cookies: { name: string; value: string; options: unknown }[] = [];
  const cleared: string[] = [];
  return {
    locals: {} as Record<string, unknown>,
    cookie: (name: string, value: string, options: unknown) =>
      cookies.push({ name, value, options }),
    clearCookie: (name: string) => cleared.push(name),
    cookies,
    cleared,
  };
};

const req = (cookieValue?: unknown) =>
  ({ cookies: cookieValue === undefined ? {} : { [FLASH_COOKIE]: cookieValue } }) as Request;

describe('flash', () => {
  describe('setFlash', () => {
    it('grava a mensagem serializada no cookie de vida curta', () => {
      const response = res();
      setFlash(response as unknown as Response, { type: 'error', message: 'Deu ruim' });

      expect(response.cookies).toHaveLength(1);
      expect(response.cookies[0].name).toBe(FLASH_COOKIE);
      expect(JSON.parse(response.cookies[0].value)).toEqual({
        type: 'error',
        message: 'Deu ruim',
      });
    });

    it('mantém o cookie HttpOnly e com prazo curto', () => {
      const response = res();
      setFlash(response as unknown as Response, { type: 'info', message: 'oi' });

      expect(response.cookies[0].options).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60_000,
      });
    });

    // Cookie estourado é descartado inteiro pelo navegador: o usuário ficaria
    // sem aviso nenhum, que é pior do que um aviso abreviado.
    it('trunca mensagem longa para o cookie não ser descartado', () => {
      const response = res();
      setFlash(response as unknown as Response, { type: 'error', message: 'x'.repeat(5000) });

      expect(JSON.parse(response.cookies[0].value).message).toHaveLength(300);
    });
  });

  describe('readFlash', () => {
    it('lê a mensagem gravada', () => {
      expect(readFlash(req('{"type":"success","message":"Pronto"}'))).toEqual({
        type: 'success',
        message: 'Pronto',
      });
    });

    it('devolve nulo quando não há cookie', () => {
      expect(readFlash(req())).toBeNull();
    });

    it.each([
      ['JSON inválido', 'não é json'],
      ['tipo desconhecido', '{"type":"explodir","message":"oi"}'],
      ['mensagem vazia', '{"type":"error","message":"   "}'],
      ['mensagem ausente', '{"type":"error"}'],
      ['valor não textual', '{}'],
    ])('descarta cookie adulterado (%s) em vez de quebrar a página', (_, value) => {
      expect(readFlash(req(value))).toBeNull();
    });
  });

  describe('FlashMiddleware', () => {
    const middleware = new FlashMiddleware();

    it('entrega a mensagem à view e apaga o cookie no mesmo request', () => {
      const response = res();
      const next = jest.fn();

      middleware.use(
        req('{"type":"error","message":"Deu ruim"}'),
        response as unknown as Response,
        next,
      );

      expect(response.locals.flash).toEqual({ type: 'error', message: 'Deu ruim' });
      expect(response.cleared).toEqual([FLASH_COOKIE]);
      expect(next).toHaveBeenCalled();
    });

    it('não mexe na resposta quando não há mensagem pendente', () => {
      const response = res();
      const next = jest.fn();

      middleware.use(req(), response as unknown as Response, next);

      expect(response.locals.flash).toBeUndefined();
      expect(response.cleared).toEqual([]);
      expect(next).toHaveBeenCalled();
    });
  });
});
