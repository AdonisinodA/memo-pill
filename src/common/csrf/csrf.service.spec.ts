import { CsrfService } from './csrf.service';

describe('CsrfService', () => {
  const csrf = new CsrfService();

  describe('gerar', () => {
    it('produz token hexadecimal de 256 bits', () => {
      expect(csrf.gerar()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('não repete o token entre chamadas', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => csrf.gerar()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('conferir', () => {
    it('aceita quando cookie e pedido coincidem', () => {
      const token = csrf.gerar();
      expect(csrf.conferir(token, token)).toBe(true);
    });

    it('recusa token diferente', () => {
      expect(csrf.conferir(csrf.gerar(), csrf.gerar())).toBe(false);
    });

    it('recusa quando o cookie não existe', () => {
      expect(csrf.conferir(undefined, 'qualquer')).toBe(false);
    });

    it('recusa quando o pedido não traz token', () => {
      expect(csrf.conferir(csrf.gerar(), undefined)).toBe(false);
    });

    it('recusa token de comprimento diferente sem lançar', () => {
      const token = csrf.gerar();
      expect(csrf.conferir(token, token.slice(0, 10))).toBe(false);
    });

    it('recusa valores que não são string', () => {
      const token = csrf.gerar();
      expect(csrf.conferir(token, 42)).toBe(false);
      expect(csrf.conferir(token, { toString: () => token })).toBe(false);
    });

    it('recusa string vazia dos dois lados', () => {
      expect(csrf.conferir('', '')).toBe(false);
    });
  });
});
