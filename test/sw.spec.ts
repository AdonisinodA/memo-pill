import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const SW = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

type Listeners = Record<string, (event: unknown) => void>;

interface Notificacao {
  titulo: unknown;
  opcoes: Record<string, unknown>;
}

/**
 * Executa o Service Worker de verdade num sandbox, com `self` e `fetch`
 * falsos. É o único jeito de cobrir o que o usuário vê na tela de bloqueio:
 * o texto da notificação nasce aqui, e não em nenhum módulo do servidor.
 */
function carregarSw(resumo?: unknown, ok = true) {
  const listeners: Listeners = {};
  const notificacoes: Notificacao[] = [];
  const janelasAbertas: string[] = [];
  const enviados: { url: string; options?: RequestInit }[] = [];

  const fetchFalso = (url: string, options?: RequestInit) => {
    enviados.push({ url, options });
    if (url === '/csrf') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ csrfToken: 'tok' }) });
    }
    return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(resumo) });
  };

  const self = {
    addEventListener: (nome: string, fn: (event: unknown) => void) => {
      listeners[nome] = fn;
    },
    skipWaiting: jest.fn(),
    clients: {
      claim: jest.fn(() => Promise.resolve()),
      openWindow: (url: string) => {
        janelasAbertas.push(url);
        return Promise.resolve();
      },
    },
    registration: {
      showNotification: (titulo: unknown, opcoes: Record<string, unknown>) => {
        notificacoes.push({ titulo, opcoes });
        return Promise.resolve();
      },
    },
  };

  const contexto = createContext({ self, fetch: fetchFalso, console });
  runInContext(SW, contexto);

  /** Dispara um evento e espera o trabalho que ele registrou em waitUntil. */
  const disparar = async (nome: string, event: Record<string, unknown>) => {
    let trabalho: Promise<unknown> = Promise.resolve();
    listeners[nome]({ ...event, waitUntil: (p: Promise<unknown>) => (trabalho = p) });
    await trabalho;
  };

  return { self, listeners, notificacoes, janelasAbertas, enviados, disparar };
}

const pushDe = (doseId: string | null) => ({
  data: doseId === null ? null : { json: () => ({ doseId }) },
});

describe('sw.js', () => {
  /**
   * O bug que chegou ao usuário: o SW lia `dose.nome`, a rota devolve `name`,
   * e a tela de bloqueio exibiu "undefined" como nome do remédio.
   */
  describe('texto da notificação', () => {
    it('usa os campos que /doses/:id/resumo realmente devolve', async () => {
      const sw = carregarSw({
        id: 'dose-1',
        name: 'Losartana',
        dosage: '50 mg',
        time: '19:58',
      });
      await sw.disparar('push', pushDe('dose-1'));

      expect(sw.notificacoes[0].titulo).toBe('Losartana');
      expect(sw.notificacoes[0].opcoes.body).toBe('50 mg · 19:58');
    });

    it.each([
      ['resumo sem o campo do nome', { dosage: '50 mg', time: '19:58' }],
      ['nome nulo', { name: null, dosage: '50 mg' }],
      ['nome vazio', { name: '   ', dosage: '50 mg' }],
      ['resposta que não é objeto', 'texto solto'],
    ])('nunca escreve "undefined" no título (%s)', async (_, resumo) => {
      const sw = carregarSw(resumo);
      await sw.disparar('push', pushDe('dose-1'));

      expect(sw.notificacoes[0].titulo).toBe('Hora do seu medicamento');
      expect(String(sw.notificacoes[0].titulo)).not.toContain('undefined');
    });

    it('cai no texto genérico quando o resumo falha', async () => {
      const sw = carregarSw(undefined, false);
      await sw.disparar('push', pushDe('dose-1'));

      expect(sw.notificacoes[0].titulo).toBe('Hora do seu medicamento');
      expect(sw.notificacoes[0].opcoes.body).toBe('Toque para ver os detalhes.');
    });

    it('notifica mesmo sem identificador no payload', async () => {
      const sw = carregarSw();
      await sw.disparar('push', pushDe(null));

      expect(sw.notificacoes).toHaveLength(1);
      expect(sw.enviados).toHaveLength(0);
    });

    it('oferece as ações de tomar e pular', async () => {
      const sw = carregarSw({ name: 'Losartana', dosage: '50 mg', time: '19:58' });
      await sw.disparar('push', pushDe('dose-1'));

      expect(sw.notificacoes[0].opcoes.actions).toEqual([
        { action: 'taken', title: 'Tomei' },
        { action: 'skipped', title: 'Pular' },
      ]);
    });

    // Dado de saúde não trafega pelo push service: o payload traz só o id, e o
    // nome é resolvido aqui, na própria origem (ADR-001 §2.4).
    it('resolve o nome na própria origem, com a sessão do usuário', async () => {
      const sw = carregarSw({ name: 'Losartana' });
      await sw.disparar('push', pushDe('dose-1'));

      expect(sw.enviados[0].url).toBe('/doses/dose-1/resumo');
      expect(sw.enviados[0].options).toMatchObject({ credentials: 'include' });
    });
  });

  /**
   * Sem isto a versão nova fica em `waiting` enquanto houver aba aberta — e
   * quem monta a notificação é o SW, então a correção não chega ao usuário.
   */
  describe('atualização da versão', () => {
    it('assume o controle sem esperar as abas fecharem', async () => {
      const sw = carregarSw();

      await sw.disparar('install', {});
      expect(sw.self.skipWaiting).toHaveBeenCalled();

      await sw.disparar('activate', {});
      expect(sw.self.clients.claim).toHaveBeenCalled();
    });
  });

  describe('clique na notificação', () => {
    const clique = (action: string, doseId: string | null = 'dose-1') => ({
      action,
      notification: { data: { doseId }, close: jest.fn() },
    });

    it('registra a dose direto da ação, com o token CSRF do momento', async () => {
      const sw = carregarSw();
      await sw.disparar('notificationclick', clique('taken'));

      expect(sw.enviados.map((e) => e.url)).toEqual([
        '/csrf',
        '/doses/dose-1/taken',
      ]);
      expect(sw.enviados[1].options).toMatchObject({ method: 'POST' });
      expect(sw.janelasAbertas).toHaveLength(0);
    });

    it('abre o app quando o clique não é numa ação', async () => {
      const sw = carregarSw();
      await sw.disparar('notificationclick', clique(''));

      expect(sw.janelasAbertas).toEqual(['/doses/hoje']);
    });

    it('abre o app para o usuário concluir à mão se o registro falhar', async () => {
      // A falha é o próprio caso de teste; o log dela só polui a saída.
      jest.spyOn(console, 'error').mockImplementation();
      const sw = carregarSw(undefined, false);
      await sw.disparar('notificationclick', clique('taken'));

      expect(sw.janelasAbertas).toEqual(['/doses/hoje']);
    });
  });
});
