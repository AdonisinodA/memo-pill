import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Handlebars from 'handlebars';
import * as cheerio from 'cheerio';
import { registerHbsHelpers } from '../src/common/hbs-helpers';

const TEMPLATE = readFileSync(
  join(__dirname, '..', 'views', 'dashboard.hbs'),
  'utf8',
);

const CSRF = 'csrf-token-de-teste';

type Dose = {
  id: string;
  nome: string;
  dosagem: string;
  horario: string;
  horarioISO: string;
  status: 'PENDING' | 'TAKEN' | 'SKIPPED' | 'MISSED' | 'CANCELED';
};

const dose = (over: Partial<Dose> = {}): Dose => ({
  id: 'dose-1',
  nome: 'Losartana',
  dosagem: '50 mg — 1 comprimido',
  horario: '08:00',
  horarioISO: '2026-08-30T11:00:00Z',
  status: 'PENDING',
  ...over,
});

function render(model: Record<string, unknown> = {}) {
  const hbs = Handlebars.create();
  registerHbsHelpers(hbs);
  const html = hbs.compile(TEMPLATE)({
    usuario: { nome: 'Adonis' },
    dataAtual: 'sábado, 30 de agosto',
    csrfToken: CSRF,
    medicamentos: [dose()],
    ...model,
  });
  return cheerio.load(html);
}

