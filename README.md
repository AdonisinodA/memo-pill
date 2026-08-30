# Lembrete de Medicamentos

PWA de lembrete de medicamentos com acompanhamento de adesão ao tratamento.
As decisões de arquitetura e suas justificativas estão em
[`adr-001-arquitetura-lembrete-medicamentos.md`](./adr-001-arquitetura-lembrete-medicamentos.md) —
o código abaixo o implementa, e os testes citam as seções do ADR que sustentam cada regra.

## Stack

| Camada | Escolha |
|---|---|
| Back-end | NestJS + TypeScript |
| Views | Handlebars (SSR no mesmo processo) |
| CSS | Tailwind, compilado localmente |
| Banco | SQLite (WAL) via TypeORM |
| Notificações | Web Push API + VAPID |
| Testes | Jest, ts-jest, supertest, cheerio |

## Começando

```bash
npm install

# Gere as chaves VAPID e preencha o .env
cp .env.example .env
npx web-push generate-vapid-keys

npm run build        # compila TypeScript e CSS
npm run migration:run
npm start
```

Em desenvolvimento, `npm run dev` (API, com reload) e `npm run watch:css` (Tailwind) rodam lado a lado.

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `PORT` | Porta HTTP (padrão 3000) |
| `DATABASE_PATH` | Arquivo SQLite (padrão `data/app.db`) |
| `JWT_SECRET` | Segredo de assinatura dos tokens — obrigatório |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Par VAPID — obrigatórios |
| `VAPID_SUBJECT` | `mailto:` de contato do serviço |
| `THROTTLE_GERAL` | Limite geral por minuto (padrão 50) |

O `.env` nunca vai para o controle de versão.

## Testes

```bash
npm test           # suíte completa
npm run test:cov   # com cobertura
```

A suíte cobre quatro níveis:

- **Unitário puro** — geração de doses (fusos, horizonte, DST), helpers de view, CSRF.
- **Integração com SQLite real** (`:memory:`, mesmos PRAGMAs da produção) — soft delete,
  regeneração de posologia, agendador, envio push.
- **Renderização de view** — o HTML produzido pelo `dashboard.hbs`, incluindo escape de XSS
  e presença do token CSRF em todo formulário.
- **Ponta a ponta** (`supertest`) — CSRF, sessão, rate limiting e o fluxo completo do
  cadastro do remédio até a dose confirmada.

## Estrutura

```
src/
  auth/          cadastro, login, refresh, guard de sessão
  common/        relógio injetável, CSRF, helpers de view
  config/        leitura e validação de variáveis de ambiente
  database/      PRAGMAs do SQLite, data source e migrations
  doses/         geração, agendador (cron), registro de adesão, histórico
  medications/   CRUD com soft delete e materialização de doses
  push/          inscrições e entrega Web Push
  users/         entidade de usuário
views/           dashboard, login, medicamentos, histórico
public/          Service Worker, manifest, CSS e ícones
```

## Pontos de atenção operacionais

- **Instância única.** O agendador roda dentro do processo. O PM2 precisa de
  `exec_mode: fork` e `instances: 1`; em cluster mode cada dose seria notificada N vezes.
  O claim atômico em `notified_at` é a defesa secundária.
- **Sem backup.** Decisão consciente, registrada no ADR §4. A perda do disco implica
  perda total dos dados.
- **Falha silenciosa do agendador.** Se o processo do cron morrer, nenhuma dose é
  notificada e nada sinaliza a parada. Um healthcheck externo em plano gratuito resolve.

## Privacidade

Os dados de medicação são **dados pessoais sensíveis** (LGPD, Art. 5º, II). A base legal é
o consentimento específico e destacado, coletado no cadastro. Não há compartilhamento com
terceiros nem uso comercial, e a exclusão da conta apaga os dados do titular. O payload
enviado ao push service carrega apenas o identificador da dose — o nome do medicamento é
resolvido pelo Service Worker na própria origem.
