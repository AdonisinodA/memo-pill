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

## Como subir em produção (Azure + GitHub Actions)

Três eixos ligados por uma esteira automatizada: o código sai da máquina de
desenvolvimento, vai para o GitHub e o **GitHub Actions** publica na VM da
Azure a cada `git push origin main`. Nenhum passo de deploy é manual depois do
provisionamento inicial.

```
dev (Claude Code) ──push──▶ GitHub (repo público) ──Actions──▶ VM Azure (Nginx + PM2)
                                 │                                 ▲
                                 └─ npm ci · audit · test · build ─┘ rsync + ssh
```

### Eixo 1 — Infraestrutura

| Item | Escolha | Onde está |
|---|---|---|
| Provedor | Microsoft Azure, conta gratuita (VM B1s / B2ats v2, 750 h/mês) | portal da Azure |
| Sistema operacional | **Debian 12 (bookworm)** | imagem da VM |
| Web server | Nginx (container `nginx:alpine`, rede do host) como proxy reverso para `127.0.0.1:3000` | `deploy/nginx/memo-pill.conf`, `deploy/setup-server.sh` |
| Processo | PM2, 1 instância em fork, sobe no boot | `ecosystem.config.js` |
| Acesso remoto | só chave SSH; senha e root desligados | `deploy/ssh/00-hardening.conf` |
| Firewall | NSG da Azure + UFW: entrada apenas 22, 80, 443 | `deploy/setup-server.sh` |
| Força bruta no SSH | Fail2Ban, `maxretry = 4`, `bantime = 24h` | `deploy/fail2ban/jail.local` |
| TLS | Certbot ≥ 5.4 (snap), certificado Let's Encrypt **para o IP**, renovação automática | `deploy/setup-server.sh` |
| HTTP → HTTPS | `return 301` na porta 80 (exceto o desafio ACME) | `deploy/nginx/memo-pill.conf` |
| PQC | `ssl_ecdh_curve X25519MLKEM768:...` | `deploy/nginx/memo-pill.conf` |

**Por que o Nginx roda em container:** o grupo pós-quântico `X25519MLKEM768`
só existe no OpenSSL 3.5+, e o Debian 12 traz OpenSSL 3.0 — o Nginx do apt,
ligado a ele, não consegue negociar PQC e o teste da DigiCert reprovaria. Em
vez de trocar o sistema operacional ou compilar o Nginx à mão, o Nginx vem da
imagem oficial `nginx:alpine`, que traz OpenSSL 3.5+. O `setup-server.sh`
confere a versão do OpenSSL da imagem e aborta se for inferior a 3.5.

- **`--network host`:** sem NAT do Docker. O Nginx escuta direto nas portas 80
  e 443 do host, então o **UFW continua valendo** (uma porta publicada com `-p`
  seria liberada pelo Docker por fora do UFW), o proxy alcança
  `127.0.0.1:3000` e o `$remote_addr` é o IP real do cliente — que é o que o
  rate limit da aplicação precisa.
- **Montagens somente leitura:** configuração, `/etc/letsencrypt` e o webroot
  do ACME. O Certbot continua no host; o hook de renovação executa
  `docker exec nginx nginx -s reload`.
- **Atualizar o Nginx:** rodar de novo o `setup-server.sh` com os mesmos
  argumentos — ele baixa a imagem mais recente e recria o container, sem
  reemitir o certificado nem sobrescrever o `.env`.

**Por que certificado de curta duração:** a Let's Encrypt só emite certificado
para endereço IP no perfil `shortlived` (~6 dias). A renovação automática deixa
de ser conveniência e passa a ser o que mantém o site no ar; o timer do snap do
Certbot roda duas vezes ao dia e o `--deploy-hook` recarrega o Nginx.

#### Passo a passo

1. **Criar a VM no portal da Azure:** imagem **Debian 12 (bookworm)**, tamanho
   elegível ao free tier, autenticação **por chave SSH** (nunca senha), IP
   público estático. No NSG, regras de entrada apenas para 22, 80 e 443.