describe('dashboard.hbs', () => {
  describe('cabeçalho', () => {
    it('exibe a saudação com o nome do usuário e a data', () => {
      const $ = render();
      expect($('h1').text()).toContain('Olá, Adonis');
      expect($('main p').first().text()).toContain('sábado, 30 de agosto');
    });

    it('escapa HTML no nome do usuário (ADR-001 §2.4 — mitigação de XSS)', () => {
      const $ = render({ usuario: { nome: '<img src=x onerror=alert(1)>' } });
      expect($('h1 img')).toHaveLength(0);
      expect($('h1').html()).toContain('&lt;img');
    });

    it('escapa HTML no nome do medicamento', () => {
      const $ = render({
        medicamentos: [dose({ nome: '<script>alert(1)</script>' })],
      });
      expect($('script')).toHaveLength(0);
      expect($('article h3').html()).toContain('&lt;script&gt;');
    });
  });

  describe('layout responsivo', () => {
    it('mantém a sidebar oculta no mobile e fixa em w-64 no desktop', () => {
      const cls = render()('aside').attr('class') ?? '';
      expect(cls).toContain('hidden');
      expect(cls).toContain('md:flex');
      expect(cls).toContain('w-64');
      expect(cls).toContain('fixed');
      expect(cls).toContain('left-0');
      expect(cls).toContain('h-screen');
    });

    it('desloca o main para não ficar sob a sidebar no desktop', () => {
      expect(render()('main').attr('class')).toContain('md:ml-64');
    });

    it('mantém a bottom bar fixa no rodapé e oculta no desktop', () => {
      const cls = render()('#bottom-nav').attr('class') ?? '';
      expect(cls).toContain('fixed');
      expect(cls).toContain('bottom-0');
      expect(cls).toContain('w-full');
      expect(cls).toContain('bg-white');
      expect(cls).toContain('md:hidden');
    });

    it('reserva espaço no rodapé do main para a bottom bar não cobrir conteúdo', () => {
      const cls = render()('main').attr('class') ?? '';
      expect(cls).toMatch(/\bpb-32\b/);
    });

    it('usa grade de 1/2/3 colunas conforme o breakpoint', () => {
      const cls = render()('div.grid').attr('class') ?? '';
      expect(cls).toContain('grid-cols-1');
      expect(cls).toContain('md:grid-cols-2');
      expect(cls).toContain('lg:grid-cols-3');
    });
  });

  describe('bottom navigation', () => {
    it('tem exatamente três itens: Hoje, FAB e Histórico', () => {
      const $ = render();
      expect($('#bottom-nav li')).toHaveLength(3);
      expect($('#bottom-nav a[href="/doses/hoje"]').text()).toContain('Hoje');
      expect($('#bottom-nav a[href="/historico"]').text()).toContain('Histórico');
    });

    it('destaca o FAB central deslocado para cima', () => {
      const fab = render()('#bottom-nav a[href="/medicamentos/novo"]');
      const cls = fab.attr('class') ?? '';
      expect(cls).toContain('-mt-8');
      expect(cls).toContain('rounded-full');
      expect(cls).toContain('bg-teal-600');
      expect(fab.attr('aria-label')).toBe('Adicionar remédio');
    });
  });

  describe('card PENDING', () => {
    it('usa fundo branco, cantos arredondados e borda lateral teal', () => {
      const cls = render()('article').attr('class') ?? '';
      expect(cls).toContain('bg-white');
      expect(cls).toContain('rounded-2xl');
      expect(cls).toContain('shadow-sm');
      expect(cls).toContain('border-l-4');
      expect(cls).toContain('border-teal-500');
    });

    it('mostra horário em destaque, nome e dosagem', () => {
      const $ = render();
      const hora = $('article time');
      expect(hora.text()).toBe('08:00');
      expect(hora.attr('class')).toContain('text-3xl');
      expect(hora.attr('datetime')).toBe('2026-08-30T11:00:00Z');
      expect($('article h3').text()).toBe('Losartana');
      expect($('article p').text()).toBe('50 mg — 1 comprimido');
    });

    it('oferece o botão "Tomei" apontando para a rota de confirmação', () => {
      const $ = render();
      const form = $('form[action="/doses/dose-1/taken"]');
      expect(form).toHaveLength(1);
      expect(form.attr('method')).toBe('post');
      const botao = form.find('button[type="submit"]');
      expect(botao.text().trim()).toBe('Tomei');
      expect(botao.attr('class')).toContain('bg-teal-600');
    });

    it('oferece a ação de pular, coerente com o status SKIPPED do ADR', () => {
      expect(render()('form[action="/doses/dose-1/skipped"]')).toHaveLength(1);
    });
  });

  describe('card TAKEN', () => {
    const $ = () => render({ medicamentos: [dose({ status: 'TAKEN' })] });

    it('usa fundo acinzentado e opacidade reduzida', () => {
      const cls = $()('article').attr('class') ?? '';
      expect(cls).toContain('bg-slate-100');
      expect(cls).toContain('opacity-60');
    });

    it('não apresenta nenhum botão de ação', () => {
      expect($()('article button')).toHaveLength(0);
      expect($()('article form')).toHaveLength(0);
    });

    it('substitui a ação por um ícone de check em teal-600', () => {
      const marca = $()('article svg').parent();
      expect(marca.attr('class')).toContain('text-teal-600');
      expect(marca.text()).toContain('Tomado');
    });
  });

  describe('demais status do enum (ADR-001 §2.2)', () => {
    it('renderiza MISSED como não registrado, sem ação', () => {
      const $ = render({ medicamentos: [dose({ status: 'MISSED' })] });
      expect($('article').attr('class')).toContain('border-amber-400');
      expect($('article').text()).toContain('Não registrado');
      expect($('article button')).toHaveLength(0);
    });

    it('renderiza SKIPPED como pulado, sem ação', () => {
      const $ = render({ medicamentos: [dose({ status: 'SKIPPED' })] });
      expect($('article').text()).toContain('Pulado');
      expect($('article button')).toHaveLength(0);
    });

    it('renderiza um card por dose quando há vários status na mesma lista', () => {
      const $ = render({
        medicamentos: [
          dose({ id: 'a', status: 'PENDING' }),
          dose({ id: 'b', status: 'TAKEN' }),
          dose({ id: 'c', status: 'MISSED' }),
          dose({ id: 'd', status: 'SKIPPED' }),
        ],
      });
      expect($('article')).toHaveLength(4);
      expect($('form[action="/doses/a/taken"]')).toHaveLength(1);
      expect($('form[action="/doses/b/taken"]')).toHaveLength(0);
    });
  });

  describe('proteção CSRF (ADR-001 §2.4)', () => {
    it('inclui o token em todo formulário renderizado', () => {
      const $ = render();
      const forms = $('form');
      expect(forms.length).toBeGreaterThan(0);
      forms.each((_, el) => {
        expect($(el).find('input[name="_csrf"]').attr('value')).toBe(CSRF);
      });
    });

    it('mantém o token acessível de dentro do #each via @root', () => {
      const $ = render({
        medicamentos: [dose({ id: 'x' }), dose({ id: 'y' })],
      });
      expect($('input[name="_csrf"]')).toHaveLength(4);
    });
  });

  describe('estado vazio', () => {
    it('convida ao cadastro quando não há doses no dia', () => {
      const $ = render({ medicamentos: [] });
      expect($('article')).toHaveLength(0);
      expect($('div.grid').text()).toContain('Nenhuma dose para hoje');
      expect($('a[href="/medicamentos/novo"]').length).toBeGreaterThan(0);
    });
  });
});
