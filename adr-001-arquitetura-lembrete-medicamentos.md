# ADR 001: Arquitetura do Sistema de Lembrete de Medicamentos

| Metadado | Detalhe |
|---|---|
| **Status** | Aprovado |
| **Data** | 30 de Agosto de 2026 |
| **Decisores** | Engenharia de Software |

---

## 1. Contexto do Problema

O objetivo é construir um sistema de lembrete de medicamentos focado em alta usabilidade, adesão a tratamentos e baixo custo operacional inicial.

A solução precisa:
1. Funcionar de forma responsiva na web sem exigir desenvolvimento de aplicativos móveis nativos (iOS/Android) no momento inicial.
2. Disparar notificações push mesmo com a aba ou navegador em segundo plano.
3. Manter histórico analítico de adesão às doses (inclusive de medicamentos removidos).
4. Operar em uma infraestrutura enxuta (VPS única) com segurança e controle de acessos.

A restrição de custo é determinante: o projeto deve caber em **uma única VPS**, sem serviços gerenciados, sem servidor de banco de dados dedicado e sem processos adicionais que impliquem uma segunda instância. Essa restrição justifica boa parte das decisões abaixo e está detalhada na seção 3 (Alternativas Consideradas).

---

## 2. Decisões Arquiteturais

### 2.1 Stack Tecnológica e Renderização
* **Framework Back-end:** NestJS com TypeScript, aproveitando injeção de dependências e modularidade.
* **Camada de Visão (SSR):** Handlebars (`hbs`) integrado diretamente ao NestJS para renderização server-side. A renderização ocorre **no mesmo processo** que serve a API, evitando a instância adicional que um front-end separado exigiria.
* **Cliente Web (PWA):** Uso de *Service Worker* estático (`sw.js`) e Web App Manifest para permitir instalação na tela inicial e recebimento de alertas via **Web Push API** com chaves **VAPID**.
* **Biblioteca de Push:** Pacote `web-push` no Node.js para envio de payloads criptografados aos push services (Google FCM, Apple Push Notification service).

#### Confirmação da dose pela notificação
A notificação carrega ações próprias, permitindo que o usuário registre a adesão sem abrir a aplicação — reduzindo o atrito no fluxo central do sistema:

* Ação **"Tomei"** → transição para `TAKEN`.
* Ação **"Pular"** → transição para `SKIPPED`.
* Clique no corpo da notificação → abre `/doses/hoje`.

O Service Worker trata o evento `notificationclick` e emite a requisição com `credentials: 'include'`. Como o cookie de sessão é `HttpOnly`, ele acompanha a requisição automaticamente e **nenhum token precisa ser armazenado dentro do Service Worker**.

O token CSRF é obtido sob demanda em `GET /csrf` imediatamente antes do `POST`, em vez de trafegar no payload da notificação. Isso mantém o payload push restrito ao identificador da dose e garante que o token corresponda à sessão vigente no momento do clique — que pode ocorrer horas depois do envio da notificação.

