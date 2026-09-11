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

  describe('range', () => {
    it('repete o bloco a quantidade pedida', () => {
      expect(compile('{{#each (range 3)}}x{{/each}}')({})).toBe('xxx');
    });

    it('expõe o índice de cada repetição', () => {
      expect(compile('{{#each (range 3)}}{{this}}{{/each}}')({})).toBe('012');
    });

    it('não repete nada para zero ou negativo', () => {
      expect(compile('{{#each (range 0)}}x{{/each}}')({})).toBe('');
      expect(compile('{{#each (range -5)}}x{{/each}}')({})).toBe('');
    });

    it('ignora valor não numérico em vez de lançar', () => {
      expect(compile('{{#each (range "quatro")}}x{{/each}}')({})).toBe('');
    });

    it('limita a repetição para não travar a renderização', () => {
      expect(compile('{{#each (range 100000)}}x{{/each}}')({}).length).toBe(100);
    });
  });

  describe('date', () => {
    it('converte a data ISO persistida para o formato brasileiro', () => {
      expect(compile('{{date d}}')({ d: '2026-08-30' })).toBe('30/08/2026');
    });

    // Melhor mostrar o valor cru do banco do que "Invalid Date" no meio da
    // página: o dado continua legível e o defeito fica visível.
    it('devolve o valor original quando não é uma data ISO', () => {
      expect(compile('{{date d}}')({ d: 'uso contínuo' })).toBe('uso contínuo');
    });

    it('não imprime nada para valor ausente', () => {
      expect(compile('{{date d}}')({})).toBe('');
      expect(compile('{{date d}}')({ d: null })).toBe('');
    });

    it('escapa o valor recebido', () => {
      expect(compile('{{date d}}')({ d: '<b>x</b>' })).toBe('&lt;b&gt;x&lt;/b&gt;');
    });
  });
});
