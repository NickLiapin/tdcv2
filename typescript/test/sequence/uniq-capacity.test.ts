/**
 * A `<uniq>` group that cannot possibly cover `count` is refused BEFORE any row
 * is built.
 *
 * The refusal itself is not new — the group has always checked its capacity over
 * the finished columns. What is new is when. Reaching the old check meant
 * materialising the columns first, so two lists of ten values and a count of a
 * billion died in the allocator instead of being told, in the one situation
 * where being told is worth most: the alternative is a long run that was never
 * going to succeed.
 *
 * The size that matters here is therefore the one no machine can hold. These
 * tests pass a count that would need billions of rows and expect an answer in
 * the time a test takes — which is only possible if nothing was allocated.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/** Two lists of ten: a hundred distinct pairs, and no more. */
function hundredPairs(count: number, extra = ''): string {
  return (
    `<tdc><env count="${String(count)}" seed="s" local="en">` +
    '<uniq>' +
    `<sequence name="A"><gen type="text" value="a,b,c,d,e,f,g,h,i,j"${extra}/></sequence>` +
    '<sequence name="B"><gen type="text" value="1,2,3,4,5,6,7,8,9,10"/></sequence>' +
    '</uniq></env><block><line><data>${{A}}${{B}}</data></line></block></tdc>'
  );
}

describe('uniq capacity, asked before anything is built', () => {
  it('refuses a count no machine could hold, instead of dying in the allocator', () => {
    // A billion rows of two columns is tens of gigabytes. Before this the process
    // ran out of heap here; the answer now costs nothing at all.
    expect(() => new TDC({ configString: hundredPairs(1_000_000_000) }).toString()).toThrow(
      /cannot produce 1000000000 unique combinations/,
    );
  });

  it('names the real ceiling, not just the fact of refusal', () => {
    expect(() => new TDC({ configString: hundredPairs(5_000_000_000) }).toString()).toThrow(
      /at most 100 distinct rows/,
    );
  });

  it('lets the exactly-feasible count through — the boundary is not off by one', () => {
    const rows = new TDC({ configString: hundredPairs(100) })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(rows).toHaveLength(100);
    expect(new Set(rows).size).toBe(100);
  });

  it('refuses one row past it', () => {
    expect(() => new TDC({ configString: hundredPairs(101) }).toString()).toThrow(
      /cannot produce 101 unique combinations/,
    );
  });

  it('counts an integer range by its span', () => {
    const config =
      '<tdc><env count="30" seed="s" local="en"><uniq>' +
      '<sequence name="A"><gen type="number" value="1..5"/></sequence>' +
      '<sequence name="B"><gen type="number" value="1..5"/></sequence>' +
      '</uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>';
    expect(() => new TDC({ configString: config }).toString()).toThrow(/at most 25 distinct rows/);
  });

  it('says nothing when a member is not measurable from its spec', () => {
    // A regex draw has no capacity this can read, so the group is unbounded here
    // and the answer must come from the old check over the built columns — which
    // is what keeps a refusal a PROOF rather than a guess.
    const config =
      '<tdc><env count="4" seed="s" local="en"><uniq>' +
      '<sequence name="A"><gen type="regex" value="[A-Z]{6}"/></sequence>' +
      '<sequence name="B"><gen type="text" value="1,2"/></sequence>' +
      '</uniq></env><block><line><data>${{A}}${{B}}</data></line></block></tdc>';
    const rows = new TDC({ configString: config })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(rows).toHaveLength(4);
  });

  it('says nothing when a member is repeated — a cell is then a list, not one draw', () => {
    const config = hundredPairs(4, ' repeat="2" separator="|"');
    const rows = new TDC({ configString: config })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(rows).toHaveLength(4);
  });
});
