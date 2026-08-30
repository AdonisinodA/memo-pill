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
}
