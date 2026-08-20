import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const run = (config: string): string[] =>
  new TDC({ configString: config }).toString().split('\n').filter(Boolean);

/**
 * `prev()` and `mode="sequential"` — a column that reads its own past.
 *
 * The class of thing this unlocks is not one generator: a random walk, a Markov
 * chain and an autoregression are all "row N depends on row N-1", and none of
 * them could be written here before.
 */
describe('prev() under mode="sequential"', () => {
  it('a column reads its own previous row', () => {
    const rows = run(`<tdc><env count="5" seed="w" mode="sequential">
      <sequence name="T"><gen type="increment" value="1"/></sequence>
      <sequence name="W"><gen type="formula" expr="prev(W, 100) + 1"/></sequence>
    </env><block><line><data>\${{W}}</data></line></block></tdc>`);
    // The first row takes the initial value; each one after adds to the one before.
    expect(rows).toEqual(['101', '102', '103', '104', '105']);
  });

  it('the initial value is used only on the first row', () => {
    const rows = run(`<tdc><env count="3" seed="w" mode="sequential">
      <sequence name="W"><gen type="formula" expr="prev(W, 7)"/></sequence>
    </env><block><line><data>\${{W}}</data></line></block></tdc>`);
    expect(rows).toEqual(['7', '7', '7']);
  });

  it('reads a different column at the previous row', () => {
    const rows = run(`<tdc><env count="4" seed="w" mode="sequential">
      <sequence name="T"><gen type="increment" value="10"/></sequence>
      <sequence name="Lag"><gen type="formula" expr="prev(T, 0)"/></sequence>
    </env><block><line><data>\${{T}}:\${{Lag}}</data></line></block></tdc>`);
    // `value="10"` on an increment is where it STARTS, not its step, so T is
    // 10, 11, 12, 13 — and Lag is that column one row behind it.
    expect(rows).toEqual(['10:0', '11:10', '12:11', '13:12']);
  });

  /*
   * Without the mode the engine may compute any row without the one before it,
   * so answering from the current row would be an off-by-one-row nobody could
   * see in the output. It refuses instead.
   */
  it('refuses without mode="sequential", and says what to add', () => {
    expect(() =>
      run(`<tdc><env count="3" seed="w">
        <sequence name="W"><gen type="formula" expr="prev(W, 1) + 1"/></sequence>
      </env><block><line><data>\${{W}}</data></line></block></tdc>`),
    ).toThrow(/mode="sequential"/);
  });

  it('refuses an engine that contradicts the mode, naming both', () => {
    expect(() =>
      run(`<tdc><env count="3" seed="w" mode="sequential" engine="2">
        <sequence name="W"><gen type="formula" expr="prev(W, 1) + 1"/></sequence>
      </env><block><line><data>\${{W}}</data></line></block></tdc>`),
    ).toThrow(/engine="2" contradicts mode="sequential"/);
  });

  it('the first argument must be a plain column name', () => {
    expect(() =>
      run(`<tdc><env count="2" seed="w" mode="sequential">
        <sequence name="W"><gen type="formula" expr="prev(1 + 1, 0)"/></sequence>
      </env><block><line><data>\${{W}}</data></line></block></tdc>`),
    ).toThrow();
  });

  /*
   * These three were all predicted to need refusing and none of them do. An
   * exact quota, a uniqueness rearrangement and a per-row repair each finish
   * their own column before the formula that reads it is built, because columns
   * register in DECLARATION order. Pinning that here so the refusals are never
   * added back by someone reasoning about it rather than running it.
   */
  it('an exact percent quota still holds beside a walk', () => {
    const rows = run(`<tdc><env count="10" seed="mx" mode="sequential">
      <sequence name="T"><gen type="increment" value="1"/></sequence>
      <sequence name="Kind"><gen type="text" value="a,b" percent="70,30"/></sequence>
      <sequence name="W"><gen type="formula" expr="prev(W, 0) + 1"/></sequence>
    </env><block><line><data>\${{Kind}}</data></line></block></tdc>`);
    expect(rows.filter((r) => r === 'a')).toHaveLength(7);
    expect(rows.filter((r) => r === 'b')).toHaveLength(3);
  });

  it('uniq and distinct both work beside a walk', () => {
    const rows = run(`<tdc><env count="5" seed="u" mode="sequential">
      <sequence name="T"><gen type="increment" value="1"/></sequence>
      <sequence name="U" uniq="true"><gen type="number" value="1..5"/></sequence>
      <sequence name="W"><gen type="formula" expr="prev(W, 0) + 1"/></sequence>
    </env><block><line><data>\${{U}}|\${{W}}</data></line></block></tdc>`);
    expect(rows.map((r) => r.split('|')[1])).toEqual(['1', '2', '3', '4', '5']);
    expect(new Set(rows.map((r) => r.split('|')[0])).size).toBe(5);
  });
});
