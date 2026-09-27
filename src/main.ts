import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  const caminhoBanco = config.getOrThrow<string>('databasePath');
  if (caminhoBanco !== ':memory:') {
    mkdirSync(dirname(caminhoBanco), { recursive: true });
  }

  configureApp(app);
  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('port');
  const host = config.get<string>('host');
  await (host ? app.listen(port, host) : app.listen(port));
  new Logger('bootstrap').log(`Ouvindo em http://${host ?? 'localhost'}:${port}`);
}

void bootstrap();
