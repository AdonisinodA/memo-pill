import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CsrfController } from '../common/csrf/csrf.controller';
import { User } from '../users/user.entity';
import { AuthController } from './auth.controller';
import { AuthService, BCRYPT_ROUNDS } from './auth.service';
import { SessaoGuard } from './sessao.guard';

/** Custo do bcrypt (ADR-001 §2.4). Testes usam custo baixo. */
const CUSTO_BCRYPT = 12;

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),
  ],
  controllers: [AuthController, CsrfController],
  providers: [
    AuthService,
    SessaoGuard,
    { provide: BCRYPT_ROUNDS, useValue: CUSTO_BCRYPT },
  ],
  exports: [AuthService, SessaoGuard],
})
export class AuthModule {}