2. **Gerar a chave exclusiva do pipeline** (na sua máquina — não reutilize a sua
   chave pessoal):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/memo-pill-deploy -C "github-actions" -N ""
   ```
3. **Provisionar a VM** (uma vez):
   ```bash
   scp -r deploy azureuser@<IP>:~/
   ssh azureuser@<IP>
   sudo bash ~/deploy/setup-server.sh <IP> <seu-email> "$(cat ~/.ssh/memo-pill-deploy.pub)"
   ```
   O script instala pacotes, endurece o SSH, liga UFW e Fail2Ban, instala
   Docker, Node 22 e PM2, cria o usuário `deploy`, **gera o `.env` com segredos na
   própria VM** (JWT e VAPID nunca passam pelo GitHub), emite o certificado e
   sobe o Nginx em container com a configuração definitiva. Passe a chave pública entre aspas, no terceiro
   argumento, já que ela vem do arquivo `.pub` da sua máquina.
4. **Cadastrar os Secrets** em *Settings → Secrets and variables → Actions*:

   | Secret | Valor |
   |---|---|
   | `SSH_HOST` | IP público da VM |
   | `SSH_USER` | `deploy` |
   | `SSH_PRIVATE_KEY` | conteúdo de `~/.ssh/memo-pill-deploy` |
   | `SSH_KNOWN_HOSTS` | saída de `ssh-keyscan -t ed25519 <IP>` |

5. **Publicar:** `git push origin main`. O workflow roda os testes, compila e
   publica; a partir daí todo push na `main` repete o ciclo.

#### Evidências de conformidade

- [ssl.org](https://www.ssl.org/) com o IP: *Certificate Trusted: YES* e
  *Good signature · Acceptable key* — `docs/evidencias/ssl-org.png`.
- [DigiCert PQC checker](https://www.digicert.com/pqc-checker): suporte a
  PQC ativo — `docs/evidencias/digicert-pqc.png`.
- `fail2ban-client status sshd`, `ufw status verbose` e `certbot renew --dry-run`
  — saídas no final do `setup-server.sh`.

#### Teste local da produção (antes de ir para a Azure)

```bash
deploy/local-test/run.sh        # sobe, publica e verifica (deixa no ar em https://127.0.0.1:8443)
deploy/local-test/run.sh down   # derruba e apaga os temporários
```

Sobe um "servidor" **Debian 12** com sshd endurecido, Node 22 e PM2, e o
**mesmo Nginx em container** da produção compartilhando a rede dele. Publica
com o **mesmo `deploy/deploy.sh`** que o GitHub Actions usa (duas vezes, para
exercitar o redeploy) e roda 17 verificações: `.env` e banco preservados,
migrations no boot, PM2 em fork, SSH sem senha e sem root, 301 para HTTPS,
HSTS/CSP, **handshake com `X25519MLKEM768`**, fallback clássico, TLS 1.1
recusado e rate limit por cliente atrás do proxy — este último validado por
mutação: sem o `trust proxy`, um segundo cliente com outro IP é bloqueado junto.

Precisa de Docker e de OpenSSL 3.5+ no host. Não cobre o que exige IP público
ou systemd — certificado Let's Encrypt, UFW e Fail2Ban —, conferidos na VM pela
saída do `setup-server.sh`.

### Eixo 2 — Repositório

- Repositório **público** no GitHub, conta com **2FA** ativado; `commit` e
  `push` por **chave SSH** dedicada (sem senha nem token em texto).
- `.gitignore` bloqueia `.env`, bancos SQLite (`*.db`, `*-wal`, `*-shm`),
  `dist/`, `node_modules/` e `coverage/`. O único arquivo de ambiente
  versionado é o `.env.example`, sem nenhum segredo real.
- Segredos de produção são gerados **na VM** pelo `setup-server.sh`; as
  credenciais do pipeline vivem só em GitHub Secrets.

### Integração e entrega contínuas (`.github/workflows/deploy.yml`)

| Job | O que faz |
|---|---|
| `test` | `npm ci`, `npm audit --omit=dev --audit-level=critical`, `npm test`, `npm run build`; guarda o build como artefato |
| `deploy` | só em push na `main`: `rsync` de `dist/`, `public/`, `views/` para `/opt/memo-pill`, `npm ci --omit=dev` na VM, `pm2 startOrReload`, e confere se `/login` responde |

Decisões de segurança do pipeline:

- **Credenciais só em GitHub Secrets.** O YAML não contém IP, usuário nem chave.
- **`SSH_KNOWN_HOSTS` fixado**, com `StrictHostKeyChecking yes`: o pipeline
  recusa um servidor que não seja o seu, em vez de aceitar qualquer host.
- **Chave dedicada a um usuário sem sudo** (`deploy`), dono apenas de
  `/opt/memo-pill`. Vazar essa chave não dá controle da máquina.
- **`permissions: contents: read`** — o token do workflow não pode escrever no repositório.
- **O `.env` e o banco não viajam.** O `rsync --delete` atua dentro de cada
  diretório enviado; `.env`, `data/` e `node_modules/` da VM ficam intactos.
- **Pull request só testa**; publicar é exclusivo do push na `main`.

### Pontos que não são opcionais

- **`NODE_ENV=production` é obrigatório** (vem do `ecosystem.config.js`). É essa
  variável que troca `synchronize` por `migrationsRun`: com ela, as migrations
  versionadas de `dist/database/migrations/` são aplicadas no boot; sem ela, o
  TypeORM sincroniza o schema a partir das entidades — aceitável em
  desenvolvimento e inaceitável sobre dados reais. Ela também liga HSTS,
  `upgrade-insecure-requests`, cookies `Secure` e o `trust proxy`.
- **Instância única em fork.** O agendador roda dentro do processo; em cluster
  mode cada dose seria notificada N vezes.
- **`trust proxy` restrito ao loopback.** Atrás do Nginx, sem ele toda
  requisição parece vir de `127.0.0.1` e o rate limit por IP vira um balde
  único para todos os usuários (`configure-app.ts`).
- **Backup do `DATABASE_PATH`.** Não há rotina de backup no código — ver
  "Pontos de atenção" abaixo.

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

299 testes em 17 suítes, cobrindo quatro níveis:

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
| `POST` | `/auth/cadastro`, `/auth/login`, `/auth/refresh` | Sessão |
| `POST` | `/auth/logout` | Sai deste aparelho (revoga o token por `jti`) |
| `POST` | `/auth/sair-de-todos` | Sai de todos (avança `sessions_version`) |
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

## Segurança — OWASP Top 10:2025

### As três categorias escolhidas

A disciplina exige a mitigação de no mínimo três categorias do
[OWASP Top 10:2025](https://owasp.org/Top10/2025/). As três escolhidas como
entrega principal, com o ponto exato do código:

| Categoria | Como o código previne | Onde |
|---|---|---|
| **A01:2025 — Broken Access Control** | Guard de sessão em toda classe de controller; toda consulta filtrada por `user_id`; recurso alheio devolve 404; `ParseUUIDPipe` em todo `:id` | `src/auth/session.guard.ts`, `medications.service.ts` (`requireOwned`), `doses.service.ts` |
| **A05:2025 — Injection** | Queries parametrizadas (TypeORM); escape do Handlebars; CSP sem `unsafe-inline`; `ValidationPipe` com `whitelist` + `forbidNonWhitelisted` | `src/configure-app.ts`, `src/app.module.ts`, DTOs em `*/dto/`, `test/dashboard.view.spec.ts` |
| **A07:2025 — Authentication Failures** | bcrypt; rate limit de 5/min no login; anti-enumeração por tempo constante; tokens tipados; logout que revoga o token no servidor | `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, `src/logout/` |

