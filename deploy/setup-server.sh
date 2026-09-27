#!/usr/bin/env bash
# Provisionamento único da VM Debian 12 (bookworm).
#
# PQC no Debian 12: o OpenSSL do sistema é 3.0, sem o grupo X25519MLKEM768.
# Por isso o Nginx roda em container, da imagem oficial nginx:alpine, que traz
# OpenSSL 3.5+. O resto (SSH, UFW, Fail2Ban, Certbot, Node, PM2) fica no host.
#
# Uso, a partir da sua máquina:
#   scp -r deploy azureuser@<IP>:~/
#   ssh azureuser@<IP>
#   sudo bash ~/deploy/setup-server.sh <IP_PUBLICO> <EMAIL> "<CHAVE_PUBLICA_DO_PIPELINE>"
#
# Antes de rodar, confirme que você entra na VM pela SUA chave SSH: este script
# desliga o login por senha.
set -euo pipefail

PUBLIC_IP="${1:?informe o IP público}"
EMAIL="${2:?informe o e-mail para a Let’s Encrypt}"
DEPLOY_PUBKEY="${3:?informe a chave pública (ed25519) do GitHub Actions}"

APP_DIR=/opt/memo-pill
NGINX_IMAGE="${NGINX_IMAGE:-nginx:mainline-alpine}"
NGINX_CONF_DIR=/etc/memo-pill/nginx
DEPLOY_USER=deploy
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ $EUID -eq 0 ]] || { echo "Rode com sudo." >&2; exit 1; }

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

. /etc/os-release
if [[ "$ID" != "debian" || "${VERSION_ID%%.*}" -lt 12 ]]; then
  echo "Esperado Debian 12 ou superior; encontrado $PRETTY_NAME." >&2
  exit 1
fi

step "Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y docker.io ufw fail2ban python3-systemd rsync curl ca-certificates \
  build-essential python3 snapd unattended-upgrades

# Logs dos containers com rotação: o padrão do Docker cresce sem limite.
install -d /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl enable docker
systemctl restart docker

step "SSH: somente chave, sem senha, sem root"
install -m 644 "$HERE/ssh/00-hardening.conf" /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t
systemctl reload ssh

step "Firewall (UFW): apenas 22, 80 e 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "Fail2Ban: 4 tentativas, 24h de banimento"
install -m 644 "$HERE/fail2ban/jail.local" /etc/fail2ban/jail.local
systemctl enable fail2ban
systemctl restart fail2ban

step "Node.js 22 e PM2"
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

step "Usuário de deploy e diretório da aplicação"
id "$DEPLOY_USER" &>/dev/null || adduser --disabled-password --gecos "" "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
printf '%s\n' "$DEPLOY_PUBKEY" > "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/data"

if [[ ! -f "$APP_DIR/.env" ]]; then
  # Segredos gerados aqui, na própria VM: nunca passam pelo GitHub.
  VAPID_JSON="$(npx --yes web-push generate-vapid-keys --json)"
  cat > "$APP_DIR/.env" <<EOF
PORT=3000
DATABASE_PATH=data/app.db
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
VAPID_PUBLIC_KEY=$(node -pe "JSON.parse(process.argv[1]).publicKey" "$VAPID_JSON")
VAPID_PRIVATE_KEY=$(node -pe "JSON.parse(process.argv[1]).privateKey" "$VAPID_JSON")
VAPID_SUBJECT=mailto:$EMAIL
EOF
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

# O PM2 volta sozinho depois de um reboot da VM.
env PATH="$PATH" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER"

step "Certbot (snap) — precisa ser 5.4 ou superior"
snap install core
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot
certbot --version
if ! certbot --help all | grep -q -- '--ip-address'; then
  echo "Este Certbot não emite certificado para IP. Atualize: snap refresh certbot" >&2
  exit 1
fi

step "Nginx em container, com OpenSSL 3.5+ (requisito de PQC)"
docker pull "$NGINX_IMAGE"
NGINX_OPENSSL="$(docker run --rm "$NGINX_IMAGE" nginx -V 2>&1 \
  | grep -o 'OpenSSL [0-9][0-9.]*' | tail -1 | cut -d' ' -f2)"
echo "Imagem $NGINX_IMAGE com OpenSSL $NGINX_OPENSSL"
if [[ "$(printf '3.5.0\n%s\n' "$NGINX_OPENSSL" | sort -V | head -1)" != "3.5.0" ]]; then
  echo "A imagem $NGINX_IMAGE não tem OpenSSL 3.5+; PQC não funcionaria." >&2
  exit 1
fi

# Se o Nginx do apt estiver instalado, ele disputaria as portas 80/443.
if systemctl list-unit-files nginx.service &>/dev/null; then
  systemctl disable --now nginx || true
fi

install -d /var/www/certbot "$NGINX_CONF_DIR"
# Primeiro, só a porta 80 com o desafio ACME: o memo-pill.conf aponta para um
# certificado que ainda não existe, e o Nginx se recusaria a subir.
rm -f "$NGINX_CONF_DIR"/*.conf
install -m 644 "$HERE/nginx/acme-bootstrap.conf" "$NGINX_CONF_DIR/memo-pill.conf"

# --network host: sem NAT do Docker. O Nginx escuta direto nas portas do host,
# o UFW continua valendo (porta publicada com -p passaria por fora dele), o
# proxy alcança 127.0.0.1:3000 e $remote_addr é o IP real do cliente.
docker rm -f nginx &>/dev/null || true
docker run -d --name nginx --restart unless-stopped --network host \
  --security-opt no-new-privileges \
  -v "$NGINX_CONF_DIR":/etc/nginx/conf.d:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -v /var/www/certbot:/var/www/certbot:ro \
  "$NGINX_IMAGE"
sleep 2
docker exec nginx nginx -t

step "Certificado Let's Encrypt para $PUBLIC_IP"
# Certificado de IP só existe no perfil shortlived (validade de ~6 dias): a
# renovação automática do timer do snap é o que o mantém de pé, e o hook
# recarrega o Nginx do container com o certificado novo.
if [[ ! -d "/etc/letsencrypt/live/$PUBLIC_IP" ]]; then
  certbot certonly --non-interactive --agree-tos -m "$EMAIL" \
    --webroot -w /var/www/certbot \
    --preferred-profile shortlived \
    --ip-address "$PUBLIC_IP" \
    --deploy-hook "docker exec nginx nginx -s reload"
fi

step "Nginx definitivo (HTTPS + redirecionamento + PQC)"
sed "s/__PUBLIC_IP__/$PUBLIC_IP/g" "$HERE/nginx/memo-pill.conf" \
  > "$NGINX_CONF_DIR/memo-pill.conf"
docker exec nginx nginx -t
docker exec nginx nginx -s reload

step "Conferências"
docker exec nginx nginx -V 2>&1 | grep -i openssl
curl -sSI "http://$PUBLIC_IP/" | head -1        # espera 301
curl -sSI "https://$PUBLIC_IP/login" | head -1  # 200 após o 1º deploy (antes, 502)
systemctl list-timers | grep -i certbot || true
certbot renew --dry-run
fail2ban-client status sshd
ufw status verbose

cat <<EOF

Pronto. Próximos passos:
  1. No portal da Azure, deixe o NSG da VM com entrada só em 22, 80 e 443.
  2. Na sua máquina:  ssh-keyscan -t ed25519 $PUBLIC_IP   → secret SSH_KNOWN_HOSTS
  3. Faça um push na main: o GitHub Actions publica em $APP_DIR.
EOF
