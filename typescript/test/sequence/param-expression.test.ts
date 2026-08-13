/**
 * A distribution's parameter written as an EXPRESSION: `lambda="Traffic * 0.5"`.
 *
 * The point of the feature is that one rule replaces a family of them — an
 * intensity that follows another column, a spread that drifts over the run, a
 * shape driven by a hand-drawn `pattern` column — with no new attribute
 * anywhere. A bare number stays the ordinary case and takes the same path it
 * always did.
 *
 * What must not break, and each has a test below:
 *
 *  - **The engines agree.** The parameter reads a sibling column, which the two
 *    engines fetch from different places.
 *  - **The row count of DRAWS does not change.** How many uniforms a row spends
 *    depends on WHICH distribution, never on its parameters — that is what keeps
 *    a row computable without its predecessors, and it is why a per-row
 *    parameter is allowed here while a per-row `repeat=` is not. A row that
 *    cannot draw at all (its parameter read an empty cell) still spends the
 *    budget, so blanking one cell does not slide the rest of the column.
 *  - **A name that is not a column is refused, at check time.** Including a name
 *    declared BELOW: the streaming registry would answer it and the in-memory
 *    one would not, which is one config meaning two datasets.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function config(body: string, count = 6, line = '${{N}}'): string {
  return (
    `<tdc><env count="${String(count)}" seed="p1" local="en">${body}</env>` +
    `<block><line><data>${line}</data></line></block></tdc>`
  );
}

function run(cfg: string, engine: 1 | 2): string[] {
  return new TDC({ configString: cfg, engine })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

function bothEngines(cfg: string): string[] {
  const memory = run(cfg, 1);
  expect(run(cfg, 2)).toEqual(memory);
  return memory;
}

/** Every diagnostic code the validator reports for this config. */
function codes(cfg: string): (string | undefined)[] {
  return validate(parse(cfg).tree).diagnostics.map((d) => d.code);
}

describe('a distribution parameter as an expression', () => {
  it('follows another column, and both engines agree', () => {
    const lines = bothEngines(
      config(
        '<sequence name="T"><gen type="number" value="10..10"/></sequence>' +
          '<sequence name="N"><gen type="number" distribution="poisson" lambda="T * 0.5"/></sequence>',
        200,
      ),
    );
    const values = lines.map(Number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // A Poisson with lambda 5 over 200 rows: the mean lands near 5, and a
    // parameter that had silently become something else (0, or the text "T")
    // would not.
    expect(mean).toBeGreaterThan(4);
    expect(mean).toBeLessThan(6);
  });

  it('names a column on its own, without arithmetic', () => {
    const lines = bothEngines(
      config(
        '<sequence name="M"><gen type="number" value="100..100"/></sequence>' +
          '<sequence name="N"><gen type="number" distribution="normal" mean="M" sd="1" decimals="1"/></sequence>',
        50,
      ),
    );
    for (const v of lines) {
      expect(Number(v)).toBeGreaterThan(94);
      expect(Number(v)).toBeLessThan(106);
    }
  });

  it('drifts with _count — a spread that grows over the run', () => {
    const lines = bothEngines(
      config(
        '<sequence name="N"><gen type="number" distribution="normal" mean="0" ' +
          'sd="0.01 + 0.05 * _count" decimals="3"/></sequence>',
        400,
      ),
    );
    const spread = (from: number, to: number): number => {
      const part = lines.slice(from, to).map(Number);
      const mean = part.reduce((a, b) => a + b, 0) / part.length;
      return Math.sqrt(part.reduce((a, b) => a + (b - mean) ** 2, 0) / part.length);
    };
    // The last hundred rows are drawn with an sd roughly seven times the first
    // hundred's, so the measured spread has to grow with it by a wide margin.
    expect(spread(300, 400)).toBeGreaterThan(spread(0, 100) * 3);
  });

  it('leaves the cell empty when the parameter reads an empty cell, on both engines', () => {
    const lines = bothEngines(
      config(
        '<sequence name="G"><gen type="text" value="M,F"/></sequence>' +
          '<sequence name="H" parent="G.M"><gen type="number" value="5..5"/></sequence>' +
          '<sequence name="N"><gen type="number" distribution="poisson" lambda="H"/></sequence>',
        8,
        '${{G}}|${{N}}',
      ),
    );
    for (const line of lines) {
      const [sex, value] = line.split('|');
      if (sex === 'F') expect(value).toBe('');
      else expect(value).toMatch(/^\d+$/);
    }
    expect(lines.some((l) => l.endsWith('|'))).toBe(true);
  });

  it('spends the draw budget on a blank row, so the rows after it do not move', () => {
    // The proof: the same config with and without the `parent=` filter. Without
    // it every row draws; with it two rows come out blank. The rows that DO draw
    // must land on the same values either way — otherwise emptying one cell
    // would quietly rewrite the rest of the column.
    const body = (filter: string): string =>
      '<sequence name="G"><gen type="text" value="M,F"/></sequence>' +
      `<sequence name="H" ${filter}><gen type="number" value="5..5"/></sequence>` +
      '<sequence name="N"><gen type="number" distribution="normal" mean="H" sd="1" decimals="2"/></sequence>';
    const line = '${{G}}|${{N}}';
    const filtered = bothEngines(config(body('parent="G.M"'), 12, line));
    const everyRow = bothEngines(config(body(''), 12, line));

    let blanks = 0;
    for (let i = 0; i < filtered.length; i++) {
      const [sex, value] = (filtered[i] ?? '').split('|');
      if (sex === 'M') expect(filtered[i]).toBe(everyRow[i]);
      else {
        expect(value).toBe('');
        blanks++;
      }
    }
    expect(blanks).toBeGreaterThan(0);
  });

  it('refuses a name that is no column — the typo, at check time', () => {
    const cfg = config(
      '<sequence name="Traffic"><gen type="number" value="1..9"/></sequence>' +
        '<sequence name="N"><gen type="number" distribution="poisson" lambda="Trafic * 0.5"/></sequence>',
    );
    expect(codes(cfg)).toContain('TDC240');
    expect(() => run(cfg, 2)).toThrow(/Trafic/);
  });

  it('refuses a column declared BELOW it — where the engines used to disagree', () => {
    const cfg = config(
      '<sequence name="N"><gen type="number" distribution="poisson" lambda="Later"/></sequence>' +
        '<sequence name="Later"><gen type="number" value="1..9"/></sequence>',
    );
    expect(codes(cfg)).toContain('TDC240');
  });

  it('still refuses a parameter that resolves to something impossible', () => {
    // The check cannot know the value, so the run has to say it: a negative
    // standard deviation is refused where it appears, not silently clamped.
    expect(() =>
      run(
        config(
          '<sequence name="S"><gen type="number" value="-3..-3"/></sequence>' +
            '<sequence name="N"><gen type="number" distribution="normal" mean="0" sd="S"/></sequence>',
        ),
        2,
      ),
    ).toThrow(/sd/);
  });

  it('leaves a bare number on the path it always took', () => {
    const lines = bothEngines(
      config(
        '<sequence name="N"><gen type="number" distribution="poisson" lambda="4"/></sequence>',
        20,
      ),
    );
    expect(lines).toHaveLength(20);
    for (const v of lines) expect(v).toMatch(/^\d+$/);
  });
});
