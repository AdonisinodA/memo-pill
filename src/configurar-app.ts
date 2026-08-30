import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import * as hbs from 'hbs';
import { join } from 'node:path';
import { registerHbsHelpers } from './common/hbs-helpers';

const RAIZ = join(__dirname, '..');

/**
 * Configuração de Express e views compartilhada entre o bootstrap de produção
 * e os testes ponta a ponta — para que o e2e exercite o mesmo setup real.
 */
export function configurarApp(app: NestExpressApplication): void {
  app.use(cookieParser());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // CSS e JS são servidos da própria origem: nada de 'unsafe-inline'.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  app.useStaticAssets(join(RAIZ, 'public'));
  app.setBaseViewsDir(join(RAIZ, 'views'));
  app.setViewEngine('hbs');
  registerHbsHelpers(hbs.handlebars);
}
