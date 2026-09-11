# Lembrete de Medicamentos

PWA de lembrete de medicamentos com acompanhamento de adesão ao tratamento.
O usuário cadastra seus remédios com horários, recebe uma notificação push no
horário de cada dose e confirma se tomou ou pulou — direto da notificação ou
pela tela do dia. O histórico resultante é a medida de adesão.

As decisões de arquitetura e suas justificativas estão em
[`adr-001-arquitetura-lembrete-medicamentos.md`](./adr-001-arquitetura-lembrete-medicamentos.md) —
o código aqui o implementa, e os testes citam as seções do ADR que sustentam cada regra.

## Stack

| Camada | Escolha |
|---|---|
| Back-end | NestJS 11 + TypeScript |
| Views | Handlebars (SSR no mesmo processo) |
| CSS | Tailwind, compilado localmente |
| Banco | SQLite (WAL) via TypeORM |
| Notificações | Web Push API + VAPID |
| Agendamento | `@nestjs/schedule` (cron no próprio processo) |
| Testes | Jest, ts-jest, supertest, cheerio |

Requisitos: **Node.js 22+** e npm (validado em Node 22.20). Nada além disso —
sem servidor de banco, sem Redis, sem fila.

## Como subir o projeto (desenvolvimento)

```bash
# 1. Dependências
npm install

# 2. Ambiente
cp .env.example .env

# 3. Chaves VAPID (obrigatórias — a app não sobe sem elas)
npx web-push generate-vapid-keys
#    Copie a saída para VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no .env,
#    e troque o JWT_SECRET por um valor longo e aleatório:
#    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. CSS (o Tailwind não é servido por CDN — precisa ser compilado)
npm run build:css

# 5. Sobe a aplicação
npm run dev
```

Acesse `http://localhost:3000` (ou a porta que estiver em `PORT`). Comece por
`/cadastro`, crie a conta marcando o consentimento, cadastre um medicamento em
`/medicamentos/novo` e as doses aparecem em `/doses/hoje`.

Para trabalhar no CSS ao mesmo tempo, rode `npm run watch:css` em um segundo
terminal — `npm run dev` recarrega o TypeScript, mas não o Tailwind.

**Sobre o banco:** fora de produção o TypeORM usa `synchronize: true`, então o
schema é criado a partir das entidades no primeiro boot. Não é preciso rodar
migration para desenvolver. O arquivo `data/app.db` e o diretório `data/` são
criados automaticamente.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | não | Porta HTTP (padrão 3000) |
| `DATABASE_PATH` | não | Arquivo SQLite (padrão `data/app.db`) |
| `JWT_SECRET` | **sim** | Segredo de assinatura dos tokens de sessão |
| `VAPID_PUBLIC_KEY` | **sim** | Chave pública VAPID |
| `VAPID_PRIVATE_KEY` | **sim** | Chave privada VAPID |
| `VAPID_SUBJECT` | não | `mailto:` de contato do serviço |
| `THROTTLE_GENERAL` | não | Limite geral por minuto (padrão 50) |
| `THROTTLE_STRICT` | não | Limite das rotas de credencial (padrão 5) |
| `NODE_ENV` | em produção | `production` liga migrations no boot, HSTS e CSP estrita |

As três obrigatórias falham no boot com mensagem explícita se estiverem
ausentes — é proposital (ADR-001 §2.4). O `.env` nunca vai para o controle de
versão.

### Notificações push em desenvolvimento

O Service Worker e a Web Push API exigem contexto seguro. `http://localhost` é
tratado como seguro pelos navegadores, então o push funciona localmente sem
TLS — mas **não** funciona se você acessar a aplicação pelo IP da máquina na
rede (`http://192.168.x.x`). Para testar em um celular, use um túnel HTTPS ou
o ambiente de produção.

**A inscrição não é automática.** O aparelho só passa a receber lembretes
depois que o usuário toca em **Ativar** no banner do topo de `/doses/hoje`:
`public/js/push.js` pede a permissão (os navegadores só aceitam
`Notification.requestPermission()` a partir de um gesto do usuário), assina no
`pushManager` com a chave VAPID de `/push/chave-publica` e registra o resultado
em `/push/inscrever`. Sem essa inscrição o agendador dispara no horário e
`notifyDose` percorre uma lista vazia — a dose fica com `notified_at`
preenchido e nada chega ao celular. É por isso que `dispatchDue` emite um
`warn` quando uma dose despachada não alcança nenhum aparelho.

Roteiro de teste local:

