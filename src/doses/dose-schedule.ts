import { DateTime } from 'luxon';

/** Horizonte de pré-geração em dias (ADR-001 §2.2). */
export const HORIZON_DAYS = 90;

/** Teto defensivo do laço de datas: evita varredura ilimitada. */
const MAX_ITERATED_DAYS = 400;

export interface Regimen {
  /** Horários locais "HH:mm", ex.: ["08:00", "20:00"]. */
  times: string[];
  /** Data local de início, "YYYY-MM-DD". */
  startsOn: string;
  /** Data local de término, "YYYY-MM-DD". Nulo = uso contínuo. */
  endsOn: string | null;
  /** Fuso IANA do usuário, ex.: "America/Sao_Paulo". */
  timezone: string;
}

export interface TimeWindow {
  /** Limite inferior EXCLUSIVO, unix seconds UTC. */
  from: number;
  /** Limite superior INCLUSIVO, unix seconds UTC. */
  to: number;
}

/**
 * Calcula o fim do horizonte de geração: o que vier primeiro entre o término do
 * tratamento e `agora + HORIZONTE_DIAS`.
 */
export function horizonEnd(
  regimen: Regimen,
  nowSec: number,
  horizonDays: number = HORIZON_DAYS,
): number {
  const rollingCap = nowSec + horizonDays * 86_400;
  if (!regimen.endsOn) return rollingCap;

  const treatmentEnd = DateTime.fromISO(regimen.endsOn, {
    zone: regimen.timezone,
  }).endOf('day');
  if (!treatmentEnd.isValid) return rollingCap;

  return Math.min(rollingCap, Math.floor(treatmentEnd.toSeconds()));
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
export function generateInstants(regimen: Regimen, timeWindow: TimeWindow): number[] {
  const { times, startsOn, timezone } = regimen;
  if (times.length === 0 || timeWindow.to <= timeWindow.from) return [];

  const start = DateTime.fromISO(startsOn, { zone: timezone });
  if (!start.isValid) return [];

  const firstDay = DateTime.fromSeconds(timeWindow.from, {
    zone: timezone,
  }).startOf('day');
  const lastDay = DateTime.fromSeconds(timeWindow.to, {
    zone: timezone,
  }).startOf('day');

  // Começa no que for mais tarde: o início do tratamento ou o início da janela.
  let day: DateTime<boolean> = start.startOf('day');
  if (day < firstDay) day = firstDay;

  const instants: number[] = [];
  for (let i = 0; day <= lastDay && i < MAX_ITERATED_DAYS; i++) {
    for (const time of times) {
      const instant = atTime(day, time);
      if (instant === null) continue;
      if (instant > timeWindow.from && instant <= timeWindow.to) {
        instants.push(instant);
      }
    }
    day = day.plus({ days: 1 });
  }

  return instants.sort((a, b) => a - b);
}

/** Aplica "HH:mm" a um dia local e devolve o instante em unix seconds UTC. */
function atTime(day: DateTime<boolean>, time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const dt = day.set({ hour, minute, second: 0, millisecond: 0 });
  return dt.isValid ? Math.floor(dt.toSeconds()) : null;
}
