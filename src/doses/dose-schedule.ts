import { DateTime } from 'luxon';

/** Horizonte de pré-geração em dias (ADR-001 §2.2). */
export const HORIZONTE_DIAS = 90;

/** Teto defensivo do laço de datas: evita varredura ilimitada. */
const MAX_DIAS_ITERADOS = 400;

export interface Posologia {
  /** Horários locais "HH:mm", ex.: ["08:00", "20:00"]. */
  horarios: string[];
  /** Data local de início, "YYYY-MM-DD". */
  inicioEm: string;
  /** Data local de término, "YYYY-MM-DD". Nulo = uso contínuo. */
  fimEm: string | null;
  /** Fuso IANA do usuário, ex.: "America/Sao_Paulo". */
  timezone: string;
}

export interface Janela {
  /** Limite inferior EXCLUSIVO, unix seconds UTC. */
  desde: number;
  /** Limite superior INCLUSIVO, unix seconds UTC. */
  ate: number;
}

/**
 * Calcula o fim do horizonte de geração: o que vier primeiro entre o término do
 * tratamento e `agora + HORIZONTE_DIAS`.
 */
export function fimDoHorizonte(
  posologia: Posologia,
  agoraSeg: number,
  horizonteDias: number = HORIZONTE_DIAS,
): number {
  const tetoRolante = agoraSeg + horizonteDias * 86_400;
  if (!posologia.fimEm) return tetoRolante;

  const fimTratamento = DateTime.fromISO(posologia.fimEm, {
    zone: posologia.timezone,
  }).endOf('day');
  if (!fimTratamento.isValid) return tetoRolante;

  return Math.min(tetoRolante, Math.floor(fimTratamento.toSeconds()));
}

/**
 * Materializa os instantes de disparo de uma posologia dentro da janela dada.
 *
 * Os horários são interpretados no fuso do usuário e convertidos para UTC —
 * a persistência é sempre em UTC (ADR-001 §2.2). A mesma função serve à geração
 * inicial (no cadastro) e à extensão diária do horizonte: basta variar `desde`.
 *
 * @returns instantes em unix seconds UTC, ordenados de forma crescente.
 */
export function gerarInstantes(posologia: Posologia, janela: Janela): number[] {
  const { horarios, inicioEm, timezone } = posologia;
  if (horarios.length === 0 || janela.ate <= janela.desde) return [];

  const inicio = DateTime.fromISO(inicioEm, { zone: timezone });
  if (!inicio.isValid) return [];

  const primeiroDiaJanela = DateTime.fromSeconds(janela.desde, {
    zone: timezone,
  }).startOf('day');
  const ultimoDiaJanela = DateTime.fromSeconds(janela.ate, {
    zone: timezone,
  }).startOf('day');

  // Começa no que for mais tarde: o início do tratamento ou o início da janela.
  let dia: DateTime<boolean> = inicio.startOf('day');
  if (dia < primeiroDiaJanela) dia = primeiroDiaJanela;

  const instantes: number[] = [];
  for (let i = 0; dia <= ultimoDiaJanela && i < MAX_DIAS_ITERADOS; i++) {
    for (const horario of horarios) {
      const instante = comHorario(dia, horario);
      if (instante === null) continue;
      if (instante > janela.desde && instante <= janela.ate) {
        instantes.push(instante);
      }
    }
    dia = dia.plus({ days: 1 });
  }

  return instantes.sort((a, b) => a - b);
}

/** Aplica "HH:mm" a um dia local e devolve o instante em unix seconds UTC. */
function comHorario(dia: DateTime<boolean>, horario: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(horario);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const dt = dia.set({ hour, minute, second: 0, millisecond: 0 });
  return dt.isValid ? Math.floor(dt.toSeconds()) : null;
}
