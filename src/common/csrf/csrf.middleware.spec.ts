import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CSRF_COOKIE, CsrfService } from './csrf.service';
import { CsrfMiddleware } from './csrf.middleware';

describe('CsrfMiddleware', () => {
  const csrf = new CsrfService();
  const middleware = new CsrfMiddleware(csrf);

  const makeRequest = (over: Partial<Request> = {}): Request =>
    ({ method: 'GET', cookies: {}, headers: {}, body: {}, ...over }) as Request;

  const makeResponse = () => {
    const cookie = jest.fn();
    return { res: { cookie } as unknown as Response, cookie };
  };

  it('emite cookie CSRF quando ainda não existe', () => {
    const req = makeRequest();
    const { res, cookie } = makeResponse();
    middleware.use(req, res, jest.fn());

    expect(req.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      req.csrfToken,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('reaproveita o cookie existente sem reemitir', () => {
    const token = csrf.generate();
    const req = makeRequest({ cookies: { [CSRF_COOKIE]: token } });
    const { res, cookie } = makeResponse();
    middleware.use(req, res, jest.fn());

    expect(req.csrfToken).toBe(token);
    expect(cookie).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('não valida token em %s', (method) => {
    const next = jest.fn();
    middleware.use(makeRequest({ method }), makeResponse().res, next);
    expect(next).toHaveBeenCalled();
  });

  it('aceita POST com token no corpo', () => {
    const token = csrf.generate();
    const next = jest.fn();
    middleware.use(
      makeRequest({ method: 'POST', cookies: { [CSRF_COOKIE]: token }, body: { _csrf: token } }),
      makeResponse().res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('aceita POST com token no cabeçalho, como faz o Service Worker', () => {
    const token = csrf.generate();
    const next = jest.fn();
    middleware.use(
      makeRequest({
        method: 'POST',
        cookies: { [CSRF_COOKIE]: token },
        headers: { 'x-csrf-token': token },
      }),
      makeResponse().res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('remove o _csrf do corpo para não vazar ao DTO', () => {
    const token = csrf.generate();
    const body: Record<string, unknown> = { _csrf: token, name: 'Losartana' };
    middleware.use(
      makeRequest({ method: 'POST', cookies: { [CSRF_COOKIE]: token }, body }),
      makeResponse().res,
      jest.fn(),
    );
    expect(body).toEqual({ name: 'Losartana' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('recusa %s sem token', (method) => {
    const next = jest.fn();
    expect(() =>
      middleware.use(
        makeRequest({ method, cookies: { [CSRF_COOKIE]: csrf.generate() } }),
        makeResponse().res,
        next,
      ),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('recusa POST com token que não corresponde ao cookie', () => {
    expect(() =>
      middleware.use(
        makeRequest({
          method: 'POST',
          cookies: { [CSRF_COOKIE]: csrf.generate() },
          body: { _csrf: csrf.generate() },
        }),
        makeResponse().res,
        jest.fn(),
      ),
    ).toThrow(ForbiddenException);
  });
});
