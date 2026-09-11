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
process.env.THROTTLE_GENERAL = '1000';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { Clock, FixedClock } from '../src/common/time/clock';
import { sec } from './helpers/fixtures';

/** 30/08/2026 às 12:00 em São Paulo. */
const NOW = sec('2026-08-30T15:00:00Z');
const HOJE = '2026-08-30';

const getCookie = (res: request.Response, name: string): string | undefined =>
  ([] as string[])
    .concat((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith(`${name}=`));

const cookieValue = (cookie: string): string => cookie.split(';')[0].split('=')[1];

interface Session {
  cookies: string[];
  csrfToken: string;
  refresh: string;
}

describe('Aplicação (e2e)', () => {
  let app: NestExpressApplication;
  let http: Server;
  // Rotas de credencial têm limite de 5/min: as sessões são criadas uma vez
  // e reaproveitadas, em vez de uma por teste.
  let principal: Session;
  let owner: Session;
  let intruder: Session;

  async function openSession(email: string): Promise<Session> {
    const inicial = await request(http).get('/cadastro');
    const csrfCookie = getCookie(inicial, 'csrf_token')!;
    const csrfToken = cookieValue(csrfCookie);

    const res = await request(http)
      .post('/auth/cadastro')
      .set('Cookie', csrfCookie)
      .type('form')
      .send({
        _csrf: csrfToken,
        email,
        password: 'senha-bem-longa-1',
        name: 'Adonis',
        consent: 'true',
      })
      .expect(302);

    const refresh = getCookie(res, 'refresh_token')!;
    return { cookies: [csrfCookie, refresh], csrfToken, refresh };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      // Relógio fixo: as doses geradas e a tela do dia ficam determinísticas.
      .overrideProvider(Clock)
      .useValue(new FixedClock(NOW))
      .compile();

    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    http = app.getHttpServer() as Server;

    principal = await openSession('principal@example.com');
    owner = await openSession('dono@example.com');
    intruder = await openSession('intruso@example.com');
  });

  afterAll(() => app?.close());

  describe('layout das páginas', () => {
    /**
     * O pacote `hbs` não aplica layout sozinho. Sem `view options.layout`, cada
     * view é servida como fragmento — sem <html>, sem <head> e sem o <link> do
     * CSS —, e a página abre sem estilo nenhum no navegador. Nenhuma asserção
     * sobre o corpo da view percebe isso, daí estes testes olharem o documento.
     */
    const expectFullDocument = (html: string) => {
      expect(html).toMatch(/^\s*<!DOCTYPE html>/i);
      expect(html).toContain('<html lang="pt-BR"');
      expect(html).toContain('</html>');
      expect(html).toContain('href="/css/app.css"');
      expect(html).toContain('src="/js/app.js"');
      expect(html).toContain('href="/manifest.webmanifest"');
    };

    it('serve /login como documento completo, com o CSS ligado', async () => {
      const res = await request(http).get('/login').expect(200);
      expectFullDocument(res.text);
      expect(res.text).toContain('<title>Entrar · Lembrete de Medicamentos</title>');
    });

    it('serve /cadastro como documento completo', async () => {
      expectFullDocument((await request(http).get('/cadastro').expect(200)).text);
    });

    it('serve o dashboard como documento completo', async () => {
      const res = await request(http)
        .get('/doses/hoje')
        .set('Cookie', principal.cookies)
        .expect(200);
      expectFullDocument(res.text);
    });

    it('serve o histórico como documento completo', async () => {
      const res = await request(http)
        .get('/historico')
        .set('Cookie', principal.cookies)
        .expect(200);
      expectFullDocument(res.text);
    });
  });

  describe('páginas públicas', () => {
    it('serve a tela de login com campo CSRF', async () => {
      const res = await request(http).get('/login').expect(200);
      expect(res.text).toContain('name="_csrf"');
      expect(res.text).toContain('action="/auth/login"');
    });

    it('emite o cookie CSRF como HttpOnly e SameSite=Lax', async () => {
      const cookie = getCookie(await request(http).get('/login'), 'csrf_token')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('destaca o consentimento LGPD na tela de cadastro', async () => {
      const res = await request(http).get('/cadastro').expect(200);
      expect(res.text).toContain('name="consent"');
      expect(res.text).toContain('dados sensíveis de saúde');
    });

    it('aplica os cabeçalhos de segurança do helmet', async () => {
      const res = await request(http).get('/login').expect(200);
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("style-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('não envia upgrade-insecure-requests fora de produção', async () => {
      // Sob http://localhost a diretiva faria o navegador buscar CSS e JS em
      // https, derrubando os assets em silêncio.
      const res = await request(http).get('/login').expect(200);
      expect(res.headers['content-security-policy']).not.toContain(
        'upgrade-insecure-requests',
      );
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('serve o CSS e o JS da própria origem, como a CSP exige', async () => {
      const css = await request(http).get('/css/app.css').expect(200);
      expect(css.headers['content-type']).toContain('text/css');

      const js = await request(http).get('/js/app.js').expect(200);
      expect(js.headers['content-type']).toContain('javascript');
    });
  });

  describe('proteção CSRF (ADR-001 §2.4)', () => {
    it('recusa POST sem token', async () => {
      await request(http)
        .post('/auth/login')
        .type('form')
        .send({ email: 'a@example.com', password: 'senha-longa-1' })
        .expect(403);
    });

    it('recusa POST com token que não bate com o cookie', async () => {
      const cookie = getCookie(await request(http).get('/login'), 'csrf_token')!;
      await request(http)
        .post('/auth/login')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: 'f'.repeat(64), email: 'a@example.com', password: 'senha-longa-1' })
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
          name: 'Losartana',
          dosage: '50 mg',
          'times[]': ['20:00', '22:00', ''],
          startsOn: HOJE,
          endsOn: '',
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

      const after = await request(http)
        .get('/doses/hoje')
        .set('Cookie', principal.cookies)
        .expect(200);
      expect(after.text).not.toContain(`/doses/${doseId}/taken`);

      const history = await request(http)
        .get('/historico')
        .set('Cookie', principal.cookies)
        .expect(200);
      // Uma tomada e uma ainda pendente: a pendente não entra no denominador.
      expect(history.text).toContain('100%');
    });

    it('entrega ao Service Worker o resumo da dose, resolvido na própria origem', async () => {
      const screen = await request(http).get('/doses/hoje').set('Cookie', principal.cookies);
      // A dose das 20:00 foi confirmada no teste anterior; sobra a das 22:00.
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(screen.text)?.[1];
      expect(doseId).toBeDefined();

      const res = await request(http)
        .get(`/doses/${doseId}/resumo`)
        .set('Cookie', principal.cookies)
        .set('Accept', 'application/json')
        .expect(200);

      expect(res.body).toMatchObject({ name: 'Losartana', dosage: '50 mg' });
    });

    it('não deixa um usuário registrar dose de outro', async () => {
      await request(http)
        .post('/medicamentos')
        .set('Cookie', owner.cookies)
        .type('form')
        .send({
          _csrf: owner.csrfToken,
          name: 'Metformina',
          dosage: '850 mg',
          'times[]': ['21:00'],
          startsOn: HOJE,
          endsOn: '',
        })
        .expect(303);

      const screen = await request(http).get('/doses/hoje').set('Cookie', owner.cookies);
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(screen.text)![1];

      await request(http)
        .post(`/doses/${doseId}/taken`)
        .set('Cookie', intruder.cookies)
        .set('X-CSRF-Token', intruder.csrfToken)
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
          name: 'X',
          dosage: '1 mg',
          'times[]': ['25:00'],
          startsOn: HOJE,
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
          name: 'X',
          dosage: '1 mg',
          'times[]': ['08:00'],
          startsOn: HOJE,
          userId: 'tentativa-de-mass-assignment',
        })
        .expect(400);
    });
  });

  /**
   * O que o NAVEGADOR recebe. Os testes acima exercitam o caminho do Service
   * Worker (JSON); aqui o Accept é o de uma navegação real, e o esperado é
   * outro: recarregar a página com a mensagem, nunca um corpo JSON na tela.
   */
  describe('respostas ao navegador', () => {
    const flashOf = (res: request.Response): string | undefined => {
      const cookie = getCookie(res, 'flash');
      if (!cookie) return undefined;
      return JSON.parse(decodeURIComponent(cookieValue(cookie))).message as string;
    };

    /** Repete a navegação seguinte ao redirect, levando o aviso pendente. */
    const followWithFlash = (res: request.Response, session: Session, url: string) =>
      request(http)
        .get(url)
        .set('Accept', 'text/html')
        .set('Cookie', [...session.cookies, getCookie(res, 'flash') ?? '']);

    it('confirma a dose pelo formulário e recarrega o dia com o aviso', async () => {
      const screen = await request(http).get('/doses/hoje').set('Cookie', owner.cookies);
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(screen.text)![1];

      const res = await request(http)
        .post(`/doses/${doseId}/taken`)
        .set('Cookie', owner.cookies)
        .set('Accept', 'text/html')
        .type('form')
        .send({ _csrf: owner.csrfToken })
        .expect(303)
        .expect('Location', '/doses/hoje');

      // O objeto de redirect já chegou a ser serializado como JSON na tela.
      expect(res.text).not.toContain('"statusCode"');
      expect(flashOf(res)).toContain('Metformina');

      const dia = await followWithFlash(res, owner, '/doses/hoje').expect(200);
      expect(dia.text).toContain('id="toast"');
      expect(dia.text).toContain('Metformina registrada como tomada.');
    });

    it('mostra o aviso uma vez só, e não no carregamento seguinte', async () => {
      const res = await request(http)
        .post('/medicamentos')
        .set('Cookie', owner.cookies)
        .set('Accept', 'text/html')
        .type('form')
        .send({
          _csrf: owner.csrfToken,
          name: 'Dipirona',
          dosage: '500 mg',
          'times[]': ['09:00'],
          startsOn: HOJE,
          endsOn: '',
        })
        .expect(303);

      const primeira = await followWithFlash(res, owner, '/doses/hoje').expect(200);
      expect(primeira.text).toContain('Dipirona cadastrado');

      const segunda = await request(http)
        .get('/doses/hoje')
        .set('Accept', 'text/html')
        .set('Cookie', owner.cookies)
        .expect(200);
      expect(segunda.text).not.toContain('id="toast"');
    });

    it('devolve erro de validação como aviso na tela, não como JSON cru', async () => {
      const res = await request(http)
        .post('/medicamentos')
        .set('Cookie', owner.cookies)
        .set('Accept', 'text/html')
        .set('Referer', '/medicamentos/novo')
        .type('form')
        .send({
          _csrf: owner.csrfToken,
          name: 'Sem horário',
          dosage: '1 mg',
          'times[]': ['', ''],
          startsOn: HOJE,
        })
        .expect(303);

      expect(res.text).not.toContain('Bad Request');
      expect(flashOf(res)).toBe('Preencha ao menos um horário.');

      const form = await followWithFlash(res, owner, '/medicamentos/novo').expect(200);
      expect(form.text).toContain('Preencha ao menos um horário.');
    });

    it('avisa em vez de falhar ao registrar uma dose já respondida', async () => {
      const screen = await request(http).get('/doses/hoje').set('Cookie', principal.cookies);
      const doseId = /\/doses\/([0-9a-f-]{36})\/taken/.exec(screen.text)![1];

      await request(http)
        .post(`/doses/${doseId}/taken`)
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .expect(201);

      const res = await request(http)
        .post(`/doses/${doseId}/skipped`)
        .set('Cookie', principal.cookies)
        .set('Accept', 'text/html')
        .type('form')
        .send({ _csrf: principal.csrfToken })
        .expect(303);

      expect(flashOf(res)).toBe('Esta dose já foi tomada e não pode mais ser alterada.');
    });

    it('mantém o JSON para quem não pede HTML (Service Worker)', async () => {
      const res = await request(http)
        .post('/doses/11111111-1111-4111-8111-111111111111/taken')
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .expect(404);

      expect(res.body).toMatchObject({ statusCode: 404, message: 'Dose não encontrada' });
    });
  });

  describe('tela de remédios cadastrados', () => {
    it('lista a posologia completa do usuário', async () => {
      const res = await request(http)
        .get('/medicamentos')
        .set('Cookie', owner.cookies)
        .expect(200);

      expect(res.text).toContain('Metformina');
      expect(res.text).toContain('850 mg');
      expect(res.text).toContain('>21:00<');
      expect(res.text).toContain('uso contínuo');
      expect(res.text).toContain('<title>Meus remédios · Lembrete de Medicamentos</title>');
    });

    it('é alcançável pela navegação de todas as telas internas', async () => {
      for (const rota of ['/doses/hoje', '/historico', '/medicamentos']) {
        const res = await request(http).get(rota).set('Cookie', owner.cookies).expect(200);
        expect(res.text).toContain('href="/medicamentos"');
        expect(res.text).toContain('id="bottom-nav"');
      }
    });

    it('não mostra remédio de outro usuário', async () => {
      const res = await request(http)
        .get('/medicamentos')
        .set('Cookie', intruder.cookies)
        .expect(200);

      expect(res.text).not.toContain('Metformina');
      expect(res.text).toContain('Nenhum remédio cadastrado');
    });
  });

  /**
   * O elo que faltava: o back-end despachava a dose no horário e nada chegava
   * ao aparelho, porque nenhuma inscrição existia. Estes testes fixam o
   * contrato entre `/js/push.js` e a rota — e a presença do próprio script.
   */
  describe('inscrição em notificações', () => {
    const inscricao = (over: Record<string, string> = {}) => ({
      endpoint: 'https://fcm.example/aparelho-do-adonis',
      p256dh: 'BNc...chave-publica-do-navegador',
      auth: 'segredo-de-autenticacao',
      ...over,
    });

    it('entrega a chave VAPID pública que o navegador precisa', async () => {
      const res = await request(http)
        .get('/push/chave-publica')
        .set('Cookie', principal.cookies)
        .set('Accept', 'application/json')
        .expect(200);

      expect(typeof res.body.key).toBe('string');
      expect(res.body.key.length).toBeGreaterThan(0);
    });

    it('aceita a inscrição no formato achatado que o cliente envia', async () => {
      const res = await request(http)
        .post('/push/inscrever')
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .send(inscricao())
        .expect(201);

      expect(typeof res.body.id).toBe('string');
    });

    // O navegador reinscreve a cada visita com o mesmo endpoint — que é único
    // na tabela. Sem upsert, a segunda visita respondia 500.
    it('aceita a reinscrição do mesmo aparelho', async () => {
      await request(http)
        .post('/push/inscrever')
        .set('Cookie', principal.cookies)
        .set('X-CSRF-Token', principal.csrfToken)
        .set('Accept', 'application/json')
        .send(inscricao({ p256dh: 'chave-renovada' }))
        .expect(201);
    });

    it('exige sessão para inscrever um aparelho', async () => {
      await request(http)
        .post('/push/inscrever')
        .set('Accept', 'application/json')
        .send(inscricao())
        .expect(403); // CSRF barra antes mesmo da sessão
    });

    it('serve o script que faz a inscrição, e o layout o carrega', async () => {
      const js = await request(http).get('/js/push.js').expect(200);
      expect(js.headers['content-type']).toContain('javascript');
      expect(js.text).toContain('pushManager.subscribe');
      expect(js.text).toContain('/push/inscrever');

      const dashboard = await request(http)
        .get('/doses/hoje')
        .set('Cookie', principal.cookies)
        .expect(200);
      expect(dashboard.text).toContain('src="/js/push.js"');
      expect(dashboard.text).toContain('id="push-banner"');
      expect(dashboard.text).toContain('id="push-enable"');
    });
  });

  describe('rate limiting (ADR-001 §2.4)', () => {
    it('bloqueia tentativas repetidas de login com 429', async () => {
      const cookie = getCookie(await request(http).get('/login'), 'csrf_token')!;
      const attemptLogin = () =>
        request(http)
          .post('/auth/login')
          .set('Cookie', cookie)
          .type('form')
          .send({
            _csrf: cookieValue(cookie),
            email: 'forca-bruta@example.com',
            password: 'chute-errado-1',
          });

      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await attemptLogin()).status);

      // As cinco primeiras falham por credencial; as seguintes, por limite.
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.slice(5)).toEqual([429, 429]);
    });

    it('não aplica o limite estrito à navegação comum', async () => {
      for (let i = 0; i < 8; i++) await request(http).get('/login').expect(200);
    });
  });
});
