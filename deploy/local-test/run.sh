#!/usr/bin/env bash
# Teste local da produção: Nginx em container (PQC), "VM" Debian 12 com sshd,
# deploy pelo mesmo deploy/deploy.sh do GitHub Actions e verificações.
#
#   deploy/local-test/run.sh          sobe, publica e testa (deixa no ar)
#   deploy/local-test/run.sh down     derruba tudo e apaga os temporários
#
# Precisa de: docker (compose), rsync, ssh e OpenSSL 3.5+ no host (para o
# handshake pós-quântico). O que NÃO dá para testar aqui: certificado
# Let's Encrypt para IP (exige IP público), UFW e Fail2Ban (exigem
# systemd/iptables) — esses se conferem na VM, na saída do setup-server.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$HERE/.work"
COMPOSE=(docker compose -f "$HERE/compose.yaml")
HTTP=http://127.0.0.1:8080
HTTPS=https://127.0.0.1:8443

if [[ "${1:-}" == "down" ]]; then
  "${COMPOSE[@]}" down -v --remove-orphans
  rm -rf "$WORK"
  exit 0
fi

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
PASS=0 FAIL=0
ok()   { printf '  \033[32m✅ %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
nok()  { printf '  \033[31m❌ %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else nok "$desc"; fi; }

step "Preparando temporários em $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"/{nginx,certbot,letsencrypt/live/127.0.0.1}
# Chave do "pipeline" e certificado autoassinado ECDSA P-256 — o mesmo tipo
# que o Certbot emite. Nada disso sai desta pasta (.gitignore).
ssh-keygen -q -t ed25519 -N "" -C local-test -f "$WORK/id_deploy"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 7 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
  -keyout "$WORK/letsencrypt/live/127.0.0.1/privkey.pem" \
  -out "$WORK/letsencrypt/live/127.0.0.1/fullchain.pem" 2>/dev/null
chmod 644 "$WORK/letsencrypt/live/127.0.0.1/privkey.pem"
# Sem domínio no teste local: o bloco do domínio sai, como no setup-server.sh.
sed -e "s/__PUBLIC_IP__/127.0.0.1/g" -e '/# BEGIN DOMAIN/,/# END DOMAIN/d' \
  "$ROOT/deploy/nginx/memo-pill.conf" > "$WORK/nginx/memo-pill.conf"

step "Subindo os containers"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" exec -T nginx nginx -t

step "Chave do pipeline e .env no servidor"
"${COMPOSE[@]}" exec -T server bash -c \
  'cat > /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys' \
  < "$WORK/id_deploy.pub"
# Mesma geração de segredos do setup-server.sh. THROTTLE_GENERAL baixo só
# para o teste de rate limit caber em poucas requisições.
"${COMPOSE[@]}" exec -T -u deploy -w /opt/memo-pill server bash -c '
  set -e
  VAPID_JSON="$(npx --yes web-push generate-vapid-keys --json)"
  cat > .env <<EOF
PORT=3000
DATABASE_PATH=data/app.db
JWT_SECRET=$(node -e "console.log(require(\"crypto\").randomBytes(48).toString(\"hex\"))")
VAPID_PUBLIC_KEY=$(node -pe "JSON.parse(process.argv[1]).publicKey" "$VAPID_JSON")
VAPID_PRIVATE_KEY=$(node -pe "JSON.parse(process.argv[1]).privateKey" "$VAPID_JSON")
VAPID_SUBJECT=mailto:teste@example.com
THROTTLE_GENERAL=8
EOF
  chmod 600 .env'

for i in $(seq 1 10); do
  ssh-keyscan -p 2222 -t ed25519 127.0.0.1 2>/dev/null > "$WORK/known_hosts"
  [[ -s "$WORK/known_hosts" ]] && break
  sleep 1
done
cat > "$WORK/ssh_config" <<EOF
Host prod
  HostName 127.0.0.1
  Port 2222
  User deploy
  IdentityFile $WORK/id_deploy
  IdentitiesOnly yes
  UserKnownHostsFile $WORK/known_hosts
  StrictHostKeyChecking yes
EOF

step "Build (o mesmo do job test do GitHub Actions)"
(cd "$ROOT" && npm run build >/dev/null)

step "Deploy com deploy/deploy.sh — duas vezes, para exercitar o redeploy"
cd "$ROOT"
export SSH_ARGS="-F $WORK/ssh_config"
bash deploy/deploy.sh prod
ENV_SUM_1="$(ssh $SSH_ARGS prod 'sha256sum /opt/memo-pill/.env')"
bash deploy/deploy.sh prod
ENV_SUM_2="$(ssh $SSH_ARGS prod 'sha256sum /opt/memo-pill/.env')"

step "Verificações"

echo "Servidor / deploy"
check ".env intacto após redeploy (rsync --delete não o alcança)" \
  test "$ENV_SUM_1" = "$ENV_SUM_2"
check "banco criado e migrations aplicadas no boot" \
  ssh $SSH_ARGS prod 'test -s /opt/memo-pill/data/app.db'
check "PM2 com o processo online, em fork, 1 instância" \
  bash -c "ssh $SSH_ARGS prod 'pm2 jlist' | node -e '
    const l = JSON.parse(require(\"fs\").readFileSync(0, \"utf8\"));
    const p = l.filter(x => x.name === \"lembrete-medicamentos\");
    process.exit(p.length === 1 && p[0].pm2_env.status === \"online\" && p[0].pm2_env.exec_mode === \"fork_mode\" ? 0 : 1)'"

check "porta 3000 inacessível de fora do servidor (app só no loopback)" bash -c "
  ! ${COMPOSE[*]} exec -T outsider curl -s -m 5 -o /dev/null http://server:3000/login"

echo "SSH"
check "login por senha recusado (só publickey é oferecido)" bash -c "
  out=\$(ssh -F $WORK/ssh_config -o BatchMode=yes -o PubkeyAuthentication=no \
    -o PreferredAuthentications=password,keyboard-interactive prod true 2>&1 || true)
  grep -q 'Permission denied (publickey)' <<<\"\$out\""
check "login de root recusado" bash -c "
  ! ssh -F $WORK/ssh_config -o BatchMode=yes -l root prod true 2>/dev/null"

echo "Nginx / HTTP(S)"
check "HTTP responde 301 para HTTPS" bash -c "
  r=\$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $HTTP/login)
  [[ \$r == '301 https://'* ]]"
HEADERS="$(curl -sk -D - -o /dev/null "$HTTPS/login")"
check "HTTPS serve a aplicação (200 em /login)" grep -q '^HTTP/[0-9.]* 200' <<<"$HEADERS"
check "HSTS presente (NODE_ENV=production)" grep -qi '^strict-transport-security:' <<<"$HEADERS"
check "CSP presente" grep -qi '^content-security-policy:' <<<"$HEADERS"
check "Nginx sem versão no cabeçalho Server" grep -qiE '^server: nginx\s*$' <<<"$HEADERS"

echo "TLS / PQC"
NGINX_OPENSSL="$("${COMPOSE[@]}" exec -T nginx nginx -V 2>&1 | grep -o 'OpenSSL [0-9][0-9.]*' | tail -1)"
echo "  (Nginx do container: $NGINX_OPENSSL · cliente: $(openssl version | cut -d' ' -f1-2))"
tls() { openssl s_client -connect 127.0.0.1:8443 -servername 127.0.0.1 "$@" </dev/null 2>&1; }
PQC_OUT="$(tls -groups X25519MLKEM768)"
check "handshake PQC: grupo X25519MLKEM768 negociado" \
  grep -qE '(Temp Key|group): X25519MLKEM768' <<<"$PQC_OUT"
check "cliente com preferência padrão recebe PQC (servidor oferece primeiro)" \
  grep -qE '(Temp Key|group): X25519MLKEM768' <<<"$(tls)"
check "fallback clássico (X25519) segue funcionando" \
  grep -qE '(Temp Key|group): X25519(,|$)' <<<"$(tls -groups X25519)"
check "TLS 1.2 aceito" grep -q 'Protocol *: TLSv1.2' <<<"$(tls -tls1_2)"
check "TLS 1.1 recusado" bash -c "! openssl s_client -connect 127.0.0.1:8443 -tls1_1 </dev/null 2>&1 | grep -q 'Protocol *: TLSv1.1'"

echo "Rate limit atrás do proxy (trust proxy)"
# Cada requisição forja um X-Forwarded-For diferente: o Nginx sobrescreve o
# cabeçalho com o IP real, então forjar não pode escapar do limite.
GOT_429=0
for i in $(seq 1 15); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 10.9.8.$i" "$HTTPS/login")
  [[ $code == 429 ]] && { GOT_429=1; break; }
done
check "cliente bloqueado com 429 mesmo forjando X-Forwarded-For" test "$GOT_429" = 1
check "outro cliente (outro IP) segue com 200 — limite é por cliente, não global" bash -c "
  [[ \$(${COMPOSE[*]} exec -T outsider curl -sk -o /dev/null -w '%{http_code}' https://server/login) == 200 ]]"

printf '\n\033[1m%d passaram, %d falharam.\033[0m\n' "$PASS" "$FAIL"
echo "Ambiente no ar: $HTTPS  (certificado autoassinado)."
echo "Para derrubar: deploy/local-test/run.sh down"
[[ $FAIL -eq 0 ]]
