import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as cheerio from 'cheerio';
import * as Handlebars from 'handlebars';
import { registerHbsHelpers } from '../../src/common/hbs-helpers';

const VIEWS = join(__dirname, '..', '..', 'views');

/**
 * Renderiza uma view isolada, com os mesmos helpers e as mesmas parciais que o
 * `configureApp` registra em produção — uma parcial faltando aqui derrubaria a
 * compilação, que é justamente o sinal que se quer do teste.
 */
export function renderView(
  name: string,
  model: Record<string, unknown> = {},
): cheerio.CheerioAPI {
  const hbs = Handlebars.create();
  registerHbsHelpers(hbs);

  const partials = join(VIEWS, 'partials');
  for (const file of readdirSync(partials)) {
    if (!file.endsWith('.hbs')) continue;
    hbs.registerPartial(
      basename(file, '.hbs'),
      readFileSync(join(partials, file), 'utf8'),
    );
  }

  const template = readFileSync(join(VIEWS, `${name}.hbs`), 'utf8');
  return cheerio.load(hbs.compile(template)(model));
}
