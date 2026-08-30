import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthModule } from '../auth/auth.module';
import { PushController } from './push.controller';
import { PushService, SLEEP } from './push.service';
import { PushSubscription } from './push-subscription.entity';
import { WebPushHttpTransport, WebPushTransport } from './web-push.transport';

@Module({
  imports: [TypeOrmModule.forFeature([PushSubscription]), AuthModule],
  controllers: [PushController],
  providers: [
    PushService,
    { provide: WebPushTransport, useClass: WebPushHttpTransport },
    { provide: SLEEP, useValue: (ms: number) => delay(ms) },
  ],
  exports: [PushService],
})
export class PushModule {}
