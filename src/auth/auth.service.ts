import {
  ConflictException, Inject, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { User } from '../users/user.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';

export const BCRYPT_ROUNDS = Symbol('BCRYPT_ROUNDS');

/** Access token de curta duração (ADR-001 §2.4): vive só em memória no cliente. */
export const ACCESS_TTL_SEG = 15 * 60;
/** Refresh token de longa duração: cookie HttpOnly, Secure, SameSite=Lax. */
export const REFRESH_TTL_SEG = 30 * 24 * 3600;

export interface Session {
  user: User;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(BCRYPT_ROUNDS) private readonly rounds: number,
  ) {}

  async register(dto: RegisterDto): Promise<Session> {
    const email = dto.email.trim().toLowerCase();
    if (await this.users.findOneBy({ email })) {
      throw new ConflictException('E-mail já cadastrado');
    }

    const user = await this.users.save(
      this.users.create({
        email,
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, this.rounds),
        timezone: dto.timezone ?? 'America/Sao_Paulo',
        consentAt: this.clock.nowSeconds(),
      }),
    );
    return this.openSession(user);
  }

  async login(dto: LoginDto): Promise<Session> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.users.findOneBy({ email });

    // Compara mesmo sem usuário, para o tempo de resposta não revelar
    // quais e-mails existem na base.
    const hash = user?.passwordHash ?? (await this.throwawayHash());
    const matches = await bcrypt.compare(dto.password, hash);

    if (!user || !matches) throw new UnauthorizedException('Credenciais inválidas');
    return this.openSession(user);
  }

  /** Troca o refresh token por um novo access token de curta duração. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; user: User }> {
    const user = await this.userFromToken(refreshToken);
    return { accessToken: await this.sign(user, 'access'), user };
  }

  /** Resolve o usuário a partir do refresh token do cookie. */
  async userFromToken(token: string): Promise<User> {
    let payload: { sub: string; kind: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Sessão inválida ou expirada');
    }
    if (payload.kind !== 'refresh') {
      throw new UnauthorizedException('Token de tipo inesperado');
    }

    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException('Sessão inválida ou expirada');
    return user;
  }

  private async openSession(user: User): Promise<Session> {
    return {
      user,
      accessToken: await this.sign(user, 'access'),
      refreshToken: await this.sign(user, 'refresh'),
    };
  }

  private sign(user: User, kind: 'access' | 'refresh'): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, kind },
      { expiresIn: kind === 'access' ? ACCESS_TTL_SEG : REFRESH_TTL_SEG },
    );
  }

  private throwawayHash(): Promise<string> {
    return bcrypt.hash('senha-inexistente', this.rounds);
  }
}