As demais categorias também têm controles, documentados abaixo com o mesmo
rigor — e com as lacunas nomeadas, sem maquiagem.

| # | Risco | Situação | Principal controle |
|---|---|---|---|
| A01 | Broken Access Control (inclui SSRF) | Coberto · SSRF parcial | `SessionGuard` + escopo por `user_id`; push sem allowlist de host |
| A02 | Security Misconfiguration | Coberto | Helmet/CSP explícita, segredos só em env, `trust proxy` restrito, firewall mínimo |
| A03 | Software Supply Chain Failures | **Parcial** | `npm ci` com lock, `npm audit` no CI; `multer` transitivo pendente |
| A04 | Cryptographic Failures | Coberto | bcrypt, JWT, cookies `HttpOnly`/`Secure`, TLS 1.2+/PQC + HSTS |
| A05 | Injection | Coberto | Queries parametrizadas, escape do Handlebars, CSP sem `unsafe-inline` |
| A06 | Insecure Design | Coberto | ADR-001, CSRF, idempotência, claim atômico, consentimento obrigatório |
| A07 | Authentication Failures | Coberto | Rate limit, anti-enumeração, tokens tipados, revogação, Fail2Ban no SSH |
| A08 | Software or Data Integrity Failures | Coberto | Zero CDN, migrations versionadas, artefato testado é o publicado |
| A09 | Security Logging and Alerting Failures | **Parcial** | Log de push/agendador; sem trilha de autenticação |
| A10 | Mishandling of Exceptional Conditions | Coberto | Filtro único de exceções, falha fechada no boot, sem vazamento de stack |