1. Abra `http://localhost:3000/doses/hoje`, toque em **Ativar** e conceda a
   permissão.
2. Cadastre um remédio com horário 2 minutos à frente — o agendador roda a cada
   minuto e a janela de tolerância é de 30 min (`TOLERANCE_WINDOW_SEC`).
3. Uma dose só é despachada **uma vez**: `notified_at` é o claim. Para repetir o
   teste, cadastre outra dose em vez de reaproveitar a mesma.
4. Alterou `sw.js`? Um recarregamento basta: o Service Worker chama
   `skipWaiting()` no `install` e `clients.claim()` no `activate`, então a
   versão nova assume na hora. Sem isso ele ficaria em `waiting` enquanto
   houvesse aba aberta — e como é o SW que monta a notificação, a correção só
   chegaria ao usuário depois de fechar o app inteiro.

## Como subir em produção

A infraestrutura-alvo é uma VPS Linux com PM2, Nginx e Certbot (ADR-001 §2.5).

```bash
# Na VPS, no diretório do projeto
npm ci
cp .env.example .env    # preencha os segredos de produção
npm run build           # compila TypeScript (-> dist/) e o CSS minificado

NODE_ENV=production pm2 start dist/main.js \
  --name lembrete-medicamentos \
  --exec-mode fork -i 1

pm2 save
pm2 startup             # habilita o restart no boot da máquina
```

Pontos que não são opcionais:

- **`NODE_ENV=production` é obrigatório.** É essa variável que troca
  `synchronize` por `migrationsRun`: com ela, as migrations versionadas de
  `dist/database/migrations/` são aplicadas no boot; sem ela, o TypeORM
  sincroniza o schema a partir das entidades — comportamento aceitável em
  desenvolvimento e inaceitável sobre dados reais. Ela também liga o HSTS e o
  `upgrade-insecure-requests` na CSP.
- **`--exec-mode fork -i 1`.** O agendador roda dentro do processo. Em cluster
  mode, cada dose seria notificada N vezes (uma por worker).
