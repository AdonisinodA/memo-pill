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
import { RevokedToken } from './revoked-token.entity';

const NOW = sec('2026-08-30T12:00:00Z');

describe('AuthService', () => {
  let ds: DataSource;
  let service: AuthService;
  let jwt: JwtService;
  let clock: FixedClock;

  const registration = {
    email: 'Adonis@Example.com ',
    password: 'senha-bem-longa-1',
    name: 'Adonis',
    consent: true as const,
  };

  beforeEach(async () => {
    ds = await createTestDataSource();
    clock = new FixedClock(NOW);
    const mod = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'segredo-de-teste' })],
      providers: [
        AuthService,
        { provide: Clock, useValue: clock },
        { provide: BCRYPT_ROUNDS, useValue: 4 }, // custo baixo só no teste
        { provide: getRepositoryToken(User), useValue: ds.getRepository(User) },
        {
          provide: getRepositoryToken(RevokedToken),
          useValue: ds.getRepository(RevokedToken),
        },
      ],
    }).compile();

    service = mod.get(AuthService);
    jwt = mod.get(JwtService);
  });

  afterEach(() => ds.destroy());

  /**
   * O refresh token é um JWT de 30 dias: assinado, vale por si só, e apagar o
   * cookie no navegador não o desfaz. Sem revogação no servidor, uma cópia do
   * token continuaria abrindo a conta por um mês depois do "Sair".
   */
  describe('sair', () => {
    const abrirSessao = () => service.register(registration);

    it('recusa o token revogado, mesmo com assinatura válida', async () => {
      const { refreshToken } = await abrirSessao();
      expect(await service.userFromToken(refreshToken)).toBeDefined();

      await service.logout(refreshToken);

      await expect(service.userFromToken(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('não derruba as outras sessões do mesmo usuário', async () => {
      const primeira = await abrirSessao();
      const segunda = await service.login({
        email: registration.email,
        password: registration.password,
      });

      await service.logout(primeira.refreshToken);

      await expect(service.userFromToken(primeira.refreshToken)).rejects.toThrow();
      expect(await service.userFromToken(segunda.refreshToken)).toBeDefined();
    });

    // Sair tem que ser idempotente: com a sessão já vencida, ou clicando duas
    // vezes, o desfecho é o mesmo — e nunca um erro na cara do usuário.
    it.each([
      ['token ausente', undefined],
      ['token ilegível', 'nada-disso-e-um-jwt'],
      ['token assinado por outra chave', null],
    ])('não lança para %s', async (_, token) => {
      const invalido =
        token === null
          ? new JwtService({ secret: 'outra-chave' }).sign({ sub: 'x', kind: 'refresh' })
          : token;

      await expect(service.logout(invalido as string | undefined)).resolves.toBeNull();
    });

    it('aceita ser chamado duas vezes para o mesmo token', async () => {
      const { refreshToken } = await abrirSessao();

      await service.logout(refreshToken);
      await expect(service.logout(refreshToken)).resolves.not.toThrow();
      expect(await ds.getRepository(RevokedToken).count()).toBe(1);
    });

    it('guarda o vencimento do token para permitir a limpeza depois', async () => {
      const { refreshToken } = await abrirSessao();
      await service.logout(refreshToken);

      const [revogado] = await ds.getRepository(RevokedToken).find();
      const { exp } = jwt.decode(refreshToken) as { exp: number };
      expect(revogado.expiresAt).toBe(exp);
      expect(revogado.revokedAt).toBe(NOW);
    });
  });

  describe('sair de todos os aparelhos', () => {
    it('invalida todas as sessões abertas até agora', async () => {
      const primeira = await service.register(registration);
      const segunda = await service.login({
        email: registration.email,
        password: registration.password,
      });

      clock.advance(60);
      await service.logoutAllDevices(primeira.user.id);

      await expect(service.userFromToken(primeira.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.userFromToken(segunda.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // Sem isto o usuário não conseguiria voltar a entrar: o token novo cairia
    // na mesma invalidação que derrubou os antigos.
    it('deixa valer a sessão aberta depois de sair', async () => {
      const { user } = await service.register(registration);
      await service.logoutAllDevices(user.id);

      clock.advance(60);
      const nova = await service.login({
        email: registration.email,
        password: registration.password,
      });

      expect(await service.userFromToken(nova.refreshToken)).toBeDefined();
    });

    /**
     * O motivo de a invalidação ser um contador, e não um instante de corte.
     * Com timestamp, sair e entrar dentro do mesmo segundo deixava o token
     * velho passar (`iat < corte` é falso quando os dois são iguais) e ainda
     * arriscava barrar o token novo.
     */
    it('não depende do relógio: sair e entrar no mesmo segundo funciona', async () => {
      const antiga = await service.register(registration);

      await service.logoutAllDevices(antiga.user.id);
      const nova = await service.login({
        email: registration.email,
        password: registration.password,
      });

      await expect(service.userFromToken(antiga.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(await service.userFromToken(nova.refreshToken)).toBeDefined();
    });

    it('não invalida a mesma sessão duas vezes sem motivo', async () => {
      const { user } = await service.register(registration);

      await service.logoutAllDevices(user.id);
      await service.logoutAllDevices(user.id);

      const { sessionsVersion } = await ds
        .getRepository(User)
        .findOneByOrFail({ id: user.id });
      expect(sessionsVersion).toBe(2);
    });

    it('não afeta as sessões de outro usuário', async () => {
      const alheia = await service.register({
        ...registration,
        email: 'outro@example.com',
      });
      const minha = await service.register(registration);

      clock.advance(60);
      await service.logoutAllDevices(minha.user.id);

      expect(await service.userFromToken(alheia.refreshToken)).toBeDefined();
    });
  });

  describe('limpeza das revogações', () => {
    it('descarta a revogação de token que já venceu sozinho', async () => {
      const { refreshToken } = await service.register(registration);
      await service.logout(refreshToken);

      // Um segundo além do `exp` do próprio token.
      const { exp } = jwt.decode(refreshToken) as { exp: number };
      clock.set(exp + 1);

      expect(await service.purgeExpiredRevocations()).toBe(1);
      expect(await ds.getRepository(RevokedToken).count()).toBe(0);
    });

    it('preserva a revogação de token ainda vigente', async () => {
      const { refreshToken } = await service.register(registration);
      await service.logout(refreshToken);

      clock.advance(86_400);

      expect(await service.purgeExpiredRevocations()).toBe(0);
      await expect(service.userFromToken(refreshToken)).rejects.toThrow();
    });
  });

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
