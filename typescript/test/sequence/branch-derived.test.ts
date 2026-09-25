/**
 * A formula or a date offset inside a branch — a `<case>` at any depth, or an
 * `if=` branch.
 *
 * Measured before this worked, on all five implementations: a date offset in a
 * `<case>` dropped `of=` and `plus=` without a word and drew an unrelated date
 * (`D=2020-03-05 C=1975-09-23`), and a formula passed `check` and stopped the run
 * with `gen type "formula" not yet supported` — except in one port, and there on
 * one engine only. The tests below hold three things:
 *
 *  - **The value is right.** Each is checked against its own row, not against a
 *    snapshot: an offset of one day is the source plus one day.
 *  - **The engines agree.** A formula streams, so engines 1, 2 and 3 must give the
 *    same bytes. A date offset is the in-memory engine's, as it is at the top
 *    level: engine 2 refuses it by name, engine 3 falls back, and auto-routing
 *    lands on engine 1.
 *  - **Only the rows a branch keeps are computed.** Engine 1 builds some branches
 *    over the whole run and picks from them. A formula evaluated on a row it was
 *    never going to keep can refuse a division by zero nobody asked for.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

function run(config: string, engine?: 1 | 2 | 3): string[] {
  return new TDC({ configString: config, ...(engine ? { engine } : {}) })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Engines 1, 2 and 3 on one config, asserted equal, returned once. */
function everyEngine(config: string): string[] {
  const memory = run(config, 1);
  expect(run(config, 2)).toEqual(memory);
  expect(run(config, 3)).toEqual(memory);
  return memory;
}

function tdc(count: number, env: string, line: string): string {
  return (
    `<tdc><env count="${String(count)}" seed="br" local="en">${env}</env>` +
    `<block><line><data>${line}</data></line></block></tdc>`
  );
}

const X = '<sequence name="X"><gen type="number" value="0..3"/></sequence>';
const Y = '<sequence name="Y"><gen type="number" value="10..20"/></sequence>';
const D = (format: string): string =>
  `<sequence name="D"><gen type="date" value="2020-01-01..2020-12-31" format="${format}"/></sequence>`;

/** `YYYY-MM-DD` plus `days`, by the calendar. */
function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('a formula in a branch', () => {
  it('in a <mix> case, computed from its own row on every engine', () => {
    const lines = everyEngine(
      tdc(
        20,
        `${X}${Y}<mix name="C" percent="40,60"><case><data>-</data></case>` +
          '<case><gen type="formula" expr="Y * 2 + X"/></case></mix>',
        '${{X}} ${{Y}} ${{C}}',
      ),
    );
    let computed = 0;
    for (const line of lines) {
      const [x = '', y = '', c = ''] = line.split(' ');
      if (c === '-') continue;
      computed += 1;
      expect(c).toBe(String(Number(y) * 2 + Number(x)));
    }
    expect(computed).toBe(12); // 60% of 20, exactly — the mix layout is untouched
  });

  it('_count is the row it lands on, not its place in the branch', () => {
    const lines = everyEngine(
      tdc(
        10,
        `${X}<mix name="C"><case><data>-</data></case><case><gen type="formula" expr="_count"/></case></mix>`,
        '${{_count}} ${{C}}',
      ),
    );
    for (const line of lines) {
      const [row, c] = line.split(' ');
      if (c !== '-') expect(c).toBe(row);
    }
  });

  it('in a <default> it computes only the rows the default holds', () => {
    // `<default>` is built over the whole run and picked from. On the X = 0 rows
    // `Y / X` is a refusal, and those rows belong to the other case.
    const lines = everyEngine(
      tdc(
        16,
        `${X}${Y}<switch name="C" on="X"><case is="0"><data>none</data></case>` +
          '<default><gen type="formula" expr="Y / X" decimals="2"/></default></switch>',
        '${{X}} ${{Y}} ${{C}}',
      ),
    );
    expect(lines.some((l) => l.startsWith('0 '))).toBe(true);
    for (const line of lines) {
      const [x = '', y = '', c = ''] = line.split(' ');
      expect(c).toBe(x === '0' ? 'none' : (Number(y) / Number(x)).toFixed(2));
    }
  });

  it('in a multi-key case, the same', () => {
    const lines = everyEngine(
      tdc(
        16,
        `${X}${Y}<switch name="C" on="X"><case is="0|1"><data>low</data></case>` +
          '<case is="2|3"><gen type="formula" expr="Y / (X - 1)" decimals="1"/></case></switch>',
        '${{X}} ${{Y}} ${{C}}',
      ),
    );
    for (const line of lines) {
      const [x = '', y = '', c = ''] = line.split(' ');
      expect(c).toBe(Number(x) < 2 ? 'low' : (Number(y) / (Number(x) - 1)).toFixed(1));
    }
  });

  it('in a <switch> nested inside a <case>, the same', () => {
    const lines = everyEngine(
      tdc(
        20,
        `${X}<mix name="C" percent="30,70"><case><data>none</data></case>` +
          '<case><data>[</data><switch on="X"><case is="0"><data>zero</data></case>' +
          '<default><gen type="formula" expr="12 / X"/></default></switch><data>]</data></case></mix>',
        '${{X}} ${{C}}',
      ),
    );
    for (const line of lines) {
      const [x = '', c = ''] = line.split(' ');
      if (c === 'none') continue;
      expect(c).toBe(x === '0' ? '[zero]' : `[${String(12 / Number(x))}]`);
    }
  });

  it('still refuses a division by zero on a row the branch does keep', () => {
    expect(() =>
      run(
        tdc(
          16,
          `${X}<mix name="C"><case><gen type="formula" expr="1 / X"/></case></mix>`,
          '${{C}}',
        ),
        1,
      ),
    ).toThrow(/division by zero/);
  });

  it('an empty column it reads leaves its part empty', () => {
    const lines = everyEngine(
      tdc(
        12,
        '<sequence name="N"><gen type="number" value="1..9" missing="0.5"/></sequence>' +
          '<mix name="C"><case><data>n=</data><gen type="formula" expr="N + 1"/></case></mix>',
        '${{N}}|${{C}}',
      ),
    );
    for (const line of lines) {
      const [n = '', c = ''] = line.split('|');
      expect(c).toBe(n === '' ? 'n=' : `n=${String(Number(n) + 1)}`);
    }
  });
});