```js
self.addEventListener('notificationclick', (event) => {
  const { doseId } = event.notification.data;
  const action = event.action;
  event.notification.close();

  if (action !== 'taken' && action !== 'skipped') {
    event.waitUntil(clients.openWindow('/doses/hoje'));
    return;
  }

  event.waitUntil(
    fetch('/csrf', { credentials: 'include' })
      .then((res) => res.json())
      .then(({ csrfToken }) =>
        fetch(`/doses/${doseId}/${action}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': csrfToken },
        }),
      )
      .catch(() => clients.openWindow('/doses/hoje')),
  );
});
```

Se qualquer uma das duas requisições falhar (sessão expirada, rede indisponível), o *fallback* abre a aplicação para que o usuário conclua o registro manualmente, em vez de perder a confirmação silenciosamente.

O adiamento (*snooze*) fica **fora do escopo** desta iteração, por exigir reagendamento dinâmico incompatível com a estratégia de pré-geração descrita em 2.2.

#### Ciclo de vida das inscrições push
Push services invalidam inscrições ao longo do tempo (troca de dispositivo, reinstalação, expiração). O envio trata os retornos:

* **404 / 410 Gone** → a inscrição é removida de `push_subscriptions` em definitivo.
* **429 / 5xx** → nova tentativa com *backoff* exponencial.

Sem essa rotina, a tabela acumula registros mortos e o agendador desperdiça requisições a cada minuto.

---

### 2.2 Persistência e Modelagem de Dados
* **Banco de Dados:** SQLite em arquivo local na VPS.
* **ORM:** **TypeORM**, pela integração oficial com o NestJS (`@nestjs/typeorm`), suporte a migrations versionadas e uso de parâmetros preparados por padrão.
* **Otimização de Concorrência:** Na inicialização são aplicados:
  * `PRAGMA journal_mode = WAL;` — Write-Ahead Logging, que permite leituras simultâneas sem bloqueio durante uma escrita.
  * `PRAGMA foreign_keys = ON;` — integridade referencial (desativada por padrão no SQLite).
  * `PRAGMA busy_timeout = 5000;` — aguarda até 5s por um lock antes de falhar. O WAL elimina o bloqueio *leitor × escritor*, mas **não** o limite de um escritor por vez; sem `busy_timeout`, escritas concorrentes retornam `SQLITE_BUSY` diretamente ao usuário.

#### Estratégia de Agendamento (Pré-geração)
Em vez de calcular horários sob demanda, as doses são pré-geradas na tabela `dose_logs` com status inicial `PENDING`.

* **Horizonte:** geração até `min(fim do tratamento, hoje + 90 dias)`. Tratamentos de duração definida (ex.: antibiótico de 7 dias) são gerados por inteiro; tratamentos de uso contínuo respeitam a janela de 90 dias.
* **Extensão:** uma tarefa diária estende a janela dos tratamentos contínuos. A folga de 90 dias garante que uma falha prolongada dessa tarefa não interrompa os lembretes.
* **Regeneração:** ao editar posologia ou horário, as doses futuras com status `PENDING` são marcadas como `CANCELED` e o intervalo é regerado — mesma mecânica aplicada na exclusão do medicamento.

#### Separação entre entrega e adesão
O ciclo de **envio da notificação** e o ciclo de **resposta do usuário** são independentes e ocupam colunas distintas:

* `notified_at TIMESTAMP NULL` — marca o instante do disparo. É o que o agendador consulta.
* `status` — registra a adesão e alimenta o histórico analítico:

```
                     +-----------+
                     |  PENDING  |
                     +-----------+
                    /      |      \
       "Tomei"     /       |       \    janela de tolerância expirada
      +--------+  /        |        \   +----------+
      | TAKEN  | <         |         > |  MISSED  |
      +--------+           |            +----------+
                     "Pular"|
                     +-----------+
                     |  SKIPPED  |
                     +-----------+

   CANCELED <- medicamento excluído ou posologia alterada (doses futuras)
```

Manter as duas informações na mesma coluna faria o agendador reselecionar a dose a cada minuto enquanto o usuário não confirmasse, gerando reenvio contínuo da mesma notificação.

#### Preservação de Histórico (Soft Delete)
A tabela `medications` utiliza a coluna `deleted_at`. Medicamentos apagados não sofrem `DELETE` físico, garantindo que o histórico analítico de doses tomadas permaneça acessível. Doses futuras pendentes de medicamentos excluídos têm status alterado para `CANCELED`.

#### Fuso Horário
* **Toda persistência de instantes é em UTC**, incluindo `scheduled_for`, `notified_at`, `created_at` e `deleted_at`.
* A coluna `users.timezone` (formato IANA, ex.: `America/Sao_Paulo`) é usada **apenas** em dois momentos: converter o horário informado pelo usuário para UTC durante a geração das doses, e converter de volta para exibição.
* **Limitação conhecida:** a pré-geração materializa instantes absolutos. Uma alteração nas regras de horário de verão do fuso do usuário desloca as doses já geradas dentro da janela de 90 dias. A regeneração periódica atenua o efeito, e o cenário é irrelevante para o Brasil, que não adota horário de verão desde 2019.

```
+---------------+       1:N       +--------------------+
|     users     | --------------< | push_subscriptions |
+---------------+                 +--------------------+
        |
        | 1:N
        v
+---------------+       1:N       +--------------------+
|  medications  | --------------< |     dose_logs      |
+---------------+                 +--------------------+
 (Soft Delete)                     (status + notified_at)
```

---

### 2.3 Motor de Disparos em Segundo Plano
* **Agendador:** Utilização do pacote oficial `@nestjs/schedule` executando uma tarefa cron a cada minuto (`* * * * *`).
* **Consulta Otimizada:** O cron busca as doses ainda não notificadas dentro da janela de tolerância:

```sql
SELECT * FROM dose_logs
 WHERE status = 'PENDING'
   AND notified_at IS NULL
   AND scheduled_for <= unixepoch()
   AND scheduled_for >= unixepoch() - 1800;
