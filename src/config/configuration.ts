export interface AppConfig {
  port: number;
  databasePath: string;
  jwt: { secret: string };
  throttle: { geral: number; estrito: number };
  vapid: { publicKey: string; privateKey: string; subject: string };
}

/**
 * Segredos vêm de variáveis de ambiente e nunca do controle de versão
 * (ADR-001 §2.4 — Gestão de segredos).
 */
export const configuration = (): AppConfig => ({
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? 'data/app.db',
  jwt: { secret: required('JWT_SECRET') },
  throttle: {
    geral: Number(process.env.THROTTLE_GERAL ?? 50),
    estrito: Number(process.env.THROTTLE_ESTRITO ?? 5),
  },
  vapid: {
    publicKey: required('VAPID_PUBLIC_KEY'),
    privateKey: required('VAPID_PRIVATE_KEY'),
    subject: process.env.VAPID_SUBJECT ?? 'mailto:contato@example.com',
  },
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variável de ambiente ${name} é obrigatória. Copie .env.example para .env.`,
    );
  }
  return value;
}