describe('a date offset in a branch', () => {
  it('measures from the value the source kept, whatever format= spelled it as', () => {
    // The source is written `DD.MM.YYYY`, which no locale-free parser should
    // guess at — the offset works from the instant the column kept beside it.
    const lines = run(
      tdc(
        16,
        `${D('DD.MM.YYYY')}${X}<switch name="C" on="X"><case is="0"><data>-</data></case>` +
          '<default><gen type="date" of="D" plus="1d" format="YYYY-MM-DD"/></default></switch>',
        '${{D}} ${{X}} ${{C}}',
      ),
    );
    let measured = 0;
    for (const line of lines) {
      const [d = '', x = '', c = ''] = line.split(' ');
      if (x === '0') {
        expect(c).toBe('-');
        continue;
      }
      measured += 1;
      const [day, month, year] = d.split('.');
      expect(c).toBe(plusDays(`${year ?? ''}-${month ?? ''}-${day ?? ''}`, 1));
    }
    expect(measured).toBeGreaterThan(0);
  });

  it('a ranged plus= lands inside its range, identically on engines 1 and 3', () => {
    const config = tdc(
      30,
      `${D('YYYY-MM-DD')}<mix name="C" percent="50"><case><data>-</data></case>` +
        '<case><gen type="date" of="D" plus="3..10d" format="YYYY-MM-DD"/></case></mix>',
      '${{D}} ${{C}}',
    );
    const lines = run(config, 1);
    expect(run(config, 3)).toEqual(lines);
    const steps = new Set<number>();
    for (const line of lines) {
      const [d = '', c = ''] = line.split(' ');
      if (c === '-') continue;
      const days = (Date.parse(c) - Date.parse(d)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(3);
      expect(days).toBeLessThanOrEqual(10);
      steps.add(days);
    }
    expect(steps.size).toBeGreaterThan(1); // drawn per row, not one step for all
  });

  it('a row’s drawn step is its own, whichever other rows the branch holds', () => {
    // The step comes off the row's own stream, so moving the mix's split changes
    // WHICH rows are measured and nothing about the ones that stay. A step taken
    // from the run's shared generator in branch order would shift every row after
    // the first one that joined or left.
    const stepsAt = (percent: string): Map<string, number> => {
      const lines = run(
        tdc(
          40,
          `${D('YYYY-MM-DD')}<mix name="C" percent="${percent}"><case><data>-</data></case>` +
            '<case><gen type="date" of="D" plus="1..60d" format="YYYY-MM-DD"/></case></mix>',
          '${{_count}} ${{D}} ${{C}}',
        ),
        1,
      );
      const steps = new Map<string, number>();
      for (const line of lines) {
        const [row = '', d = '', c = ''] = line.split(' ');
        if (c !== '-') steps.set(row, (Date.parse(c) - Date.parse(d)) / 86_400_000);
      }
      return steps;
    };
    const narrow = stepsAt('70,30');
    const wide = stepsAt('30,70');
    let shared = 0;
    for (const [row, step] of narrow) {
      if (!wide.has(row)) continue;
      shared += 1;
      expect(wide.get(row), `row ${row}`).toBe(step);
    }
    expect(shared).toBeGreaterThan(3);
  });

  it('is the in-memory engine’s: engine 2 refuses it by name, auto-routing runs it', () => {
    const config = tdc(
      6,
      `${D('YYYY-MM-DD')}<mix name="C"><case><gen type="date" of="D" plus="1d" format="YYYY-MM-DD"/></case></mix>`,
      '${{D}} ${{C}}',
    );
    expect(() => run(config, 2)).toThrow(/a date measured from another column \("C"\)/);
    const lines = run(config);
    expect(lines).toEqual(run(config, 1));
    for (const line of lines) {
      const [d = '', c = ''] = line.split(' ');
      expect(c).toBe(plusDays(d, 1));
    }
  });

  it('as the fallback of an if= sequence, beside another branch', () => {
    const lines = run(
      tdc(
        16,
        `${D('YYYY-MM-DD')}${X}<sequence name="C"><gen if="X == 0" type="text" value="-"/>` +
          '<gen type="date" of="D" plus="-1w" format="YYYY-MM-DD"/></sequence>',
        '${{D}} ${{X}} ${{C}}',
      ),
    );
    for (const line of lines) {
      const [d = '', x = '', c = ''] = line.split(' ');
      expect(c).toBe(x === '0' ? '-' : plusDays(d, -7));
    }
  });

  it('a source row with no date measures nothing', () => {
    const lines = run(
      tdc(
        12,
        '<sequence name="D"><gen type="date" value="2020-01-01..2020-12-31" format="YYYY-MM-DD" missing="0.5"/></sequence>' +
          '<mix name="C"><case><data>d=</data><gen type="date" of="D" plus="-2d" format="YYYY-MM-DD"/></case></mix>',
        '${{D}}|${{C}}',
      ),
    );
    expect(lines.some((l) => l.startsWith('|'))).toBe(true);
    for (const line of lines) {
      const [d = '', c = ''] = line.split('|');
      expect(c).toBe(d === '' ? 'd=' : `d=${plusDays(d, -2)}`);
    }
  });
});
