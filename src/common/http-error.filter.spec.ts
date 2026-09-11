import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FLASH_COOKIE } from './flash/flash';
import { HttpErrorFilter } from './http-error.filter';

const HTML = 'text/html,application/xhtml+xml';

interface Captured {
  status?: number;
  json?: unknown;
  redirect?: { status?: number; url: string };
  render?: { view: string; model: Record<string, unknown> };
  flash?: { type: string; message: string };
}

function contexto(over: Partial<Request> = {}) {
  const captured: Captured = {};

  const res = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.json = body;
    },
    render(view: string, model: Record<string, unknown>) {
      captured.render = { view, model };
    },
    redirect(a: number | string, b?: string) {
      captured.redirect =
        typeof a === 'number' ? { status: a, url: b! } : { url: a };
    },
    cookie(name: string, value: string) {
      if (name === FLASH_COOKIE) captured.flash = JSON.parse(value);
    },
  };

  const req = {
    method: 'POST',
    originalUrl: '/doses/1/taken',
    headers: { accept: HTML, host: 'app.local' },
    get: (header: string) =>
      header.toLowerCase() === 'referer' ? 'http://app.local/doses/hoje' : undefined,
    ...over,
  } as unknown as Request;

  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res as unknown as Response,
    }),
  } as ArgumentsHost;

  return { host, captured };
}

