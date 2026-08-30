import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { PushService } from './push.service';

export class SubscribeDto {
  @IsString() @MaxLength(1000) endpoint!: string;
  @IsString() @MaxLength(255) p256dh!: string;
  @IsString() @MaxLength(255) auth!: string;
}

@Controller('push')
@UseGuards(SessionGuard)
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly config: ConfigService,
  ) {}

  /** Chave pública VAPID — pode ser exposta; a privada nunca sai do servidor. */
  @Get('chave-publica')
  publicKey(): { key: string } {
    return { key: this.config.getOrThrow<string>('vapid.publicKey') };
  }

  @Post('inscrever')
  async subscribe(@Req() req: Request, @Body() dto: SubscribeDto) {
    const subscription = await this.push.subscribe(req.user!.id, dto);
    return { id: subscription.id };
  }
}