### A01:2025 — Broken Access Control

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

#### SSRF (incorporado ao A01 na edição 2025)

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

### A02:2025 — Security Misconfiguration

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
- **`trust proxy` só para o loopback em produção** (`configure-app.ts`): sem
  ele, atrás do Nginx, todo cliente teria o IP `127.0.0.1` e o rate limit seria
  um contador único compartilhado por todos; com `true` em vez de `loopback`,
  qualquer cliente forjaria o próprio IP via `X-Forwarded-For`.
- **Infraestrutura mínima:** NSG da Azure e UFW com entrada apenas em 22, 80 e
  443; SSH sem senha e sem root; `server_tokens off` no Nginx.

### A03:2025 — Software Supply Chain Failures

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

  O pipeline roda `npm audit --omit=dev --audit-level=critical` a cada push e
  bloqueia o deploy se aparecer vulnerabilidade crítica.

### A04:2025 — Cryptographic Failures

- **Senhas:** bcrypt com custo injetável (`auth.service.ts:44`); o DTO limita a
  senha a 72 bytes porque o bcrypt trunca acima disso, o que silenciosamente
  encurtaria a senha efetiva. A senha em claro nunca é persistida
  (`user.entity.ts`).
- **Sessão:** JWT assinado com `JWT_SECRET`; access token de 15 minutos vive só
  em memória no cliente, refresh de 30 dias em cookie `HttpOnly`, `Secure` em
  produção, `SameSite=Lax` (`auth.controller.ts:62-67`). `Lax` e não `Strict` é
  escolha deliberada: `Strict` suprimiria o cookie na navegação vinda do clique
  na notificação push, que é o fluxo central do produto — e é justamente por
  isso que existe token CSRF (ver A06).
- **Token CSRF:** `randomBytes(32)` e comparação em tempo constante com
  `timingSafeEqual` (`csrf.service.ts:18`, `:25`).
- **Em trânsito:** TLS termina no Nginx e o HSTS só é anunciado em produção
  (`configure-app.ts:39`) — anunciá-lo sobre http em desenvolvimento seria
  ruído inútil.
- **Dado de saúde não trafega por terceiro:** o payload enviado ao push service
  (FCM/APNs) contém apenas `{ doseId }`; o nome do medicamento é resolvido pelo
  Service Worker em `/doses/:id/resumo`, na própria origem.
- **TLS na borda com PQC:** Nginx aceita só TLS 1.2/1.3 e oferece primeiro o
  grupo híbrido `X25519MLKEM768` (`deploy/nginx/memo-pill.conf`); certificado
  Let's Encrypt para o IP, renovado automaticamente.

### A05:2025 — Injection

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

### A06:2025 — Insecure Design

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

### A07:2025 — Authentication Failures

- **Rate limiting em rotas de credencial:** 5 tentativas por minuto em
  `/auth/login` e `/auth/cadastro` via `@Throttle`
  (`auth.controller.ts:30`, `:38`), contra o limite geral de 50/min do resto da
  aplicação.
- **Anti-enumeração de usuários:** login inexistente compara a senha contra um
  hash descartável (`auth.service.ts:58`, `:103`) para que o tempo de resposta
  não revele quais e-mails existem; a mensagem de erro é a mesma nos dois casos
  ("Credenciais inválidas").