```

* **Índice:** `(status, scheduled_for)`. A coluna de **igualdade** vem antes da coluna de **faixa**, permitindo posicionamento direto no conjunto `PENDING` seguido de varredura ordenada. A ordem inversa obrigaria a percorrer todo o histórico passado para só então filtrar o status.
* **Nota sobre a sintaxe:** o SQLite não possui a função `NOW()`. O instante corrente é obtido por `unixepoch()`, `CURRENT_TIMESTAMP` ou `datetime('now')`.

#### Janela de tolerância e recuperação após indisponibilidade
O limite inferior de **30 minutos** existe para o cenário de queda da aplicação. Sem ele, uma indisponibilidade de algumas horas provocaria uma avalanche de notificações atrasadas no retorno do serviço. Doses cujo horário ultrapassou a janela sem notificação são marcadas como `MISSED` — permanecem no histórico de adesão, mas não geram alerta fora de hora.

#### Instância única e idempotência
* O agendador roda dentro do processo da aplicação. O PM2 é fixado em `exec_mode: fork` com `instances: 1`; em *cluster mode*, cada réplica executaria o cron e a mesma dose seria notificada N vezes.
* Como defesa adicional, a marcação de envio é um *claim* atômico — apenas a execução que efetivamente atualizar a linha realiza o disparo:

```sql
UPDATE dose_logs
   SET notified_at = unixepoch()
 WHERE id = ? AND notified_at IS NULL;
