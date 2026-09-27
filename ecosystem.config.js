/**
 * Processo de produção no PM2 (ADR-001 §2.5).
 *
 * Instância única em fork: o agendador de doses roda dentro do processo, e em
 * cluster cada worker notificaria a mesma dose. `cwd` fixo porque o `.env` e o
 * `DATABASE_PATH` relativo são resolvidos a partir dele.
 */
module.exports = {
  apps: [
    {
      name: 'lembrete-medicamentos',
      script: 'dist/main.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '400M',
      // Só o Nginx, na mesma máquina, fala com a aplicação: fora do loopback a
      // porta 3000 não existe, mesmo que o firewall falhe.
      env: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    },
  ],
};