- **Tokens tipados.** O payload carrega `kind: 'access' | 'refresh'` e o refresh
  é rejeitado se o tipo não bater — um access token não pode ser reapresentado
  como refresh.
- **Logout que vale no servidor.** O refresh token é um JWT de 30 dias: apagar o
  cookie não o desfaz, e uma cópia dele continuaria abrindo a conta até expirar.
  Sair revoga o token de fato, por dois caminhos complementares:
  - **Este aparelho:** o `jti` do token vai para `revoked_tokens` e
    `userFromToken` passa a recusá-lo, sem tocar nas outras sessões. Um cron
    diário descarta as revogações cujo token já venceu sozinho, para a tabela
    não crescer indefinidamente.
  - **Todos os aparelhos:** `users.sessions_version` é incrementado, e todo
    token emitido na geração anterior é recusado de uma vez. É um contador, e
    não um instante de corte, porque com timestamp o token emitido no mesmo
    segundo do logout escaparia da comparação.

  Junto com isso, o logout apaga o cookie de sessão **e** o de CSRF (vinculado à
  sessão, ele passaria para a próxima pessoa a usar o aparelho) e desliga a
  inscrição push do aparelho — a notificação carrega nome de medicamento e
  horário, e seguiria chegando para quem ficasse com o aparelho.
- **Sem cache das páginas autenticadas.** `NoStoreInterceptor` põe
  `Cache-Control: no-store, private` em toda resposta do Nest: sem isso, o botão
  Voltar depois de sair reexibe o dashboard a partir do cache do navegador, com
  os medicamentos na tela e sem sessão nenhuma para autorizar aquilo. Os assets
  estáticos seguem cacheáveis — não carregam dado de ninguém.
- **Sair é à prova de falha.** A rota não tem guard de sessão (sair com a sessão
  vencida leva ao mesmo lugar), é idempotente, e o endpoint push vai num campo
  do formulário em vez de numa chamada JavaScript antes do submit: se o script
  falhar, o usuário sai do mesmo jeito.
- Senha mínima de 8 caracteres; e-mail normalizado (`trim`/`lowercase`) antes de
  comparar, para que não existam duas contas com o mesmo e-mail em caixas
  diferentes.
- **Na infraestrutura:** o SSH da VM aceita apenas chave, e o Fail2Ban bane
  por 24 h o IP que errar 4 vezes (`deploy/fail2ban/jail.local`).

### A08:2025 — Software or Data Integrity Failures

- **Nenhum recurso de terceiros em runtime.** Sem CDN, sem fonte externa, sem
  script de analytics: Tailwind é compilado para `public/css/app.css` e a CSP
  restringe scripts e estilos a `'self'`. Não existe origem externa capaz de
  alterar o que o navegador executa — que é exatamente o vetor deste item.
- **Integridade da cadeia de build:** `package-lock.json` no repositório +
  `npm ci` (que falha se o lock divergir do `package.json`, em vez de
  "consertar" a árvore).
- **Integridade do schema:** em produção o schema vem de migrations
  versionadas aplicadas no boot, nunca de alteração manual no banco.
- **Integridade da entrega:** o que chega à VM é exatamente o que passou nos
  testes no GitHub Actions — o artefato do job `test` é o que o job `deploy`
  publica, e a identidade do servidor é conferida por `known_hosts` fixado.

### A09:2025 — Security Logging and Alerting Failures

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

### A10:2025 — Mishandling of Exceptional Conditions

Categoria nova da edição 2025: o que a aplicação faz quando algo sai do
caminho feliz. A regra aqui é **falhar fechado e falar pouco**.

- **Um único filtro de exceções** (`src/common/http-error.filter.ts`), com
  `@Catch()` sem tipo: nenhuma exceção escapa sem tratamento. Erro que não é
  `HttpException` vira 500 com mensagem genérica — `stack`, mensagem do SQLite
  e nomes de tabela ficam só no log do servidor.
- **Falha fechada no boot:** sem `JWT_SECRET` ou chaves VAPID a aplicação não
  sobe (`src/config/configuration.ts`). Não existe valor padrão que a faça
  rodar insegura.
