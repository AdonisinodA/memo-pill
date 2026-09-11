import { MiddlewareConsumer, Module, NestModule, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { RevokedToken } from './auth/revoked-token.entity';
import { CommonModule } from './common/common.module';
import { CsrfMiddleware } from './common/csrf/csrf.middleware';
import { FlashMiddleware } from './common/flash/flash.middleware';
import { HttpErrorFilter } from './common/http-error.filter';
import { NoStoreInterceptor } from './common/no-store.interceptor';
import { configuration } from './config/configuration';
import { applyPragmas } from './database/sqlite-options';
import { DoseLog } from './doses/dose-log.entity';
import { DosesModule } from './doses/doses.module';
import { LogoutModule } from './logout/logout.module';
import { Medication } from './medications/medication.entity';
import { MedicationsModule } from './medications/medications.module';
import { PushSubscription } from './push/push-subscription.entity';
import { PushModule } from './push/push.module';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';

/**
 * Rate limiting por janela fixa (ADR-001 §2.4): 50 requisições por 60s no geral.
 * Rotas sensíveis usam o limitador `estrito` via @Throttle.
 */
export const THROTTLE_WINDOW_MS = 60_000;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      // Só o limitador geral fica na raiz: um limitador nomeado declarado aqui
      // valeria para TODAS as rotas, não apenas para as que o citam. As rotas
      // sensíveis sobrescrevem esse mesmo limitador via @Throttle.
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: THROTTLE_WINDOW_MS,
          limit: config.getOrThrow<number>('throttle.general'),
        },
      ],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3' as const,
        database: config.getOrThrow<string>('databasePath'),
        entities: [User, Medication, DoseLog, PushSubscription, RevokedToken],
        // Em produção o schema vem de migrations versionadas, aplicadas no boot.
        migrations: [join(__dirname, 'database', 'migrations', '*.js')],
        migrationsRun: process.env.NODE_ENV === 'production',
        synchronize: process.env.NODE_ENV !== 'production',
        prepareDatabase: applyPragmas,
      }),
    }),
    CommonModule,
    UsersModule,
    AuthModule,
    MedicationsModule,
    DosesModule,
    PushModule,
    LogoutModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: NoStoreInterceptor },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // FlashMiddleware antes do CSRF: o token CSRF inválido é lançado de dentro
    // do próprio CsrfMiddleware, e a mensagem pendente precisa já ter sido
    // lida da requisição quando isso acontece.
    consumer.apply(FlashMiddleware, CsrfMiddleware).forRoutes('*');
  }
}
