import {
  ConflictException, Inject, Injectable, Logger, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Clock } from '../common/time/clock';
import { User } from '../users/user.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { RevokedToken } from './revoked-token.entity';

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

/** Conteúdo assinado do refresh token. */
interface RefreshPayload {
  sub: string;
  kind: string;
  /** Identificador único desta emissão — a chave da revogação individual. */
  jti?: string;
  /** Geração das sessões do usuário no momento da emissão. */
  ver?: number;
  /** Emissão e expiração, em unix seconds, postas pelo próprio JWT. */
  iat: number;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RevokedToken)
    private readonly revoked: Repository<RevokedToken>,
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(BCRYPT_ROUNDS) private readonly rounds: number,
  ) {}

  async register(dto: RegisterDto): Promise<Session> {
    const email = dto.email.trim().toLowerCase();
    if (await this.users.findOneBy({ email })) {
      throw new ConflictException('Este e-mail já está cadastrado.');
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

    if (!user || !matches) throw new UnauthorizedException('E-mail ou senha incorretos.');
    return this.openSession(user);
  }

  /** Troca o refresh token por um novo access token de curta duração. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; user: User }> {
    const user = await this.userFromToken(refreshToken);
    return { accessToken: await this.sign(user, 'access'), user };
  }

  /**
   * Resolve o usuário a partir do refresh token do cookie.
   *
   * Assinatura válida não basta: o token precisa não ter sido revogado
   * individualmente e ser posterior ao corte de sessões do usuário. As duas
   * checagens são o que faz o "Sair" valer no servidor, e não só no navegador.
   */
  async userFromToken(token: string): Promise<User> {
    const payload = await this.verifyRefresh(token);

    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user) throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');

    // Ausente em token emitido antes desta versão do sistema: tratado como a
    // geração 0, para uma atualização do servidor não deslogar todo mundo.
    if ((payload.ver ?? 0) !== user.sessionsVersion) {
      throw new UnauthorizedException('Sua sessão foi encerrada. Entre novamente.');
    }
    if (payload.jti && (await this.revoked.existsBy({ jti: payload.jti }))) {
      throw new UnauthorizedException('Sua sessão foi encerrada. Entre novamente.');
    }
    return user;
  }

  /**
   * Encerra a sessão DESTE aparelho: o token usado vai para a lista de
   * revogados e morre na hora, sem afetar os outros aparelhos.
   *
   * Não lança para token ausente, expirado ou já revogado — sair precisa ser
   * idempotente. O usuário que clica em "Sair" com a sessão já vencida quer o
   * mesmo resultado de quem clica com ela válida.
   *
   * @returns o dono do token, quando ele ainda era válido.
   */
  async logout(token: string | undefined): Promise<User | null> {
    if (!token) return null;

    let payload: RefreshPayload;
    try {
      payload = await this.verifyRefresh(token);
    } catch {
      return null;
    }

    if (payload.jti) {
      // `orIgnore`: dois cliques em "Sair" não podem virar erro por conta do
      // índice único do jti.
      await this.revoked
        .createQueryBuilder()
        .insert()
        .into(RevokedToken)
        .values({
          jti: payload.jti,
          userId: payload.sub,
          expiresAt: payload.exp,
          revokedAt: this.clock.nowSeconds(),
        })
        .orIgnore()
        .execute();
    }
    return this.users.findOneBy({ id: payload.sub });
  }

  /**
   * Encerra TODAS as sessões do usuário, em qualquer aparelho, avançando a
   * geração das sessões. Todo token já emitido carrega a geração anterior e
   * passa a ser recusado; o próximo login emite um na geração nova e funciona.
   */
  async logoutAllDevices(userId: string): Promise<void> {
    await this.users.increment({ id: userId }, 'sessionsVersion', 1);
  }

  /**
   * Descarta as revogações cujo token já expirou por conta própria: passado o
   * `exp`, a verificação de assinatura recusa o token sozinha e a linha vira
   * peso morto. Sem esta limpeza a tabela só cresce.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpiredRevocations(): Promise<number> {
    const { affected } = await this.revoked.delete({
      expiresAt: LessThanOrEqual(this.clock.nowSeconds()),
    });
    const removed = affected ?? 0;
    if (removed) this.logger.log(`${removed} revogação(ões) vencida(s) descartada(s)`);
    return removed;
  }

  private async verifyRefresh(token: string): Promise<RefreshPayload> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(token);
    } catch {
      throw new UnauthorizedException('Sua sessão expirou. Entre novamente.');
    }
    if (payload.kind !== 'refresh') {
      throw new UnauthorizedException('Token de tipo inesperado');
    }
    return payload;
  }

  private async openSession(user: User): Promise<Session> {
    return {
      user,
      accessToken: await this.sign(user, 'access'),
      refreshToken: await this.sign(user, 'refresh'),
    };
  }

  /**
   * O refresh token leva `jti` porque é ele que pode ser revogado um a um. O
   * access token não leva: vive 15 minutos em memória, e uma lista de revogados
   * consultada a cada requisição custaria mais do que o risco que evitaria.
   *
   * O `iat` é posto à mão, a partir do `Clock` injetado: todo instante do
   * domínio vem dessa fonte (ADR-001 §2.2), e deixar o JWT marcar a hora pelo
   * relógio do sistema abriria uma segunda noção de "agora" dentro do mesmo
   * fluxo.
   */
  private sign(user: User, kind: 'access' | 'refresh'): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: user.id,
        kind,
        iat: this.clock.nowSeconds(),
        ...(kind === 'refresh'
          ? { jti: randomUUID(), ver: user.sessionsVersion }
          : {}),
      },
      { expiresIn: kind === 'access' ? ACCESS_TTL_SEG : REFRESH_TTL_SEG },
    );
  }

  private throwawayHash(): Promise<string> {
    return bcrypt.hash('senha-inexistente', this.rounds);
  }
}