- **HTTPS de verdade.** O Service Worker e a Web Push API só funcionam sob TLS
  fora do localhost. O Nginx termina o TLS (Certbot/Let's Encrypt) e faz proxy
  para `localhost:3000`; a porta da aplicação fica fechada no UFW, que expõe
  apenas 22, 80 e 443.
- **Backup do `DATABASE_PATH`.** Não há rotina de backup no código — ver
  "Pontos de atenção" abaixo.

Deploys seguintes: `git pull && npm ci && npm run build && pm2 restart lembrete-medicamentos`.

### Migrations

Só são necessárias quando o schema muda:

```bash
npm run migration:generate -- src/database/migrations/NomeDaMudanca
npm run migration:run       # aplicar manualmente (em produção o boot já aplica)
npm run migration:revert    # desfazer a última
```

## Testes

```bash
npm test           # suíte completa
npm run test:cov   # com cobertura
npm run test:watch # em watch
```

181 testes em 12 suítes, cobrindo quatro níveis:

- **Unitário puro** — geração de doses (fusos, horizonte, DST), helpers de view, CSRF.
- **Integração com SQLite real** (`:memory:`, mesmos PRAGMAs da produção) — soft delete,
  regeneração de posologia, agendador, envio push.
- **Renderização de view** — o HTML produzido pelo `dashboard.hbs`, incluindo escape de XSS
  e presença do token CSRF em todo formulário.
- **Ponta a ponta** (`supertest`) — CSRF, sessão, rate limiting e o fluxo completo do
  cadastro do remédio até a dose confirmada. Usa o mesmo `configureApp()` do
  bootstrap de produção, não uma montagem paralela.

Os testes não tocam o banco de desenvolvimento nem exigem `.env`.

## Rotas

| Método | Rota | O que faz |
|---|---|---|
| `GET` | `/` | Redireciona para a tela do dia |
| `GET` | `/cadastro`, `/login` | Formulários de conta |
| `POST` | `/auth/cadastro`, `/auth/login`, `/auth/logout`, `/auth/refresh` | Sessão |
| `GET` | `/doses/hoje` | Doses do dia (`start_url` do PWA) |
| `POST` | `/doses/:id/taken`, `/doses/:id/skipped` | Registro de adesão |
| `GET` | `/doses/:id/resumo` | JSON consumido pelo Service Worker |
| `GET` | `/historico` | Histórico de adesão |
| `GET` | `/medicamentos` | Remédios cadastrados, com posologia e situação |
| `GET` | `/medicamentos/novo` | Formulário de cadastro |
| `POST` | `/medicamentos`, `/medicamentos/:id/remover` | Criação e soft delete |
| `GET` | `/push/chave-publica` | Chave VAPID pública para o cliente |
| `POST` | `/push/inscrever` | Registro da inscrição push |
| `GET` | `/csrf` | Token para requisições do cliente |

### Erros e avisos na tela

A mesma rota atende o navegador e o Service Worker, e o erro precisa chegar de
forma diferente a cada um. Quem manda `Accept: text/html` é tratado como
navegação; o resto recebe JSON com o status original.

| Situação | Navegador | Service Worker / API |
|---|---|---|
| POST com erro (validação, conflito, CSRF) | 303 de volta à página de origem, com a mensagem em um toast | JSON com o status da exceção |
| POST bem-sucedido | 303 com toast de confirmação | JSON `{ id, status }` |
| GET com erro | página `error.hbs` — redirecionar levaria de volta à página que falhou | JSON |
| Sessão ausente | redirect para `/login` | 401 |

O transporte é um cookie de uso único (`flash`, `HttpOnly`, 60s), lido e apagado
pelo `FlashMiddleware`, que o entrega ao layout em `res.locals`. Por isso o
toast funciona em qualquer tela sem que o controller precise repassá-lo.

## Segurança — OWASP Top 10 (2021)

Os dez riscos do OWASP Top 10 estão endereçados abaixo, com o ponto do código
que sustenta cada um. **Sete** já estavam implementados quando esta seção foi
escrita — o levantamento apenas os documentou; **três** (A06, A09, A10) têm
cobertura parcial e as lacunas estão nomeadas ao final, sem maquiagem.

| # | Risco | Situação | Principal controle |
|---|---|---|---|
| A01 | Broken Access Control | Coberto | `SessionGuard` + escopo por `user_id` em toda consulta |
| A02 | Cryptographic Failures | Coberto | bcrypt, JWT, cookies `HttpOnly`/`Secure`, TLS + HSTS |
| A03 | Injection | Coberto | Queries parametrizadas, escape do Handlebars, CSP sem `unsafe-inline` |
| A04 | Insecure Design | Coberto | ADR-001, idempotência, claim atômico, consentimento obrigatório |
| A05 | Security Misconfiguration | Coberto | Helmet/CSP explícita, segredos só em env, boot falha se faltar |
| A06 | Vulnerable and Outdated Components | **Parcial** | `npm ci` com lock; `multer` transitivo pendente |
| A07 | Identification and Authentication Failures | Coberto | Rate limit em credenciais, anti-enumeração, tokens tipados |
| A08 | Software and Data Integrity Failures | Coberto | Zero CDN, assets da própria origem, migrations versionadas |
| A09 | Security Logging and Monitoring Failures | **Parcial** | Log de push/agendador; sem trilha de autenticação |
| A10 | Server-Side Request Forgery | **Parcial** | Endpoint push exige sessão; sem allowlist de host |

### A01 — Broken Access Control

Autorização em duas camadas, porque só a primeira não impede IDOR:

- **Autenticação na borda.** Todo controller que toca dado do usuário declara
  `@UseGuards(SessionGuard)` na classe, não no método — nenhuma rota nova nasce
  desprotegida por esquecimento: `doses.controller.ts:13`,
  `medications.controller.ts:10`, `push.controller.ts:15`,
  `csrf.controller.ts:11`. Só `/login` e `/cadastro` ficam abertos, por
  definição.
- **Escopo de propriedade na consulta.** O `id` da URL nunca é usado sozinho.
  Mutações de medicamento passam por `requireOwned()`
  (`medications.service.ts:200`), que filtra por `{ id, userId }` e devolve
  404 — não 403 — quando o recurso é de outro titular; as consultas de dose
  cruzam o join com `m.user_id = :userId` (`doses.service.ts:54`, `:91`,
  `:132`). Trocar o UUID na URL não alcança dado alheio.
- **`ParseUUIDPipe`** em todo `:id`, o que rejeita a entrada malformada antes
  de ela chegar ao serviço.
- O redirect de sessão ausente é tratado por `HttpErrorFilter`: navegação vai
  para `/login`, chamada de API recebe 401 — sem vazar HTML de erro. O mesmo
  filtro só devolve o corpo de exceções `HttpException` (mensagens escritas
  pela aplicação); erro inesperado vira 500 genérico, para que `stack` e
  mensagem do SQLite não cheguem ao cliente.

### A02 — Cryptographic Failures

- **Senhas:** bcrypt com custo injetável (`auth.service.ts:44`); o DTO limita a
  senha a 72 bytes porque o bcrypt trunca acima disso, o que silenciosamente
  encurtaria a senha efetiva. A senha em claro nunca é persistida
  (`user.entity.ts`).
- **Sessão:** JWT assinado com `JWT_SECRET`; access token de 15 minutos vive só
  em memória no cliente, refresh de 30 dias em cookie `HttpOnly`, `Secure` em
  produção, `SameSite=Lax` (`auth.controller.ts:62-67`). `Lax` e não `Strict` é
  escolha deliberada: `Strict` suprimiria o cookie na navegação vinda do clique
  na notificação push, que é o fluxo central do produto — e é justamente por
  isso que existe token CSRF (ver A03).
- **Token CSRF:** `randomBytes(32)` e comparação em tempo constante com
  `timingSafeEqual` (`csrf.service.ts:18`, `:25`).
- **Em trânsito:** TLS termina no Nginx e o HSTS só é anunciado em produção
  (`configure-app.ts:39`) — anunciá-lo sobre http em desenvolvimento seria
  ruído inútil.
- **Dado de saúde não trafega por terceiro:** o payload enviado ao push service
  (FCM/APNs) contém apenas `{ doseId }`; o nome do medicamento é resolvido pelo
  Service Worker em `/doses/:id/resumo`, na própria origem.

### A03 — Injection

- **SQL:** todo acesso passa pelo TypeORM com placeholders nomeados
  (`:userId`, `:id`, `:now`). Não há concatenação de entrada em SQL em nenhum
  ponto do `src/` — apenas o DDL estático da migration inicial usa string
  literal.
- **XSS:** o Handlebars escapa por padrão e as views usam somente `{{ }}`. O
  único `{{{ }}}` do projeto é o `{{{body}}}` do layout
  (`views/layouts/main.hbs:18`), que injeta HTML já renderizado pelo servidor,
  não entrada de usuário. `test/dashboard.view.spec.ts` afirma o escape com um
  nome de medicamento malicioso.
- **Defesa em profundidade contra XSS:** CSP com `script-src 'self'` e
  `style-src 'self'`, sem `unsafe-inline` (`configure-app.ts:24`) — é por isso
  que o registro do Service Worker vive em `public/js/app.js` e o Tailwind é
  compilado localmente em vez de vir de CDN. Um XSS refletido não conseguiria
  executar script inline.
- **Validação de entrada:** `ValidationPipe` global com `whitelist` e
  `forbidNonWhitelisted` (`app.module.ts:72-73`): campo não declarado no DTO
  faz a requisição falhar, em vez de ser ignorado em silêncio. Horários são
  validados por regex `HH:mm` e datas por `IsISO8601`.

### A04 — Insecure Design

- As decisões e os trade-offs de segurança são registrados por escrito no
  ADR-001 §2.4 antes do código — inclusive as recusadas.
- **CSRF por token sintético** vinculado ao cookie de sessão, aceito via campo
  `_csrf` do formulário ou header `X-CSRF-Token`
  (`csrf.middleware.ts`); métodos seguros (GET/HEAD/OPTIONS) são dispensados. O
  token é removido do corpo antes da validação do DTO, para não colidir com
  `forbidNonWhitelisted`.
- **Consentimento como requisito de schema, não de tela:** o `RegisterDto` exige
  `@Equals(true)` no campo `consent` e a coluna `consent_at` é `NOT NULL` — não
  existe conta criada sem base legal registrada (LGPD, Art. 11, I).
- **Idempotência e corrida:** registrar a mesma dose duas vezes não é erro
  (o segundo toque na notificação é esperado), e o disparo usa claim atômico em
  `notified_at` (`dose-scheduler.service.ts:101-103`) para que a dose não seja
  notificada duas vezes.

### A05 — Security Misconfiguration

- **Helmet com CSP explícita**, não a padrão: `default-src 'self'`,
  `object-src 'none'` e `frame-ancestors 'none'` — este último é a proteção
  anti-clickjacking (`configure-app.ts:28-29`).
- **Segredos apenas em variável de ambiente.** `JWT_SECRET`,
  `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` não têm valor padrão: a aplicação
  **falha no boot** com mensagem explícita se faltarem (`configuration.ts:31`).
  Um segredo de desenvolvimento nunca vaza para produção por descuido.
- `.env`, `*.db`, `*.db-wal` e `*.db-shm` estão no `.gitignore`.
- `PRAGMA foreign_keys = ON` a cada conexão (o SQLite deixa desligado por
  padrão, o que permitiria órfãos).
- **O risco de configuração desta app tem nome:** rodar em produção sem
  `NODE_ENV=production` mantém `synchronize: true` no TypeORM, deixando o
  schema ser reescrito a partir das entidades. Ver "Como subir em produção".
- Superfície de rede mínima: UFW expõe 22, 80 e 443; a porta 3000 fica fechada.

### A06 — Vulnerable and Outdated Components

- Dependências em versão corrente (NestJS 11), `package-lock.json` versionado e
  `npm ci` no deploy — instalação reprodutível, sem resolução surpresa.
- **Pendência real:** `npm audit --omit=dev` reporta 5 vulnerabilidades high em
  `multer` (≤ 2.2.0), dependência transitiva do `@nestjs/platform-express`,
  todas de negação de serviço via upload multipart. A aplicação **não tem rota
  de upload** — nenhum `FileInterceptor` é usado — então o multer nunca é
  invocado e o risco prático é nulo hoje. Ainda assim, o `@nestjs/platform-express`
  fixa `multer@2.2.0` até a versão 12, e a correção limpa é um override no
  `package.json`:

  ```json
  "overrides": { "multer": "^2.3.0" }
  ```

  Rode `npm audit --omit=dev` antes de cada deploy.

### A07 — Identification and Authentication Failures

- **Rate limiting em rotas de credencial:** 5 tentativas por minuto em
  `/auth/login` e `/auth/cadastro` via `@Throttle`
  (`auth.controller.ts:30`, `:38`), contra o limite geral de 50/min do resto da
  aplicação.
- **Anti-enumeração de usuários:** login inexistente compara a senha contra um
  hash descartável (`auth.service.ts:58`, `:103`) para que o tempo de resposta
  não revele quais e-mails existem; a mensagem de erro é a mesma nos dois casos
  ("Credenciais inválidas").
- **Tokens tipados.** O payload carrega `kind: 'access' | 'refresh'` e o refresh
  é rejeitado se o tipo não bater (`auth.service.ts:79`) — um access token não
  pode ser reapresentado como refresh.
- Senha mínima de 8 caracteres; e-mail normalizado (`trim`/`lowercase`) antes de
  comparar, para que não existam duas contas com o mesmo e-mail em caixas
  diferentes.
- Logout limpa o cookie de refresh.

### A08 — Software and Data Integrity Failures

- **Nenhum recurso de terceiros em runtime.** Sem CDN, sem fonte externa, sem
  script de analytics: Tailwind é compilado para `public/css/app.css` e a CSP
  restringe scripts e estilos a `'self'`. Não existe origem externa capaz de
  alterar o que o navegador executa — que é exatamente o vetor deste item.
- **Integridade da cadeia de build:** `package-lock.json` no repositório +
  `npm ci` (que falha se o lock divergir do `package.json`, em vez de
  "consertar" a árvore).
- **Integridade do schema:** em produção o schema vem de migrations
  versionadas aplicadas no boot, nunca de alteração manual no banco.

### A09 — Security Logging and Monitoring Failures

Item mais fraco do projeto, e assumido como tal:

- Existe log estruturado do agendador e da entrega push, incluindo remoção de
  inscrição morta e falha após 3 tentativas (`push.service.ts:78`, `:86`).
- **Falta trilha de eventos de segurança:** falha de login, rejeição de token
  CSRF e bloqueio por rate limit não são registrados, o que impede detectar um
  ataque de força bruta em andamento.
- **Falta monitoramento de vivacidade do agendador.** Se o cron parar, nenhuma
  dose é notificada e nada sinaliza — num app de medicação, essa falha
  silenciosa é o pior modo de falha possível. Mitigação prevista: healthcheck
  externo.

### A10 — Server-Side Request Forgery (SSRF)

A aplicação não busca URLs informadas pelo usuário — não há proxy, webhook nem
importação por link. Resta **uma** requisição de saída: o POST do Web Push para
o `endpoint` da inscrição, que vem do navegador do cliente.

- Controles presentes: `/push/inscrever` exige sessão válida
  (`push.controller.ts:15`), o `endpoint` é limitado a 1000 caracteres e o corpo
  enviado contém apenas `{ doseId }` — nada de dado sensível para exfiltrar.
- **Lacuna:** não há allowlist de host. Um usuário autenticado pode registrar um
  endpoint arbitrário e fazer o servidor emitir um POST para ele, inclusive para
  a rede interna. A resposta não retorna ao cliente (só o status HTTP influencia
  a remoção da inscrição), o que limita o proveito a um SSRF cego. A correção é
  validar o host contra os domínios conhecidos de push service
  (`*.googleapis.com`, `*.push.apple.com`, `*.notify.windows.com`,
  `*.push.services.mozilla.com`) no `SubscribeDto`.

### Lacunas conhecidas

Listadas porque um TCC ganha mais em reconhecer o limite do escopo do que em
alegar cobertura que não tem:

1. **`multer` transitivo vulnerável** (A06) — sem impacto prático hoje; corrigir
   com override.
2. **Sem trilha de auditoria de autenticação** (A09).
3. **Sem allowlist de host no endpoint push** (A10).
4. **Sessão não revogável no servidor** (A07): o JWT é stateless, então um
   refresh token vazado vale até expirar — até 30 dias. Logout limpa o cookie do
   navegador, mas não invalida o token. Uma tabela de sessões ou uma coluna
   `tokens_valid_from` no usuário resolveria.
5. **Sem MFA e sem recuperação de senha** (A07) — fora do escopo.
6. **Banco não cifrado em repouso.** O arquivo SQLite é legível por qualquer
   processo com acesso ao disco da VPS; a proteção é o controle de acesso do
   sistema operacional.
7. **Exclusão de conta não implementada** (LGPD, Art. 18) — não existe rota que
   apague os dados do titular. O soft delete de medicamento preserva histórico
   por decisão de produto e não é mecanismo de exclusão de dados pessoais.

## Convenção de idioma

Identificadores, nomes de arquivo, colunas do banco e campos de formulário em
**inglês**. Texto visível ao usuário, comentários e descrições de teste em
**pt-BR**. As rotas seguem em pt-BR (`/doses/hoje`, `/medicamentos`,
`/historico`, `/cadastro`), acompanhando a interface.

## Estrutura

```
src/
  auth/          cadastro, login, refresh, guard de sessão
  common/        relógio injetável, CSRF, flash/toast, filtro de erro, helpers de view
  config/        leitura e validação de variáveis de ambiente
  database/      PRAGMAs do SQLite, data source e migrations
  doses/         geração, agendador (cron), registro de adesão, histórico
  medications/   CRUD com soft delete e materialização de doses
  push/          inscrições e entrega Web Push
  users/         entidade de usuário
  configure-app.ts   Express, Helmet/CSP e view engine — compartilhado com o e2e
views/           dashboard, login, medications, medication-new, history, error
  partials/      nav (sidebar + barra inferior) e toast, usados pelo layout
public/          Service Worker, inscrição push, manifest, CSS compilado e ícones
test/            e2e e renderização de view
```

O agendador varre as doses a cada minuto (`* * * * *`) e materializa o horizonte
de doses futuras uma vez por dia, às 3h.

## Pontos de atenção operacionais

- **Instância única.** O agendador roda dentro do processo — daí o
  `exec_mode: fork` com `instances: 1`. O claim atômico em `notified_at` é a
  defesa secundária, não a primária.
- **Sem backup.** Decisão consciente, registrada no ADR §4. A perda do disco
  implica perda total dos dados; copiar o `DATABASE_PATH` periodicamente é
  responsabilidade da operação.
- **Falha silenciosa do agendador.** Se o cron parar, nenhuma dose é notificada
  e nada sinaliza a parada. Um healthcheck externo em plano gratuito resolve.
- **Um escritor por vez.** O WAL permite leituras concorrentes durante uma
  escrita, mas não escritas simultâneas; o `busy_timeout` de 5s é a mitigação.

## Privacidade

Os dados de medicação são **dados pessoais sensíveis** (LGPD, Art. 5º, II). A base legal é
o consentimento específico e destacado, coletado no cadastro e persistido em `consent_at`
(Art. 11, I) — sem ele não existe conta. Não há compartilhamento com terceiros nem uso
comercial. O payload enviado ao push service carrega apenas o identificador da dose — o
nome do medicamento é resolvido pelo Service Worker na própria origem, para que o dado de
saúde não trafegue por FCM ou APNs.

O direito de eliminação (Art. 18, VI) **ainda não tem implementação**: não há rota de
exclusão de conta, e o soft delete de medicamento é mecanismo de preservação de histórico
clínico, não de apagamento de dado pessoal. Está registrado nas
[lacunas conhecidas](#lacunas-conhecidas) junto com os demais itens em aberto do
OWASP Top 10.
