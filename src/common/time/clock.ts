/**
 * Fonte de tempo injetável. Existe para que o agendador e a geração de doses
 * sejam testáveis sem depender do relógio do sistema.
 * Toda a aplicação trabalha em unix seconds UTC (ADR-001 §2.2).
 */
export abstract class Clock {
  abstract nowSeconds(): number;
}

export class SystemClock extends Clock {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }
}

/** Relógio determinístico para testes. */
export class FixedClock extends Clock {
  constructor(private seconds: number) {
    super();
  }
  nowSeconds(): number {
    return this.seconds;
  }
  advance(seconds: number): void {
    this.seconds += seconds;
  }
  set(seconds: number): void {
    this.seconds = seconds;
  }
}
