import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { SessaoGuard } from '../auth/sessao.guard';
import { PushService } from './push.service';

export class InscreverDto {
  @IsString() @MaxLength(1000) endpoint!: string;
  @IsString() @MaxLength(255) p256dh!: string;
  @IsString() @MaxLength(255) auth!: string;
}

@Controller('push')
@UseGuards(SessaoGuard)
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly config: ConfigService,
  ) {}

  /** Chave pública VAPID — pode ser exposta; a privada nunca sai do servidor. */
  @Get('chave-publica')
  chavePublica(): { chave: string } {
    return { chave: this.config.getOrThrow<string>('vapid.publicKey') };
  }

  @Post('inscrever')
  async inscrever(@Req() req: Request, @Body() dto: InscreverDto) {
    const inscricao = await this.push.registrar(req.user!.id, dto);
    return { id: inscricao.id };
  }
}
