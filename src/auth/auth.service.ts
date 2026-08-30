import {
  ConflictException, Inject, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { User } from '../users/user.entity';
import { LoginDto, RegistrarDto } from './dto/auth.dto';

export const BCRYPT_ROUNDS = Symbol('BCRYPT_ROUNDS');

/** Access token de curta duração (ADR-001 §2.4): vive só em memória no cliente. */
export const ACCESS_TTL_SEG = 15 * 60;
/** Refresh token de longa duração: cookie HttpOnly, Secure, SameSite=Lax. */
export const REFRESH_TTL_SEG = 30 * 24 * 3600;

export interface Sessao {
  user: User;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly usuarios: Repository<User>,
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(BCRYPT_ROUNDS) private readonly rounds: number,
  ) {}

  async registrar(dto: RegistrarDto): Promise<Sessao> {
    const email = dto.email.trim().toLowerCase();
    if (await this.usuarios.findOneBy({ email })) {
      throw new ConflictException('E-mail já cadastrado');
    }

    const user = await this.usuarios.save(
      this.usuarios.create({
        email,
        nome: dto.nome,
        passwordHash: await bcrypt.hash(dto.senha, this.rounds),
        timezone: dto.timezone ?? 'America/Sao_Paulo',
        consentAt: this.clock.nowSeconds(),
      }),
    );
    return this.abrirSessao(user);
  }

  async login(dto: LoginDto): Promise<Sessao> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usuarios.findOneBy({ email });

    // Compara mesmo sem usuário, para o tempo de resposta não revelar
    // quais e-mails existem na base.
    const hash = user?.passwordHash ?? (await this.hashDescartavel());
    const confere = await bcrypt.compare(dto.senha, hash);

    if (!user || !confere) throw new UnauthorizedException('Credenciais inválidas');
    return this.abrirSessao(user);
  }

  /** Troca o refresh token por um novo access token de curta duração. */
  async renovar(refreshToken: string): Promise<{ accessToken: string; user: User }> {
    const user = await this.usuarioDoToken(refreshToken);
    return { accessToken: await this.assinar(user, 'access'), user };
  }

  /** Resolve o usuário a partir do refresh token do cookie. */
  async usuarioDoToken(token: string): Promise<User> {
    let payload: { sub: string; tipo: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Sessão inválida ou expirada');
    }
    if (payload.tipo !== 'refresh') {
      throw new UnauthorizedException('Token de tipo inesperado');
    }

    const user = await this.usuarios.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException('Sessão inválida ou expirada');
    return user;
  }

  private async abrirSessao(user: User): Promise<Sessao> {
    return {
      user,
      accessToken: await this.assinar(user, 'access'),
      refreshToken: await this.assinar(user, 'refresh'),
    };
  }

  private assinar(user: User, tipo: 'access' | 'refresh'): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, tipo },
      { expiresIn: tipo === 'access' ? ACCESS_TTL_SEG : REFRESH_TTL_SEG },
    );
  }

  private hashDescartavel(): Promise<string> {
    return bcrypt.hash('senha-inexistente', this.rounds);
  }
}