```

---

### 2.4 Segurança e Privacidade

#### Autenticação
* **Tokens:** JWT, com Access Token de curta duração e Refresh Token de longa duração.
* **Senhas:** hash com **bcrypt** (fator de custo 12). A senha em texto claro nunca é persistida nem registrada em log.
* **Armazenamento do Refresh Token:** cookie com as diretivas `HttpOnly`, `Secure` e `SameSite=Lax`.
* **Armazenamento do Access Token:** mantido **apenas em memória** no cliente. O uso de `localStorage` ou `sessionStorage` anularia a proteção obtida com o cookie `HttpOnly`, já que um script injetado conseguiria lê-lo.

#### Por que `SameSite=Lax` e não `Strict`
`Strict` suprime o cookie em navegações originadas fora do site — incluindo a abertura da aplicação a partir do clique em uma notificação push, que é justamente o fluxo central do sistema. O usuário cairia numa tela de login a cada lembrete atendido. `Lax` preserva esse fluxo e continua bloqueando requisições `POST` cross-site, que é o vetor relevante de CSRF.

#### Mitigação de CSRF
Como `Lax` isoladamente não cobre todos os cenários, todos os formulários renderizados pelo Handlebars e todas as requisições `POST`/`PUT`/`DELETE` carregam um **token CSRF sintético** vinculado à sessão, validado por *middleware* no servidor.

Para consumidores que não passam pela renderização do Handlebars — notadamente o Service Worker — o token é exposto pela rota **`GET /csrf`**, que devolve o token da sessão corrente em JSON. A rota exige autenticação, é isenta da validação de CSRF (por ser um `GET` idempotente e sem efeito colateral) e responde com `Cache-Control: no-store`, impedindo que o token seja retido pelo cache do Service Worker ou do navegador.

#### Mitigação de XSS
* Escape nativo de HTML do Handlebars na renderização (mitigação primária).
* Pacote `helmet` configurando cabeçalhos *Content Security Policy* (CSP) como defesa em profundidade.

#### Mitigação de SQL Injection
Parâmetros preparados via TypeORM em todas as consultas; concatenação de strings em SQL é vedada.

#### Rate Limiting
`@nestjs/throttler`, que implementa **contador de janela fixa** (*fixed window counter*): limite geral de **50 requisições por 60 segundos** por IP, com restrições mais rigorosas em rotas sensíveis — **5 requisições por 60 segundos** em login e cadastro.

#### Gestão de segredos
Chaves VAPID (pública e privada), segredo de assinatura do JWT e demais credenciais residem em variáveis de ambiente carregadas via `@nestjs/config`, fora do controle de versão.

#### Conformidade com a LGPD
O sistema trata dados sobre medicação, classificados como **dado pessoal sensível** pela Lei nº 13.709/2018 (Art. 5º, II — dado referente à saúde). Decisões correspondentes:

* **Base legal:** consentimento específico e destacado do titular (Art. 11, I), coletado no cadastro em tela própria, separada dos termos de uso.
* **Finalidade única:** os dados servem exclusivamente ao envio de lembretes e à exibição do histórico de adesão ao próprio titular.
* **Não compartilhamento:** nenhum dado de medicação é transmitido a terceiros. O payload enviado ao push service não contém o nome do medicamento nem credenciais — apenas um identificador opaco da dose, resolvido localmente pelo Service Worker. O conteúdo ainda assim trafega cifrado fim a fim (`aes128gcm`), ilegível para o push service.
* **Ausência de finalidade comercial:** os dados não são utilizados para publicidade, venda, cessão ou qualquer forma de monetização.
* **Direito de eliminação (Art. 18, VI):** a exclusão da conta apaga fisicamente os dados do titular, incluindo medicamentos, histórico de doses e inscrições push. Nesse caso o *soft delete* descrito em 2.2 não se aplica: ele preserva histórico **dentro** da conta, não após a sua eliminação.

---

### 2.5 Infraestrutura e Rede
* **Hospedagem:** VPS Linux gerenciada com **PM2** (`exec_mode: fork`, `instances: 1`) para gerência de processos e reinício automático da aplicação Node.js.
* **Proxy Reverso:** **Nginx** recebendo tráfego e repassando internamente para a porta da aplicação NestJS (`localhost:3000`).
* **Criptografia em Trânsito:** Certificados SSL/TLS gratuitos gerenciados e renovados automaticamente via **Certbot** (Let's Encrypt). O HTTPS é pré-requisito técnico do Service Worker e da Web Push API, não apenas uma medida de segurança.
* **Firewall (UFW):** Exposição estrita apenas das portas `22` (SSH), `80` (HTTP) e `443` (HTTPS). A porta interna da aplicação (`3000`) permanece bloqueada para a rede externa.

---

## 3. Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| **Next.js** para o front-end | Exigiria um processo Node.js adicional ao lado da API, elevando o consumo de memória e, na prática, o custo de um segundo servidor. NestJS + Handlebars entrega SSR dentro do mesmo processo. |
| **PostgreSQL / MySQL** | Demandariam um servidor de banco dedicado ou serviço gerenciado. O volume esperado (dezenas de usuários, escritas pontuais) não justifica o custo; o SQLite em arquivo atende com `fsync` local e latência menor. |
| **Aplicativo nativo (iOS/Android)** | Duas bases de código, submissão e revisão nas lojas, e ciclo de publicação lento. O PWA cobre Android, iOS 16.4+ e desktop com um único código-base. |
| **SMS ou WhatsApp** como canal de lembrete | Custo por mensagem enviada, incompatível com a premissa de custo operacional próximo de zero. A Web Push API é gratuita e já cobre as plataformas-alvo. |
| **Fila distribuída (Redis, BullMQ)** para os disparos | Introduziria um serviço adicional para um volume que uma consulta indexada por minuto resolve. Reavaliável caso o número de usuários cresça o suficiente para tornar a instância única um gargalo. |

---

## 4. Consequências e Trade-offs

### Pontos Positivos
* **Custo e Complexidade Mínimos:** Ausência de bancos gerenciados caros ou filas distribuídas externas no início. Toda a pilha roda de forma autocontida em uma única VPS.
* **Multiplataforma Imediato:** O usuário pode instalar o PWA tanto no Android quanto no iOS/Desktop sem necessidade de submissão às lojas de aplicativos.
* **Alta Eficiência de Consulta:** A pré-geração de doses e o índice composto `(status, scheduled_for)` evitam cálculos de recorrência dentro da rotina de cron a cada minuto.
* **Baixo Atrito na Adesão:** A confirmação da dose direto na notificação elimina a necessidade de abrir a aplicação, o que tende a elevar a taxa de registro — o objetivo declarado do sistema.

### Pontos de Atenção e Mitigações

* **Concorrência no SQLite:** O SQLite suporta apenas um processo de escrita por vez. Mitigado com a ativação do modo **WAL**, `busy_timeout` de 5s e transações curtas.

* **Suporte Web Push no iOS:** Requer que o usuário adicione o web app à tela de início (*Add to Home Screen*) no Safari para habilitar a permissão de notificações no iOS 16.4+. O front-end precisará orientar o usuário com um guia visual simples.

* **Instância única como teto de escala:** A fixação em `instances: 1` é condição para a corretude do agendador, mas impede escalar horizontalmente. Ultrapassar a capacidade de uma VPS exigirá extrair o agendador para um processo próprio, com coordenação por *lock* distribuído.

* **Ausência de estratégia de backup:** Decisão consciente, fora do escopo desta iteração. **Risco aceito:** a perda do disco ou da VPS implica perda total e irreversível dos dados dos usuários. Mitigação postergada para uma fase posterior do projeto.

* **Falha silenciosa do agendador:** Se o processo do cron for interrompido, nenhuma dose é notificada e **nada sinaliza a parada** — falha com potencial impacto clínico, pois o usuário confia no lembrete. Mitigação de custo zero recomendada: *ping* periódico da tarefa cron para um serviço externo de healthcheck em plano gratuito (Healthchecks.io, UptimeRobot), que alerta na ausência do sinal.

* **Volume de `dose_logs`:** A janela de 90 dias gera aproximadamente 180 registros por medicamento de uso contínuo com duas doses diárias. O crescimento é linear e previsível, mas exigirá política de arquivamento do histórico antigo em horizonte mais longo.
