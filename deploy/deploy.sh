#!/usr/bin/env bash
# Publica o build no servidor. É o mesmo script no GitHub Actions e no teste
# local (deploy/local-test/run.sh) — o que o teste exercita é o deploy real.
#
# Uso, a partir de um diretório com dist/, public/, views/, package*.json e
# ecosystem.config.js:
#   deploy/deploy.sh <host-ssh>
# Variáveis: APP_DIR (padrão /opt/memo-pill), SSH_ARGS (ex.: "-F arquivo").
set -euo pipefail

HOST="${1:?informe o host SSH}"
APP_DIR="${APP_DIR:-/opt/memo-pill}"
SSH_ARGS="${SSH_ARGS:-}"
# shellcheck disable=SC2086
remote() { ssh $SSH_ARGS "$HOST" "$@"; }

# Um rsync por diretório, com barra no fim: o --delete age só dentro de cada
# um, e .env, data/ e node_modules/ do servidor nunca entram na conta.
for dir in dist public views; do
  rsync -az --delete -e "ssh $SSH_ARGS" "$dir/" "$HOST:$APP_DIR/$dir/"
done
rsync -az -e "ssh $SSH_ARGS" package.json package-lock.json ecosystem.config.js "$HOST:$APP_DIR/"

# Dependências instaladas no servidor (e não copiadas) porque bcrypt e
# better-sqlite3 são nativos e precisam casar com o SO de lá. As migrations
# rodam no boot (NODE_ENV=production no ecosystem).
remote "cd $APP_DIR \
  && npm ci --omit=dev --no-audit --no-fund \
  && pm2 startOrReload ecosystem.config.js --update-env \
  && pm2 save"

remote 'for i in $(seq 1 15); do
  curl -fs -o /dev/null http://127.0.0.1:3000/login && echo "Aplicação no ar." && exit 0
  sleep 2
done
pm2 logs lembrete-medicamentos --lines 50 --nostream
exit 1'
