import { DateTime } from 'luxon';
import {
  HORIZONTE_DIAS,
  Posologia,
  fimDoHorizonte,
  gerarInstantes,
} from './dose-schedule';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';

const seg = (iso: string, zone = 'utc') =>
  Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());

const utc = (s: number) => DateTime.fromSeconds(s, { zone: 'utc' }).toISO();

const posologia = (over: Partial<Posologia> = {}): Posologia => ({
  horarios: ['08:00', '20:00'],
  inicioEm: '2026-08-30',
  fimEm: null,
  timezone: SP,
  ...over,
});

const AGORA = seg('2026-08-30T00:00:00Z');
const DIA = 86_400;

describe('gerarInstantes', () => {
  describe('conversão de fuso (ADR-001 §2.2 — persistência em UTC)', () => {
    it('converte o horário local para UTC usando o fuso do usuário', () => {
      const [primeiro] = gerarInstantes(posologia({ horarios: ['08:00'] }), {
        desde: AGORA,
        ate: AGORA + DIA,
      });
      // São Paulo é UTC-3 o ano todo desde 2019: 08:00 local = 11:00 UTC.
      expect(utc(primeiro)).toBe('2026-08-30T11:00:00.000Z');
    });

    it('produz instantes diferentes para o mesmo horário em fusos diferentes', () => {
      const janela = { desde: AGORA, ate: AGORA + DIA };
      const [emSP] = gerarInstantes(
        posologia({ horarios: ['08:00'], timezone: SP }),
        janela,
      );
      const [emNY] = gerarInstantes(
        posologia({ horarios: ['08:00'], timezone: NY }),
        janela,
      );
      expect(utc(emSP)).toBe('2026-08-30T11:00:00.000Z');
      expect(utc(emNY)).toBe('2026-08-30T12:00:00.000Z'); // EDT = UTC-4
    });

    it('acompanha a virada de horário de verão dentro do horizonte', () => {
      // Nova York sai do EDT (UTC-4) para o EST (UTC-5) em 01/11/2026.
      const instantes = gerarInstantes(
        posologia({
          horarios: ['08:00'],
          inicioEm: '2026-10-30',
          timezone: NY,
        }),
        { desde: seg('2026-10-30T00:00:00Z'), ate: seg('2026-11-03T23:59:59Z') },
      );
      const horas = instantes.map((s) =>
        DateTime.fromSeconds(s, { zone: 'utc' }).toFormat('MM-dd HH:mm'),
      );
      expect(horas).toEqual([
        '10-30 12:00', // EDT
        '10-31 12:00', // EDT
        '11-01 13:00', // EST — o offset mudou, o horário local seguiu 08:00
        '11-02 13:00',
        '11-03 13:00',
      ]);
    });
  });

  describe('limites da janela', () => {
    it('trata o limite inferior como exclusivo, para a extensão não duplicar', () => {
      const alvo = seg('2026-08-30T11:00:00Z');
      const comLimiteNoAlvo = gerarInstantes(
        posologia({ horarios: ['08:00'] }),
        { desde: alvo, ate: alvo + DIA },
      );
      expect(comLimiteNoAlvo).not.toContain(alvo);

      const comLimiteAntes = gerarInstantes(
        posologia({ horarios: ['08:00'] }),
        { desde: alvo - 1, ate: alvo + DIA },
      );
      expect(comLimiteAntes).toContain(alvo);
    });

    it('trata o limite superior como inclusivo', () => {
      const alvo = seg('2026-08-30T11:00:00Z');
      expect(
        gerarInstantes(posologia({ horarios: ['08:00'] }), {
          desde: AGORA,
          ate: alvo,
        }),
      ).toContain(alvo);
    });

    it('não gera nada antes do início do tratamento', () => {
      const instantes = gerarInstantes(
        posologia({ horarios: ['08:00'], inicioEm: '2026-09-05' }),
        { desde: AGORA, ate: AGORA + 10 * DIA },
      );
      expect(utc(instantes[0])).toBe('2026-09-05T11:00:00.000Z');
      // 05, 06, 07 e 08 às 11:00Z. A dose de 09 cairia às 11:00Z, além do
      // limite superior da janela (09-09T00:00Z).
      expect(instantes).toHaveLength(4);
    });

    it('devolve lista vazia quando a janela é degenerada', () => {
      expect(
        gerarInstantes(posologia(), { desde: AGORA, ate: AGORA }),
      ).toHaveLength(0);
    });

    it('devolve lista vazia quando não há horários', () => {
      expect(
        gerarInstantes(posologia({ horarios: [] }), {
          desde: AGORA,
          ate: AGORA + DIA,
        }),
      ).toHaveLength(0);
    });
  });

  describe('posologia', () => {
    it('gera uma dose por horário por dia', () => {
      const instantes = gerarInstantes(
        posologia({ horarios: ['08:00', '14:00', '20:00'] }),
        { desde: AGORA, ate: AGORA + 3 * DIA },
      );
      expect(instantes).toHaveLength(9);
    });

    it('devolve os instantes em ordem crescente mesmo com horários fora de ordem', () => {
      const instantes = gerarInstantes(
        posologia({ horarios: ['20:00', '08:00'] }),
        { desde: AGORA, ate: AGORA + 2 * DIA },
      );
      expect(instantes).toEqual([...instantes].sort((a, b) => a - b));
    });

    it('ignora horários com formato inválido em vez de lançar', () => {
      const instantes = gerarInstantes(
        posologia({ horarios: ['08:00', '25:00', 'meio-dia', '08:70'] }),
        { desde: AGORA, ate: AGORA + DIA },
      );
      expect(instantes).toHaveLength(1);
    });

    it('gera o tratamento inteiro quando ele cabe no horizonte', () => {
      // Antibiótico de 7 dias, 2x ao dia.
      const p = posologia({ inicioEm: '2026-08-31', fimEm: '2026-09-06' });
      const instantes = gerarInstantes(p, {
        desde: AGORA,
        ate: fimDoHorizonte(p, AGORA),
      });
      expect(instantes).toHaveLength(14);
    });
  });
});

describe('fimDoHorizonte', () => {
  it('usa o teto de 90 dias para tratamento de uso contínuo', () => {
    expect(fimDoHorizonte(posologia({ fimEm: null }), AGORA)).toBe(
      AGORA + HORIZONTE_DIAS * DIA,
    );
  });

  it('usa o fim do tratamento quando ele vem antes do teto', () => {
    const fim = fimDoHorizonte(posologia({ fimEm: '2026-09-06' }), AGORA);
    expect(utc(fim)).toBe('2026-09-07T02:59:59.000Z'); // 23:59:59 em SP (UTC-3)
    expect(fim).toBeLessThan(AGORA + HORIZONTE_DIAS * DIA);
  });

  it('usa o teto quando o tratamento passa dos 90 dias', () => {
    expect(fimDoHorizonte(posologia({ fimEm: '2027-12-31' }), AGORA)).toBe(
      AGORA + HORIZONTE_DIAS * DIA,
    );
  });

  it('limita uso contínuo a 90 dias de doses materializadas', () => {
    const p = posologia({ horarios: ['08:00', '20:00'], fimEm: null });
    const instantes = gerarInstantes(p, {
      desde: AGORA,
      ate: fimDoHorizonte(p, AGORA),
    });
    expect(instantes).toHaveLength(180);
  });
});
