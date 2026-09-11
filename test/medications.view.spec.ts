import { renderView } from './helpers/render';

const CSRF = 'csrf-token-de-teste';

type Medication = {
  id: string;
  name: string;
  dosage: string;
  times: string[];
  startsOn: string;
  endsOn: string | null;
  status: 'SCHEDULED' | 'ACTIVE' | 'ENDED';
};

const medication = (over: Partial<Medication> = {}): Medication => ({
  id: 'med-1',
  name: 'Losartana',
  dosage: '50 mg — 1 comprimido',
  times: ['08:00', '20:00'],
  startsOn: '2026-08-30',
  endsOn: null,
  status: 'ACTIVE',
  ...over,
});

const render = (model: Record<string, unknown> = {}) =>
  renderView('medications', {
    csrfToken: CSRF,
    medications: [medication()],
    ...model,
  });

describe('medications.hbs', () => {
  describe('posologia cadastrada', () => {
    it('mostra nome, dosagem e todos os horários', () => {
      const $ = render();
      expect($('li h2').text()).toBe('Losartana');
      expect($('li h2').next().text()).toBe('50 mg — 1 comprimido');

      const horarios = $('li ul li').map((_, el) => $(el).text()).get();
      expect(horarios).toEqual(['08:00', '20:00']);
    });

    it('resume a frequência diária', () => {
      expect(render().root().text()).toContain('2x ao dia');
    });

    it('apresenta as datas no formato brasileiro', () => {
      const $ = render({
        medications: [medication({ startsOn: '2026-08-30', endsOn: '2026-09-15' })],
      });
      expect($('dl').text()).toContain('30/08/2026');
      expect($('dl').text()).toContain('15/09/2026');
    });

    // Sem data de fim o tratamento é contínuo (ADR-001 §2.2) — um campo vazio
    // pareceria cadastro incompleto.
    it('descreve tratamento sem fim como uso contínuo', () => {
      expect(render()('dl').text()).toContain('uso contínuo');
    });

    it('oferece a remoção com o token CSRF', () => {
      const form = render()('form[action="/medicamentos/med-1/remover"]');
      expect(form.attr('method')).toBe('post');
      expect(form.find('input[name="_csrf"]').attr('value')).toBe(CSRF);
    });
  });

  describe('situação do tratamento', () => {
    it.each([
      ['ACTIVE', 'Em uso'],
      ['SCHEDULED', 'A começar'],
      ['ENDED', 'Encerrado'],
    ])('rotula o status %s como "%s"', (status, rotulo) => {
      const $ = render({
        medications: [medication({ status: status as Medication['status'] })],
      });
      expect($('main span.rounded-full').first().text().trim()).toBe(rotulo);
    });
  });

  describe('navegação', () => {
    it('marca "Remédios" como a página corrente', () => {
      const atual = render()('#bottom-nav a[aria-current="page"]');
      expect(atual).toHaveLength(1);
      expect(atual.attr('href')).toBe('/medicamentos');
    });

    it('mantém a sidebar e a barra inferior do app', () => {
      const $ = render();
      expect($('aside')).toHaveLength(1);
      expect($('#bottom-nav')).toHaveLength(1);
    });
  });

  describe('contagem e estado vazio', () => {
    it('concorda o contador com o singular', () => {
      expect(render()('header p').text().trim()).toBe('1 cadastrado');
    });

    it('concorda o contador com o plural', () => {
      const $ = render({
        medications: [medication({ id: 'a' }), medication({ id: 'b' })],
      });
      expect($('header p').text().trim()).toBe('2 cadastrados');
    });

    it('convida ao cadastro quando não há nenhum remédio', () => {
      const $ = render({ medications: [] });
      expect($('main ul > li')).toHaveLength(1);
      expect($('main').text()).toContain('Nenhum remédio cadastrado');
      expect($('a[href="/medicamentos/novo"]').length).toBeGreaterThan(0);
    });
  });

  it('escapa HTML no nome do medicamento (ADR-001 §2.4)', () => {
    const $ = render({
      medications: [medication({ name: '<script>alert(1)</script>' })],
    });
    expect($('script')).toHaveLength(0);
    expect($('li h2').html()).toContain('&lt;script&gt;');
  });
});
