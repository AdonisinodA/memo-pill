import type { Database } from 'better-sqlite3';

/**
 * PRAGMAs aplicados a toda conexão SQLite (ADR-001 §2.2).
 *
 * - WAL: permite leituras simultâneas sem bloqueio durante uma escrita.
 *   Não elimina o limite de um escritor por vez.
 * - foreign_keys: integridade referencial (desligada por padrão no SQLite).
 * - busy_timeout: aguarda o lock em vez de devolver SQLITE_BUSY na cara do
 *   usuário — é a mitigação que acompanha o WAL, não uma alternativa a ele.
 */
export function aplicarPragmas(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}
