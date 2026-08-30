import * as Handlebars from 'handlebars';
import { registerHbsHelpers } from './hbs-helpers';

describe('registerHbsHelpers', () => {
  const compile = (tpl: string) => {
    const hbs = Handlebars.create();
    registerHbsHelpers(hbs);
    return hbs.compile(tpl);
  };

  describe('eq', () => {
    it('resolve verdadeiro para strings iguais', () => {
      expect(compile('{{#if (eq a b)}}sim{{else}}não{{/if}}')({ a: 'TAKEN', b: 'TAKEN' })).toBe('sim');
    });

    it('resolve falso para strings diferentes', () => {
      expect(compile('{{#if (eq a b)}}sim{{else}}não{{/if}}')({ a: 'TAKEN', b: 'PENDING' })).toBe('não');
    });

    it('compara por identidade estrita, sem coerção de tipo', () => {
      expect(compile('{{#if (eq a b)}}sim{{else}}não{{/if}}')({ a: 1, b: '1' })).toBe('não');
    });

    it('trata ausência de valor sem lançar', () => {
      expect(compile('{{#if (eq a "PENDING")}}sim{{else}}não{{/if}}')({})).toBe('não');
    });
  });
});
