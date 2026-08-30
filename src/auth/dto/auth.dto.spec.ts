import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegistrarDto } from './auth.dto';

/** Valida como o ValidationPipe da aplicação faria. */
const validar = (corpo: Record<string, unknown>) =>
  validateSync(plainToInstance(RegistrarDto, corpo), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).flatMap((e) => Object.values(e.constraints ?? {}));

const base = {
  email: 'a@example.com',
  senha: 'senha-bem-longa-1',
  nome: 'Adonis',
};

describe('RegistrarDto', () => {
  describe('consentimento LGPD', () => {
    it.each(['true', 'on', true])(
      'aceita o checkbox marcado chegando como %p',
      (valor) => {
        expect(validar({ ...base, consentimento: valor })).toEqual([]);
      },
    );

    it('recusa quando o checkbox não é enviado (desmarcado)', () => {
      expect(validar(base).join(' ')).toContain('consentimento é obrigatório');
    });

    it('recusa recusa explícita', () => {
      expect(validar({ ...base, consentimento: 'false' }).length).toBeGreaterThan(0);
    });
  });

  describe('senha', () => {
    it('recusa senha curta demais', () => {
      expect(validar({ ...base, senha: 'curta1', consentimento: true }).join(' '))
        .toContain('senha must be longer');
    });

    it('recusa senha acima do limite de 72 bytes do bcrypt', () => {
      expect(
        validar({ ...base, senha: 'a'.repeat(73), consentimento: true }).length,
      ).toBeGreaterThan(0);
    });
  });

  it('recusa e-mail malformado', () => {
    expect(validar({ ...base, email: 'nao-e-email', consentimento: true }).length)
      .toBeGreaterThan(0);
  });

  it('recusa campo fora do DTO, barrando mass assignment', () => {
    expect(
      validar({ ...base, consentimento: true, id: 'forjado' }).join(' '),
    ).toContain('should not exist');
  });
});
