import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto } from './auth.dto';

/** Valida como o ValidationPipe da aplicação faria. */
const validate = (corpo: Record<string, unknown>) =>
  validateSync(plainToInstance(RegisterDto, corpo), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).flatMap((e) => Object.values(e.constraints ?? {}));

const base = {
  email: 'a@example.com',
  password: 'senha-bem-longa-1',
  name: 'Adonis',
};

describe('RegisterDto', () => {
  describe('consentimento LGPD', () => {
    it.each(['true', 'on', true])(
      'aceita o checkbox marcado chegando como %p',
      (value) => {
        expect(validate({ ...base, consent: value })).toEqual([]);
      },
    );

    it('recusa quando o checkbox não é enviado (desmarcado)', () => {
      expect(validate(base).join(' ')).toContain('consentimento é obrigatório');
    });

    it('recusa recusa explícita', () => {
      expect(validate({ ...base, consent: 'false' }).length).toBeGreaterThan(0);
    });
  });

  describe('password', () => {
    it('recusa senha curta demais', () => {
      expect(validate({ ...base, password: 'curta1', consent: true }).join(' '))
        .toContain('password must be longer');
    });

    it('recusa senha acima do limite de 72 bytes do bcrypt', () => {
      expect(
        validate({ ...base, password: 'a'.repeat(73), consent: true }).length,
      ).toBeGreaterThan(0);
    });
  });

  it('recusa e-mail malformado', () => {
    expect(validate({ ...base, email: 'nao-e-email', consent: true }).length)
      .toBeGreaterThan(0);
  });

  it('recusa campo fora do DTO, barrando mass assignment', () => {
    expect(
      validate({ ...base, consent: true, id: 'forjado' }).join(' '),
    ).toContain('should not exist');
  });
});
