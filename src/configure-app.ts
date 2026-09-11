import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import * as hbs from "hbs";
import helmet from "helmet";
import { registerHbsHelpers } from "./common/hbs-helpers";

const ROOT = join(__dirname, "..");

/**
 * Configuração de Express e views compartilhada entre o bootstrap de produção
 * e os testes ponta a ponta — para que o e2e exercite o mesmo setup real.
 */
export function configureApp(app: NestExpressApplication): void {
	const isProduction = process.env.NODE_ENV === "production";

	app.use(cookieParser());
	app.use(
		helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					// CSS e JS são servidos da própria origem: nada de 'unsafe-inline'.
					scriptSrc: ["'self'"],
					styleSrc: ["'self'"],
					imgSrc: ["'self'", "data:"],
					connectSrc: ["'self'"],
					objectSrc: ["'none'"],
					frameAncestors: ["'none'"],
					// Fora de produção a aplicação roda em http://localhost sem TLS, e
					// esta diretiva faria o navegador reescrever as URLs de CSS e JS para
					// https — que não existe ali, derrubando os assets em silêncio.
					// Em produção o TLS termina no Nginx (ADR-001 §2.5) e ela é desejável.
					...(isProduction ? {} : { upgradeInsecureRequests: null }),
				},
			},
			// HSTS só faz sentido sob HTTPS; o navegador ignora o cabeçalho vindo
			// por http, mas não faz sentido anunciá-lo em desenvolvimento.
			strictTransportSecurity: isProduction,
		}),
	);

	app.useStaticAssets(join(ROOT, "public"));
	app.setBaseViewsDir(join(ROOT, "views"));
	app.setViewEngine("hbs");
	// O pacote `hbs` NÃO aplica layout por conta própria: sem esta linha, cada
	// view é servida sozinha, sem <html>, sem <head> e sem o <link> do CSS.
	app.set("view options", { layout: "layouts/main" });
	registerHbsHelpers(hbs.handlebars);
	registerPartials(join(ROOT, "views", "partials"));
}

/**
 * Registro SÍNCRONO das parciais. O `hbs.registerPartials` do pacote lê o
 * diretório de forma assíncrona e devolve antes de terminar: uma requisição que
 * chegue nesse intervalo — e o primeiro teste e2e chega — renderiza a página
 * sem a parcial. Ler aqui, de uma vez, elimina a corrida.
 */
function registerPartials(dir: string): void {
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".hbs")) continue;
		hbs.handlebars.registerPartial(
			basename(file, ".hbs"),
			readFileSync(join(dir, file), "utf8"),
		);
	}
}
