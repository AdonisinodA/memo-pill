import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { Clock, FixedClock } from '../common/time/clock';
import { User } from '../users/user.entity';
import { criarDataSourceDeTeste } from '../../test/helpers/db';
import { seg } from '../../test/helpers/fixtures';
import { AuthService, BCRYPT_ROUNDS } from './auth.service';

const AGORA = seg('2026-08-30T12:00:00Z');

describe('AuthService', () => {
  let ds: DataSource;
  let service: AuthService;
  let jwt: JwtService;

  const registro = {
    email: 'Adonis@Example.com ',
    senha: 'senha-bem-longa-1',
    nome: 'Adonis',
    consentimento: true as const,
  };

  beforeEach(async () => {
    ds = await criarDataSourceDeTeste();
    const mod = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'segredo-de-teste' })],
      providers: [
        AuthService,
        { provide: Clock, useValue: new FixedClock(AGORA) },
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
      const { user } = await service.registrar(registro);
      const salvo = await ds.getRepository(User).findOneByOrFail({ id: user.id });

      expect(salvo.passwordHash).not.toBe(registro.senha);
      expect(salvo.passwordHash).toMatch(/^\$2[aby]\$/); // formato bcrypt
      expect(JSON.stringify(salvo)).not.toContain(registro.senha);
    });

    it('gera hash verificável pelo bcrypt', async () => {
      const { user } = await service.registrar(registro);
      await expect(bcrypt.compare(registro.senha, user.passwordHash)).resolves.toBe(true);
    });

    it('produz hashes diferentes para a mesma senha (salt por usuário)', async () => {
      const a = await service.registrar(registro);
      const b = await service.registrar({ ...registro, email: 'outro@example.com' });
      expect(a.user.passwordHash).not.toBe(b.user.passwordHash);
    });

    it('normaliza o e-mail para minúsculas e sem espaços', async () => {
      const { user } = await service.registrar(registro);
      expect(user.email).toBe('adonis@example.com');
    });

    it('carimba o consentimento LGPD no cadastro', async () => {
      const { user } = await service.registrar(registro);
      expect(user.consentAt).toBe(AGORA);
    });

    it('recusa e-mail já cadastrado', async () => {
      await service.registrar(registro);
      await expect(service.registrar(registro)).rejects.toThrow(ConflictException);
    });

    it('abre sessão com access e refresh de tipos distintos', async () => {
      const sessao = await service.registrar(registro);
      expect(jwt.decode(sessao.accessToken)).toMatchObject({ tipo: 'access' });
      expect(jwt.decode(sessao.refreshToken)).toMatchObject({ tipo: 'refresh' });
    });

    it('emite access token de vida curta e refresh de vida longa', async () => {
      const { accessToken, refreshToken } = await service.registrar(registro);
      const vida = (t: string) => {
        const p = jwt.decode(t) as { exp: number; iat: number };
        return p.exp - p.iat;
      };
      expect(vida(accessToken)).toBe(15 * 60);
      expect(vida(refreshToken)).toBe(30 * 24 * 3600);
    });
  });

  describe('login', () => {
    beforeEach(() => service.registrar(registro));

    it('autentica com a senha correta', async () => {
      const sessao = await service.login({
        email: 'adonis@example.com',
        senha: registro.senha,
      });
      expect(sessao.user.email).toBe('adonis@example.com');
    });

    it('aceita e-mail com caixa diferente da cadastrada', async () => {
      await expect(
        service.login({ email: 'ADONIS@EXAMPLE.COM', senha: registro.senha }),
      ).resolves.toBeDefined();
    });

    it('recusa senha errada', async () => {
      await expect(
        service.login({ email: 'adonis@example.com', senha: 'errada12345' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('devolve a mesma mensagem para e-mail inexistente e senha errada', async () => {
      const semUsuario = await service
        .login({ email: 'ninguem@example.com', senha: 'x'.repeat(12) })
        .catch((e: Error) => e.message);
      const senhaErrada = await service
        .login({ email: 'adonis@example.com', senha: 'x'.repeat(12) })
        .catch((e: Error) => e.message);

      expect(semUsuario).toBe(senhaErrada);
    });
  });

  describe('renovar', () => {
    it('troca refresh válido por novo access token', async () => {
      const { refreshToken } = await service.registrar(registro);
      const { accessToken } = await service.renovar(refreshToken);
      expect(jwt.decode(accessToken)).toMatchObject({ tipo: 'access' });
    });

    it('recusa access token no lugar do refresh', async () => {
      const { accessToken } = await service.registrar(registro);
      await expect(service.renovar(accessToken)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa token assinado com outro segredo', async () => {
      const intruso = new JwtService({ secret: 'outro-segredo' });
      const forjado = await intruso.signAsync({ sub: 'qualquer', tipo: 'refresh' });
      await expect(service.renovar(forjado)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa token de usuário que não existe mais', async () => {
      const { user, refreshToken } = await service.registrar(registro);
      await ds.getRepository(User).delete({ id: user.id });
      await expect(service.renovar(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('recusa lixo no lugar do token', async () => {
      await expect(service.renovar('não-é-um-jwt')).rejects.toThrow(UnauthorizedException);
    });
  });
});
