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
      env: { NODE_ENV: 'production' },
    },
  ],
};