- **Sessão ausente ou inválida nega o acesso**, nunca o concede: o guard lança
  401 e o filtro leva ao login.
- **Resposta interrompida** (erro no meio da renderização) é encerrada com
  `res.end()` em vez de tentar escrever um segundo cabeçalho.
- **Redirecionamento de erro não vira open redirect:** o `Referer` só é
  aproveitado se for do mesmo host; qualquer outra coisa cai na rota padrão.
- **Condições esperadas não são erro:** registrar a mesma dose duas vezes é
  idempotente, e a inscrição push que o serviço responde como expirada (404/410)
  é removida, com até 3 tentativas para falhas transitórias.
- **Logout à prova de falha:** sem guard e idempotente — sair com sessão vencida
  ou com o JavaScript quebrado leva ao mesmo lugar.

### Lacunas conhecidas

Listadas porque um TCC ganha mais em reconhecer o limite do escopo do que em
alegar cobertura que não tem:

1. **`multer` transitivo vulnerável** (A03) — sem impacto prático hoje; corrigir
   com override.
2. **Sem trilha de auditoria de autenticação** (A09).
3. **Sem allowlist de host no endpoint push** (A01).
4. **Sem MFA e sem recuperação de senha** (A07) — fora do escopo.
5. **Banco não cifrado em repouso.** O arquivo SQLite é legível por qualquer
   processo com acesso ao disco da VPS; a proteção é o controle de acesso do
   sistema operacional.
6. **Exclusão de conta não implementada** (LGPD, Art. 18) — não existe rota que
   apague os dados do titular. O soft delete de medicamento preserva histórico
   por decisão de produto e não é mecanismo de exclusão de dados pessoais.

## Desenvolvimento assistido por IA

O código foi escrito, revisado e auditado com **Claude Code** (Anthropic), um
ambiente de desenvolvimento baseado em IA equivalente ao Google Antigravity
indicado na disciplina. A IA foi usada para:

- **Geração de código** a partir do ADR-001, módulo por módulo, com os testes
  escritos junto (299 testes).
- **Auditoria de segurança**: revisão de cada controle contra o OWASP Top
  10:2025 — foi numa dessas revisões que apareceu a falta do `trust proxy`
  atrás do Nginx, que anulava o rate limit por IP em produção.
- **Depuração e refatoração**: corrida no registro de parciais do Handlebars,
  revogação de sessão no servidor, tratamento de erro navegador × Service Worker.
- **Infraestrutura como código**: workflow do GitHub Actions, configuração do
  Nginx com PQC, Fail2Ban, endurecimento do SSH e script de provisionamento.

Toda sugestão passou por revisão humana e pela suíte de testes antes do commit.

## Convenção de idioma

Identificadores, nomes de arquivo, colunas do banco e campos de formulário em
**inglês**. Texto visível ao usuário, comentários e descrições de teste em
**pt-BR**. As rotas seguem em pt-BR (`/doses/hoje`, `/medicamentos`,
`/historico`, `/cadastro`), acompanhando a interface.

## Estrutura

```
src/
  auth/          cadastro, login, refresh, guard de sessão
  common/        relógio injetável, CSRF, flash/toast, filtro de erro, no-store, helpers de view
  logout/        encerramento de sessão — cruza auth e push, por isso módulo próprio
  config/        leitura e validação de variáveis de ambiente
  database/      PRAGMAs do SQLite, data source e migrations
  doses/         geração, agendador (cron), registro de adesão, histórico
  medications/   CRUD com soft delete e materialização de doses
  push/          inscrições e entrega Web Push
  users/         entidade de usuário
  configure-app.ts   Express, Helmet/CSP e view engine — compartilhado com o e2e
views/           dashboard, login, medications, medication-new, history, error
  partials/      nav (sidebar + barra inferior), toast e logout
public/          Service Worker, inscrição push, manifest, CSS compilado e ícones
test/            e2e e renderização de view
deploy/          Nginx (TLS/PQC, em container), Fail2Ban, SSH, provisionamento, deploy.sh e teste local
.github/workflows/deploy.yml   CI/CD: testes, build e deploy na Azure a cada push na main
ecosystem.config.js            processo PM2 de produção
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
