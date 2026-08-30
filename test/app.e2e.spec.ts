import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Server } from 'node:http';

// O ambiente precisa existir antes de o AppModule ser avaliado.
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'segredo-de-teste-suficientemente-longo';
// Par VAPID descartável: o web-push valida o formato da chave no construtor.
process.env.VAPID_PUBLIC_KEY =
  'BA-jBHOxdsNMJwA__FFD5TApJ2-kIEVXFcq4isiEKY9moaqH096RU0CE_sJsGISY4ph5Gzxeh4KyN9iEr90RdiM';
process.env.VAPID_PRIVATE_KEY = '5SLE1FySCdUVw7Empa3xzElVI3ODUJotQYa73KuQTCc';
// Limite geral folgado; as rotas de credencial mantêm o limite real de 5/min.
process.env.THROTTLE_GERAL = '1000';

import { AppModule } from '../src/app.module';
import { configurarApp } from '../src/configurar-app';
import { Clock, FixedClock } from '../src/common/time/clock';
import { seg } from './helpers/fixtures';

/** 30/08/2026 às 12:00 em São Paulo. */
const AGORA = seg('2026-08-30T15:00:00Z');
const HOJE = '2026-08-30';

const pegarCookie = (res: request.Response, nome: string): string | undefined =>
  ([] as string[])
    .concat((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith(`${nome}=`));

const valorDoCookie = (cookie: string): string => cookie.split(';')[0].split('=')[1];

interface Sessao {
  cookies: string[];
  csrfToken: string;
  refresh: string;
}

describe('Aplicação (e2e)', () => {
  let app: NestExpressApplication;
  let http: Server;
  // Rotas de credencial têm limite de 5/min: as sessões são criadas uma vez
  // e reaproveitadas, em vez de uma por teste.
  let principal: Sessao;
  let dono: Sessao;
  let intruso: Sessao;

  async function abrirSessao(email: string): Promise<Sessao> {
    const inicial = await request(http).get('/cadastro');
    const csrfCookie = pegarCookie(inicial, 'csrf_token')!;
    const csrfToken = valorDoCookie(csrfCookie);

    const res = await request(http)
      .post('/auth/cadastro')
      .set('Cookie', csrfCookie)
      .type('form')
      .send({
        _csrf: csrfToken,
        email,
        senha: 'senha-bem-longa-1',
        nome: 'Adonis',
        consentimento: 'true',
      })
      .expect(302);

    const refresh = pegarCookie(res, 'refresh_token')!;
    return { cookies: [csrfCookie, refresh], csrfToken, refresh };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // Relógio fixo: as doses geradas e a tela do dia ficam determinísticas.
      .overrideProvider(Clock)
      .useValue(new FixedClock(AGORA))
      .compile();

    app = mod.createNestApplication<NestExpressApplication>();
    configurarApp(app);
    await app.init();
    http = app.getHttpServer() as Server;

    principal = await abrirSessao('principal@example.com');
    dono = await abrirSessao('dono@example.com');
    intruso = await abrirSessao('intruso@example.com');
  });

  afterAll(() => app?.close());

  describe('páginas públicas', () => {
    it('serve a tela de login com campo CSRF', async () => {
      const res = await request(http).get('/login').expect(200);
      expect(res.text).toContain('name="_csrf"');
      expect(res.text).toContain('action="/auth/login"');
    });

    it('emite o cookie CSRF como HttpOnly e SameSite=Lax', async () => {
      const cookie = pegarCookie(await request(http).get('/login'), 'csrf_token')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('destaca o consentimento LGPD na tela de cadastro', async () => {
      const res = await request(http).get('/cadastro').expect(200);
      expect(res.text).toContain('name="consentimento"');
      expect(res.text).toContain('dados sensíveis de saúde');
    });

    it('aplica os cabeçalhos de segurança do helmet', async () => {
      const res = await request(http).get('/login').expect(200);
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('proteção CSRF (ADR-001 §2.4)', () => {
    it('recusa POST sem token', async () => {
      await request(http)
        .post('/auth/login')
        .type('form')
        .send({ email: 'a@example.com', senha: 'senha-longa-1' })
        .expect(403);
    });

    it('recusa POST com token que não bate com o cookie', async () => {
      const cookie = pegarCookie(await request(http).get('/login'), 'csrf_token')!;
      await request(http)
        .post('/auth/login')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: 'f'.repeat(64), email: 'a@example.com', senha: 'senha-longa-1' })
        .expect(403);
    });

    it('não exige token em requisição GET', async () => {
      await request(http).get('/login').expect(200);
    });
  });

  describe('sessão', () => {
    it('redireciona navegação sem sessão para o login', async () => {
      await request(http)
        .get('/doses/hoje')
        .set('Accept', 'text/html')
        .expect(302)
        .expect('Location', '/login');
    });

    it('responde 401 a chamada de API sem sessão', async () => {
      await request(http).get('/csrf').set('Accept', 'application/json').expect(401);
    });

    it('grava o refresh token como HttpOnly e SameSite=Lax', () => {
      expect(principal.refresh).toContain('HttpOnly');
      expect(principal.refresh).toMatch(/SameSite=Lax/i);
    });

    it('entrega o token pela rota /csrf para o Service Worker', async () => {
      const res = await request(http)
        .get('/csrf')
        .set('Cookie', principal.cookies)
        .set('Accept', 'application/json')
        .expect(200);

      expect(res.body.csrfToken).toBe(principal.csrfToken);
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('troca o refresh do cookie por um access token de curta duração', async () => {
      const res = await request(http)
        .post('/auth/refresh')
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .expect(201);

      expect(typeof res.body.accessToken).toBe('string');
    });
  });

  describe('fluxo completo: cadastrar remédio, ver o dia e confirmar a dose', () => {
    it('leva do cadastro do medicamento até a dose registrada como tomada', async () => {
      await request(http)
        .post('/medicamentos')
        .set('Cookie', principal.cookies)
        .type('form')
        .send({
          _csrf: principal.csrfToken,
          nome: 'Losartana',
          dosagem: '50 mg',
          'horarios[]': ['20:00', '22:00', ''],
          inicioEm: HOJE,
          fimEm: '',
        })
        .expect(303);

      const dashboard = await request(http)
        .get('/doses/hoje')
        .set('Cookie', principal.cookies)
        .expect(200);

      expect(dashboard.text).toContain('Losartana');
      expect(dashboard.text).toContain('Olá, Adonis');
      expect(dashboard.text).toContain('>20:00<');
      expect(dashboard.text).toContain('>22:00<');
      expect(dashboard.text).toContain('Tomei');

      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(dashboard.text)?.[1];
      expect(doseId).toBeDefined();

      // Confirmação como o Service Worker faz: token no cabeçalho, resposta JSON.
      const confirmacao = await request(http)
        .post(`/doses/${doseId}/taken`)
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .expect(201);

      expect(confirmacao.body).toEqual({ id: doseId, status: 'TAKEN' });

      const depois = await request(http)
        .get('/doses/hoje')
        .set('Cookie', principal.cookies)
        .expect(200);
      expect(depois.text).not.toContain(`/doses/${doseId}/taken`);

      const historico = await request(http)
        .get('/historico')
        .set('Cookie', principal.cookies)
        .expect(200);
      // Uma tomada e uma ainda pendente: a pendente não entra no denominador.
      expect(historico.text).toContain('100%');
    });

    it('entrega ao Service Worker o resumo da dose, resolvido na própria origem', async () => {
      const tela = await request(http).get('/doses/hoje').set('Cookie', principal.cookies);
      // A dose das 20:00 foi confirmada no teste anterior; sobra a das 22:00.
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(tela.text)?.[1];
      expect(doseId).toBeDefined();

      const res = await request(http)
        .get(`/doses/${doseId}/resumo`)
        .set('Cookie', principal.cookies)
        .set('Accept', 'application/json')
        .expect(200);

      expect(res.body).toMatchObject({ nome: 'Losartana', dosagem: '50 mg' });
    });

    it('não deixa um usuário registrar dose de outro', async () => {
      await request(http)
        .post('/medicamentos')
        .set('Cookie', dono.cookies)
        .type('form')
        .send({
          _csrf: dono.csrfToken,
          nome: 'Metformina',
          dosagem: '850 mg',
          'horarios[]': ['21:00'],
          inicioEm: HOJE,
          fimEm: '',
        })
        .expect(303);

      const tela = await request(http).get('/doses/hoje').set('Cookie', dono.cookies);
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(tela.text)![1];

      await request(http)
        .post(`/doses/${doseId}/taken`)
        .set('Cookie', intruso.cookies)
        .set('X-CSRF-Token', intruso.csrfToken)
        .set('Accept', 'application/json')
        .expect(404);
    });
  });

  describe('validação de entrada', () => {
    it('recusa horário fora do formato HH:mm', async () => {
      await request(http)
        .post('/medicamentos')
        .set('Cookie', principal.cookies)
        .type('form')
        .send({
          _csrf: principal.csrfToken,
          nome: 'X',
          dosagem: '1 mg',
          'horarios[]': ['25:00'],
          inicioEm: HOJE,
        })
        .expect(400);
    });

    it('recusa campo não previsto no DTO', async () => {
      await request(http)
        .post('/medicamentos')
        .set('Cookie', principal.cookies)
        .type('form')
        .send({
          _csrf: principal.csrfToken,
          nome: 'X',
          dosagem: '1 mg',
          'horarios[]': ['08:00'],
          inicioEm: HOJE,
          userId: 'tentativa-de-mass-assignment',
        })
        .expect(400);
    });
  });

  describe('rate limiting (ADR-001 §2.4)', () => {
    it('bloqueia tentativas repetidas de login com 429', async () => {
      const cookie = pegarCookie(await request(http).get('/login'), 'csrf_token')!;
      const tentar = () =>
        request(http)
          .post('/auth/login')
          .set('Cookie', cookie)
          .type('form')
          .send({
            _csrf: valorDoCookie(cookie),
            email: 'forca-bruta@example.com',
            senha: 'chute-errado-1',
          });

      const codigos: number[] = [];
      for (let i = 0; i < 7; i++) codigos.push((await tentar()).status);

      // As cinco primeiras falham por credencial; as seguintes, por limite.
      expect(codigos.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codigos.slice(5)).toEqual([429, 429]);
    });

    it('não aplica o limite estrito à navegação comum', async () => {
      for (let i = 0; i < 8; i++) await request(http).get('/login').expect(200);
    });
  });
});
