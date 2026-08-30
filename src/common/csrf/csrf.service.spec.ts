import { CsrfService } from './csrf.service';

describe('CsrfService', () => {
  const csrf = new CsrfService();

  describe('gerar', () => {
    it('produz token hexadecimal de 256 bits', () => {
      expect(csrf.generate()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('não repete o token entre chamadas', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => csrf.generate()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('conferir', () => {
    it('aceita quando cookie e pedido coincidem', () => {
      const token = csrf.generate();
      expect(csrf.matches(token, token)).toBe(true);
    });

    it('recusa token diferente', () => {
      expect(csrf.matches(csrf.generate(), csrf.generate())).toBe(false);
    });

    it('recusa quando o cookie não existe', () => {
      expect(csrf.matches(undefined, 'qualquer')).toBe(false);
    });

    it('recusa quando o pedido não traz token', () => {
      expect(csrf.matches(csrf.generate(), undefined)).toBe(false);
    });

    it('recusa token de comprimento diferente sem lançar', () => {
      const token = csrf.generate();
      expect(csrf.matches(token, token.slice(0, 10))).toBe(false);
    });

    it('recusa valores que não são string', () => {
      const token = csrf.generate();
      expect(csrf.matches(token, 42)).toBe(false);
      expect(csrf.matches(token, { toString: () => token })).toBe(false);
    });

    it('recusa string vazia dos dois lados', () => {
      expect(csrf.matches('', '')).toBe(false);
    });
  });
});
