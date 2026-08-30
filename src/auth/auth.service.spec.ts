import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { User } from '../users/user.entity';
import { createTestDataSource } from '../../test/helpers/db';
import { sec } from '../../test/helpers/fixtures';
import { AuthService, BCRYPT_ROUNDS } from './auth.service';

const NOW = sec('2026-08-30T12:00:00Z');

describe('AuthService', () => {
  let ds: DataSource;
  let service: AuthService;
  let jwt: JwtService;

  const registration = {
    email: 'Adonis@Example.com ',
    password: 'senha-bem-longa-1',
    name: 'Adonis',
    consent: true as const,
  };

  beforeEach(async () => {
    ds = await createTestDataSource();
    const mod = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'segredo-de-teste' })],
      providers: [
        AuthService,
        { provide: Clock, useValue: new FixedClock(NOW) },
        { provide: BCRYPT_ROUNDS, useValue: 4 }, // custo baixo só no teste
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
      ],
    }).compile();

    service = mod.get(AuthService);
    jwt = mod.get(JwtService);
  });

  afterEach(() => ds.destroy());

  describe('registrar', () => {
    it('nunca persiste a senha em claro', async () => {
      const { user } = await service.register(registration);
      const stored = await ds.getRepository(User).findOneByOrFail({ id: user.id });

      expect(stored.passwordHash).not.toBe(registration.password);
      expect(stored.passwordHash).toMatch(/^\$2[aby]\$/); // formato bcrypt
      expect(JSON.stringify(stored)).not.toContain(registration.password);
    });

    it('gera hash verificável pelo bcrypt', async () => {
      const { user } = await service.register(registration);
      await expect(bcrypt.compare(registration.password, user.passwordHash)).resolves.toBe(true);
    });

    it('produz hashes diferentes para a mesma senha (salt por usuário)', async () => {
      const a = await service.register(registration);
      const b = await service.register({ ...registration, email: 'outro@example.com' });
      expect(a.user.passwordHash).not.toBe(b.user.passwordHash);
    });

    it('normaliza o e-mail para minúsculas e sem espaços', async () => {
      const { user } = await service.register(registration);
      expect(user.email).toBe('adonis@example.com');
    });

    it('carimba o consentimento LGPD no cadastro', async () => {
      const { user } = await service.register(registration);
      expect(user.consentAt).toBe(NOW);
    });

    it('recusa e-mail já cadastrado', async () => {
      await service.register(registration);
      await expect(service.register(registration)).rejects.toThrow(ConflictException);
    });

    it('abre sessão com access e refresh de tipos distintos', async () => {
      const session = await service.register(registration);
      expect(jwt.decode(session.accessToken)).toMatchObject({ kind: 'access' });
      expect(jwt.decode(session.refreshToken)).toMatchObject({ kind: 'refresh' });
    });

    it('emite access token de vida curta e refresh de vida longa', async () => {
      const { accessToken, refreshToken } = await service.register(registration);
      const lifetime = (t: string) => {
        const p = jwt.decode(t) as { exp: number; iat: number };
        return p.exp - p.iat;
      };
      expect(lifetime(accessToken)).toBe(15 * 60);
      expect(lifetime(refreshToken)).toBe(30 * 24 * 3600);
    });
  });

  describe('login', () => {
    beforeEach(() => service.register(registration));

    it('autentica com a senha correta', async () => {
      const session = await service.login({
        email: 'adonis@example.com',
        password: registration.password,
      });
      expect(session.user.email).toBe('adonis@example.com');
    });

    it('aceita e-mail com caixa diferente da cadastrada', async () => {
      await expect(
        service.login({ email: 'ADONIS@EXAMPLE.COM', password: registration.password }),
      ).resolves.toBeDefined();
    });

    it('recusa senha errada', async () => {
      await expect(
        service.login({ email: 'adonis@example.com', password: 'errada12345' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('devolve a mesma mensagem para e-mail inexistente e senha errada', async () => {
      const withoutUser = await service
        .login({ email: 'ninguem@example.com', password: 'x'.repeat(12) })
        .catch((e: Error) => e.message);
      const wrongPassword = await service
        .login({ email: 'adonis@example.com', password: 'x'.repeat(12) })
        .catch((e: Error) => e.message);

      expect(withoutUser).toBe(wrongPassword);
    });
  });

  describe('renovar', () => {
    it('troca refresh válido por novo access token', async () => {
      const { refreshToken } = await service.register(registration);
      const { accessToken } = await service.refresh(refreshToken);
      expect(jwt.decode(accessToken)).toMatchObject({ kind: 'access' });
    });

    it('recusa access token no lugar do refresh', async () => {
      const { accessToken } = await service.register(registration);
      await expect(service.refresh(accessToken)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa token assinado com outro segredo', async () => {
      const intruder = new JwtService({ secret: 'outro-segredo' });
      const forjado = await intruder.signAsync({ sub: 'qualquer', kind: 'refresh' });
      await expect(service.refresh(forjado)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa token de usuário que não existe mais', async () => {
      const { user, refreshToken } = await service.register(registration);
      await ds.getRepository(User).delete({ id: user.id });
      await expect(service.refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa lixo no lugar do token', async () => {
      await expect(service.refresh('não-é-um-jwt')).rejects.toThrow(UnauthorizedException);
    });
  });
});