describe('HttpErrorFilter', () => {
  const filter = new HttpErrorFilter();

  describe('chamada de API', () => {
    const api = (over: Partial<Request> = {}) =>
      contexto({ headers: { accept: 'application/json', host: 'app.local' }, ...over });

    it('mantém status e corpo da exceção em JSON', () => {
      const { host, captured } = api();
      filter.catch(new NotFoundException('Dose não encontrada'), host);

      expect(captured.status).toBe(404);
      expect(captured.json).toMatchObject({ message: 'Dose não encontrada' });
      expect(captured.redirect).toBeUndefined();
    });

    it('responde 401 sem redirecionar, para o cliente tratar', () => {
      const { host, captured } = api({ method: 'GET' } as Partial<Request>);
      filter.catch(new UnauthorizedException('Sua sessão expirou. Entre novamente.'), host);

      expect(captured.status).toBe(401);
      expect(captured.redirect).toBeUndefined();
    });

    // Nem toda falha é HttpException: uma query quebrada chega como Error cru,
    // e o corpo da resposta não pode carregar o detalhe interno.
    it('traduz erro inesperado em 500 genérico', () => {
      const { host, captured } = api();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      filter.catch(new Error('SQLITE_CONSTRAINT: coluna x'), host);

      expect(captured.status).toBe(500);
      expect(JSON.stringify(captured.json)).not.toContain('SQLITE_CONSTRAINT');
    });
  });

  describe('navegação (POST de formulário)', () => {
    it('volta para a página de origem com a mensagem em toast', () => {
      const { host, captured } = contexto();
      filter.catch(new ConflictException('Esta dose já foi tomada.'), host);

      expect(captured.redirect).toEqual({ status: 303, url: '/doses/hoje' });
      expect(captured.flash).toEqual({
        type: 'error',
        message: 'Esta dose já foi tomada.',
      });
    });

    // O ValidationPipe devolve uma lista; corrigir um erro por vez, com um
    // recarregamento a cada tentativa, seria o pior caminho para o usuário.
    it('junta todas as falhas de validação numa mensagem só', () => {
      const { host, captured } = contexto();
      filter.catch(
        new BadRequestException({
          statusCode: 400,
          message: ['Informe a dosagem.', 'Preencha ao menos um horário.'],
        }),
        host,
      );

      expect(captured.flash?.message).toBe(
        'Informe a dosagem. · Preencha ao menos um horário.',
      );
    });

    it('leva ao login quando a sessão expirou no meio do formulário', () => {
      const { host, captured } = contexto();
      filter.catch(new UnauthorizedException('Sua sessão expirou. Entre novamente.'), host);

      expect(captured.redirect).toEqual({ url: '/login' });
      expect(captured.flash?.message).toBe('Sua sessão expirou. Entre novamente.');
    });

    // Login recusado também é 401, e o motivo é a senha — não a sessão.
    it('preserva o motivo da exceção na mensagem do login recusado', () => {
      const { host, captured } = contexto();
      filter.catch(new UnauthorizedException('E-mail ou senha incorretos.'), host);

      expect(captured.flash?.message).toBe('E-mail ou senha incorretos.');
    });

    // O motivo real do 403 (token CSRF) não diz nada a quem está na tela, e o
    // 429 do throttler chega em inglês, de dentro da biblioteca.
    it.each([
      ['token CSRF vencido', new ForbiddenException('Token CSRF inválido ou ausente'), 'Recarregue'],
      ['limite de requisições', new HttpException('ThrottlerException: Too many requests', 429), 'Aguarde um minuto'],
    ])('traduz %s numa orientação acionável', (_, excecao, trecho) => {
      const { host, captured } = contexto();
      filter.catch(excecao, host);

      expect(captured.flash?.message).toContain(trecho);
    });

    it('não expõe detalhe interno de erro inesperado no toast', () => {
      const { host, captured } = contexto();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      filter.catch(new Error('SQLITE_CONSTRAINT: coluna x'), host);

      expect(captured.flash?.message).not.toContain('SQLITE_CONSTRAINT');
      expect(captured.redirect?.url).toBe('/doses/hoje');
    });

    describe('destino do retorno', () => {
      const backTo = (referer?: string) => {
        const { host, captured } = contexto({
          get: (() => referer) as Request['get'],
        });
        filter.catch(new ForbiddenException('Token CSRF inválido'), host);
        return captured.redirect?.url;
      };

      it('usa o caminho do Referer da própria origem', () => {
        expect(backTo('http://app.local/medicamentos/novo?x=1')).toBe(
          '/medicamentos/novo?x=1',
        );
      });

      // O Referer vem do cliente: aproveitá-lo inteiro transformaria qualquer
      // erro em redirecionamento aberto para fora do app.
      it('ignora Referer de outro host', () => {
        expect(backTo('https://evil.example.com/phishing')).toBe('/doses/hoje');
      });

      it('cai na rota padrão sem Referer', () => {
        expect(backTo(undefined)).toBe('/doses/hoje');
      });

      it('cai na rota padrão com Referer ilegível', () => {
        expect(backTo('://isso-não-é-url')).toBe('/doses/hoje');
      });
    });
  });

  describe('navegação (GET)', () => {
    const get = (over: Partial<Request> = {}) =>
      contexto({ method: 'GET', ...over } as Partial<Request>);

    // Redirecionar um GET com toast levaria de volta à página que acabou de
    // falhar — e ao mesmo erro, em laço.
    it('renderiza a página de erro em vez de redirecionar', () => {
      const { host, captured } = get();
      filter.catch(new BadRequestException('Identificador inválido'), host);

      expect(captured.render?.view).toBe('error');
      expect(captured.render?.model).toMatchObject({
        status: 400,
        message: 'Identificador inválido',
      });
      expect(captured.status).toBe(400);
      expect(captured.redirect).toBeUndefined();
    });

    it('leva ao login, sem toast, quando não há sessão', () => {
      const { host, captured } = get();
      filter.catch(new UnauthorizedException('Sua sessão expirou. Entre novamente.'), host);

      expect(captured.redirect).toEqual({ url: '/login' });
      expect(captured.flash).toBeUndefined();
    });
  });

  // Erro no meio da renderização da view: o cabeçalho já foi, e tentar
  // redirecionar só produziria "Cannot set headers after they are sent".
  it('encerra a resposta já iniciada sem tentar reescrevê-la', () => {
    const { host, captured } = contexto();
    const res = host.switchToHttp().getResponse<Response & { headersSent: boolean }>();
    res.headersSent = true;
    res.end = jest.fn() as unknown as Response['end'];

    filter.catch(new ConflictException('tarde demais'), host);

    expect(res.end).toHaveBeenCalled();
    expect(captured.redirect).toBeUndefined();
    expect(captured.json).toBeUndefined();
  });
});
