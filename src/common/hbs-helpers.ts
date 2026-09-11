import type * as Handlebars from 'handlebars';

/**
 * Helpers de view registrados no Handlebars.
 *
 * `eq` existe para ramificar sobre o enum de status de `dose_logs`
 * (PENDING | TAKEN | SKIPPED | MISSED | CANCELED), definido no ADR-001 §2.2.
 * O Handlebars não possui comparação de igualdade nativa.
 */
export function registerHbsHelpers(hbs: typeof Handlebars): void {
  hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);

  // Repete um bloco N vezes — usado para os campos de horário do formulário.
  hbs.registerHelper('range', (n: unknown) => {
    const total = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
    return Array.from({ length: Math.min(total, 100) }, (_, i) => i);
  });

  /**
   * Datas de tratamento são persistidas como "YYYY-MM-DD" (data local, sem
   * fuso — ADR-001 §2.2). Na tela elas aparecem no formato brasileiro.
   * Valor fora do formato passa adiante sem conversão, em vez de virar
   * "Invalid Date" no meio da página.
   */
  hbs.registerHelper('date', (value: unknown) => {
    if (typeof value !== 'string') return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
  });
}
