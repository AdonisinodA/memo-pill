import { DateTime } from 'luxon';
import {
  HORIZON_DAYS,
  Regimen,
  horizonEnd,
  generateInstants,
} from './dose-schedule';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';

const sec = (iso: string, zone = 'utc') =>
  Math.floor(DateTime.fromISO(iso, { zone }).toSeconds());

const utc = (s: number) => DateTime.fromSeconds(s, { zone: 'utc' }).toISO();

const regimen = (over: Partial<Regimen> = {}): Regimen => ({
  times: ['08:00', '20:00'],
  startsOn: '2026-08-30',
  endsOn: null,
  timezone: SP,
  ...over,
});

const NOW = sec('2026-08-30T00:00:00Z');
const DIA = 86_400;

describe('gerarInstantes', () => {
  describe('conversão de fuso (ADR-001 §2.2 — persistência em UTC)', () => {
    it('converte o horário local para UTC usando o fuso do usuário', () => {
      const [primeiro] = generateInstants(regimen({ times: ['08:00'] }), {
        from: NOW,
        to: NOW + DIA,
      });
      // São Paulo é UTC-3 o ano todo desde 2019: 08:00 local = 11:00 UTC.
      expect(utc(primeiro)).toBe('2026-08-30T11:00:00.000Z');
    });

    it('produz instantes diferentes para o mesmo horário em fusos diferentes', () => {
      const timeWindow = { from: NOW, to: NOW + DIA };
      const [emSP] = generateInstants(
        regimen({ times: ['08:00'], timezone: SP }),
        timeWindow,
      );
      const [emNY] = generateInstants(
        regimen({ times: ['08:00'], timezone: NY }),
        timeWindow,
      );
      expect(utc(emSP)).toBe('2026-08-30T11:00:00.000Z');
      expect(utc(emNY)).toBe('2026-08-30T12:00:00.000Z'); // EDT = UTC-4
    });

    it('acompanha a virada de horário de verão dentro do horizonte', () => {
      // Nova York sai do EDT (UTC-4) para o EST (UTC-5) em 01/11/2026.
      const instants = generateInstants(
        regimen({
          times: ['08:00'],
          startsOn: '2026-10-30',
          timezone: NY,
        }),
        { from: sec('2026-10-30T00:00:00Z'), to: sec('2026-11-03T23:59:59Z') },
      );
      const hours = instants.map((s) =>
        DateTime.fromSeconds(s, { zone: 'utc' }).toFormat('MM-dd HH:mm'),
      );
      expect(hours).toEqual([
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
      const alvo = sec('2026-08-30T11:00:00Z');
      const comLimiteNoAlvo = generateInstants(
        regimen({ times: ['08:00'] }),
        { from: alvo, to: alvo + DIA },
      );
      expect(comLimiteNoAlvo).not.toContain(alvo);

      const comLimiteAntes = generateInstants(
        regimen({ times: ['08:00'] }),
        { from: alvo - 1, to: alvo + DIA },
      );
      expect(comLimiteAntes).toContain(alvo);
    });

    it('trata o limite superior como inclusivo', () => {
      const alvo = sec('2026-08-30T11:00:00Z');
      expect(
        generateInstants(regimen({ times: ['08:00'] }), {
          from: NOW,
          to: alvo,
        }),
      ).toContain(alvo);
    });

    it('não gera nada antes do início do tratamento', () => {
      const instants = generateInstants(
        regimen({ times: ['08:00'], startsOn: '2026-09-05' }),
        { from: NOW, to: NOW + 10 * DIA },
      );
      expect(utc(instants[0])).toBe('2026-09-05T11:00:00.000Z');
      // 05, 06, 07 e 08 às 11:00Z. A dose de 09 cairia às 11:00Z, além do
      // limite superior da janela (09-09T00:00Z).
      expect(instants).toHaveLength(4);
    });

    it('devolve lista vazia quando a janela é degenerada', () => {
      expect(
        generateInstants(regimen(), { from: NOW, to: NOW }),
      ).toHaveLength(0);
    });

    it('devolve lista vazia quando não há horários', () => {
      expect(
        generateInstants(regimen({ times: [] }), {
          from: NOW,
          to: NOW + DIA,
        }),
      ).toHaveLength(0);
    });
  });

  describe('posologia', () => {
    it('gera uma dose por horário por dia', () => {
      const instants = generateInstants(
        regimen({ times: ['08:00', '14:00', '20:00'] }),
        { from: NOW, to: NOW + 3 * DIA },
      );
      expect(instants).toHaveLength(9);
    });

    it('devolve os instantes em ordem crescente mesmo com horários fora de ordem', () => {
      const instants = generateInstants(
        regimen({ times: ['20:00', '08:00'] }),
        { from: NOW, to: NOW + 2 * DIA },
      );
      expect(instants).toEqual([...instants].sort((a, b) => a - b));
    });

    it('ignora horários com formato inválido em vez de lançar', () => {
      const instants = generateInstants(
        regimen({ times: ['08:00', '25:00', 'meio-dia', '08:70'] }),
        { from: NOW, to: NOW + DIA },
      );
      expect(instants).toHaveLength(1);
    });

    it('gera o tratamento inteiro quando ele cabe no horizonte', () => {
      // Antibiótico de 7 dias, 2x ao dia.
      const p = regimen({ startsOn: '2026-08-31', endsOn: '2026-09-06' });
      const instants = generateInstants(p, {
        from: NOW,
        to: horizonEnd(p, NOW),
      });
      expect(instants).toHaveLength(14);
    });
  });
});

describe('fimDoHorizonte', () => {
  it('usa o teto de 90 dias para tratamento de uso contínuo', () => {
    expect(horizonEnd(regimen({ endsOn: null }), NOW)).toBe(
      NOW + HORIZON_DAYS * DIA,
    );
  });

  it('usa o fim do tratamento quando ele vem antes do teto', () => {
    const end = horizonEnd(regimen({ endsOn: '2026-09-06' }), NOW);
    expect(utc(end)).toBe('2026-09-07T02:59:59.000Z'); // 23:59:59 em SP (UTC-3)
    expect(end).toBeLessThan(NOW + HORIZON_DAYS * DIA);
  });

  it('usa o teto quando o tratamento passa dos 90 dias', () => {
    expect(horizonEnd(regimen({ endsOn: '2027-12-31' }), NOW)).toBe(
      NOW + HORIZON_DAYS * DIA,
    );
  });

  it('limita uso contínuo a 90 dias de doses materializadas', () => {
    const p = regimen({ times: ['08:00', '20:00'], endsOn: null });
    const instants = generateInstants(p, {
      from: NOW,
      to: horizonEnd(p, NOW),
    });
    expect(instants).toHaveLength(180);
  });
});
