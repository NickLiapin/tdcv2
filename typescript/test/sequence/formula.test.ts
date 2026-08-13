/**
 * `<gen type="formula" expr="Weight / (Height * Height)">` — arithmetic over the
 * columns beside it.
 *
 * The tests are written so a wrong implementation cannot pass quietly. Three
 * properties are worth more than the arithmetic itself:
 *
 *  - **Both engines answer the same.** A formula reads a sibling column, and the
 *    two engines get that sibling from different places — an array in memory, a
 *    `resolve(i)` when streaming. Every case here runs on both.
 *  - **Row 5 is row 5 on either side of the parallel threshold.** The streaming
 *    engine builds a row through the same builder as a whole column, and a build
 *    that forgot which row it was on answered "row 1" everywhere. That is a
 *    silent wrong number, so the case below crosses the threshold deliberately.
 *  - **An empty source gives an empty answer.** A cell a `parent=` filter
 *    switched off is not a zero, and `0 / 0` is not the honest reading of it.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/** Every line of a run, on the engine asked for. */
function run(config: string, engine: 1 | 2): string[] {
  return new TDC({ configString: config, engine })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

/** The same run on both engines, asserted equal, returned once. */
function bothEngines(config: string): string[] {
  const memory = run(config, 1);
  const streaming = run(config, 2);
  expect(streaming).toEqual(memory);
  return memory;
}

function config(body: string, count = 4, extra = ''): string {
  return (
    `<tdc><env count="${String(count)}" seed="f1" local="en">${body}</env>` +
    `<block><line><data>${extra || '${{V}}'}</data></line></block></tdc>`
  );
}

describe('<gen type="formula">', () => {
  it('computes over the columns beside it, on both engines', () => {
    const lines = bothEngines(
      config(
        '<sequence name="W"><gen type="number" value="60..90"/></sequence>' +
          '<sequence name="H"><gen type="number" value="150..190"/></sequence>' +
          '<sequence name="V"><gen type="formula" expr="W * 10000 / (H * H)" decimals="1"/></sequence>',
      ),
    );
    expect(lines).toHaveLength(4);
    for (const v of lines) {
      expect(v).toMatch(/^\d+\.\d$/);
      expect(Number(v)).toBeGreaterThan(10);
      expect(Number(v)).toBeLessThan(45);
    }
  });

  it('reads the row it is on, not row 1, past the parallel threshold', () => {
    // 5,000 rows is over the size at which the streaming engine hands ranges to
    // workers, which is exactly where a builder that ignored its row offset used
    // to answer with row 1's value for every row in the range.
    const lines = bothEngines(
      config(
        '<sequence name="N"><gen type="number" value="1..1000000"/></sequence>' +
          '<sequence name="V"><gen type="formula" expr="N"/></sequence>',
        5000,
        '${{N}}|${{V}}',
      ),
    );
    expect(lines).toHaveLength(5000);
    for (const line of lines) {
      const [source, computed] = line.split('|');
      expect(computed).toBe(source);
    }
    // And the source really did vary, so the check above is not vacuous.
    expect(new Set(lines.map((l) => l.split('|')[0])).size).toBeGreaterThan(4000);
  });

  it('leaves the cell empty when a source cell is empty', () => {
    const lines = bothEngines(
      config(
        '<sequence name="G"><gen type="text" value="M,F"/></sequence>' +
          '<sequence name="S" parent="G.M"><gen type="number" value="7..7"/></sequence>' +
          '<sequence name="V"><gen type="formula" expr="S * 2"/></sequence>',
        6,
        '${{G}}|${{V}}',
      ),
    );
    for (const line of lines) {
      const [sex, value] = line.split('|');
      expect(value).toBe(sex === 'M' ? '14' : '');
    }
    expect(lines.some((l) => l.endsWith('|'))).toBe(true);
    expect(lines.some((l) => l.endsWith('|14'))).toBe(true);
  });

  it('adds decimals instead of joining them as text', () => {
    // `+` used to concatenate whenever either side was fractional: 0.5 + 0.25
    // came out "0.50.25". Nothing warned; the column simply held nonsense.
    const lines = bothEngines(
      config('<sequence name="V"><gen type="formula" expr="0.5 + 0.25"/></sequence>', 1),
    );
    expect(lines[0]).toBe('0.75');
  });

  it('counts the row through _count', () => {
    const lines = bothEngines(
      config('<sequence name="V"><gen type="formula" expr="_count * 3"/></sequence>', 4),
    );
    expect(lines).toEqual(['3', '6', '9', '12']);
  });

  it('is refused under if=, rather than crashing the run', () => {
    // A derived column is registered once for the whole run, before any branch
    // has been chosen — so a formula under `if=` used to reach the engine and
    // die there with a stack trace. It is refused at check time now, and a
    // condition belongs on the columns it READS instead.
    expect(() =>
      run(
        config(
          '<sequence name="T"><gen type="text" value="hi,lo"/></sequence>' +
            '<sequence name="N"><gen type="number" value="4..4"/></sequence>' +
            '<sequence name="V"><gen if="T == hi" type="formula" expr="N * 100"/></sequence>',
          6,
        ),
        2,
      ),
    ).toThrow(/whole run, so it cannot carry if=/);
  });

  it('is refused when it names a column declared below it', () => {
    // A forward reference is worse than a typo: the streaming registry answers
    // it and the in-memory one does not, so one config would mean two datasets.
    expect(() =>
      run(
        config(
          '<sequence name="V"><gen type="formula" expr="Later * 2"/></sequence>' +
            '<sequence name="Later"><gen type="number" value="1..9"/></sequence>',
        ),
        2,
      ),
    ).toThrow(/Later/);
  });
});
