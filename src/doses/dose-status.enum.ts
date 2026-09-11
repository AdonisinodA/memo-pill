/**
 * Estados de uma dose (ADR-001 §2.2).
 *
 * `status` registra a ADESÃO do usuário. O controle de ENTREGA da notificação
 * vive em `dose_logs.notified_at` — misturar os dois faria o agendador
 * reselecionar a mesma dose a cada minuto até a confirmação.
 */
export enum DoseStatus {
  /** Gerada, aguardando o horário e a resposta do usuário. */
  PENDING = 'PENDING',
  /** Usuário confirmou a ingestão. */
  TAKEN = 'TAKEN',
  /** Usuário declarou explicitamente que não tomou. */
  SKIPPED = 'SKIPPED',
  /** Horário passou sem resposta e a janela de tolerância expirou. */
  MISSED = 'MISSED',
  /** Medicamento excluído ou posologia alterada antes do horário. */
  CANCELED = 'CANCELED',
}

/** Status que não admitem mais transição. */
export const TERMINAL_STATUSES: readonly DoseStatus[] = [
  DoseStatus.TAKEN,
  DoseStatus.SKIPPED,
  DoseStatus.MISSED,
  DoseStatus.CANCELED,
];

/**
 * Rótulo de cada status em português. A mensagem de conflito vai parar no toast
 * da tela — sem isto o usuário lê o identificador do enum, "TAKEN".
 */
export const STATUS_LABELS: Readonly<Record<DoseStatus, string>> = {
  [DoseStatus.PENDING]: 'pendente',
  [DoseStatus.TAKEN]: 'tomada',
  [DoseStatus.SKIPPED]: 'pulada',
  [DoseStatus.MISSED]: 'não registrada',
  [DoseStatus.CANCELED]: 'cancelada',
};
