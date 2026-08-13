/**
 * `repeat="0..5" lengths="40,25,15,10,7,3"` — a fan-out with a SHAPE.
 *
 * Without `lengths=` every length is equally likely, and exactly so: the counts
 * are laid out as a Hamilton quota, which over 20,000 parents gives 16.66% to
 * each of six lengths with no sampling noise at all. Real one-to-many data never
 * looks like that — most customers have one or two orders, a few have twenty —
 * so a model trained on a flat fan learns something false.
 *
 * The shares live in the SPEC, decided for the whole run, rather than being
 * drawn per row. That is not a shortcut: how many values a row produces decides
 * how many draws it spends, and a per-row count would make row `n` depend on
 * every row before it — the one property the streaming engine and `--jobs` are
 * built on. As a quota it is also EXACT: 40% of parents have none, not "about
 * 40%".
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

function run(attrs: string, count: number, engine: 1 | 2): string[] {
  const cfg =
    `<tdc><env count="${String(count)}" seed="r1" local="en">` +
    `<sequence name="Ord"><gen type="number" value="1..9" ${attrs}/></sequence>` +
    '</env><block><line><data>${{Ord}}</data></line></block></tdc>';
  // Only the FINAL newline is dropped. An empty line in the middle is a row
  // that produced no values at all, which is exactly what a `0` share means and
  // must stay countable.
  const text = new TDC({ configString: cfg, engine }).toString();
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** How many values each row produced, as a count per length. */
function histogram(lines: readonly string[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const n = line === '' ? 0 : line.split(';').length;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

describe('repeat + lengths=', () => {
  it('gives each length exactly the share asked for', () => {
    const lines = run('repeat="0..5" lengths="40,25,15,10,7,3" separator=";"', 2000, 1);
    const counts = histogram(lines);
    expect(counts.get(0)).toBe(800);
    expect(counts.get(1)).toBe(500);
    expect(counts.get(2)).toBe(300);
    expect(counts.get(3)).toBe(200);
    expect(counts.get(4)).toBe(140);
    expect(counts.get(5)).toBe(60);
  });

  it('stays exact when the shares do not divide the row count evenly', () => {
    // 33/33/34 over 100 rows is where a naive rounding loses or invents a row.
    // The quota is Hamilton's, the same arithmetic `percent=` uses, so the three
    // groups still add up to exactly the run.
    const lines = run('repeat="1..3" lengths="33,33,34" separator=";"', 100, 1);
    const counts = histogram(lines);
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(100);
    expect(counts.get(1)).toBe(33);
    expect(counts.get(2)).toBe(33);
    expect(counts.get(3)).toBe(34);
  });

  it('produces a heavy tail — the shape the flat fan cannot', () => {
    const lines = run('repeat="0..5" lengths="60,20,10,6,3,1" separator=";"', 1000, 1);
    const counts = histogram(lines);
    expect(counts.get(0)).toBe(600);
    expect(counts.get(5)).toBe(10);
    // The point of the feature, stated as a comparison: the flat version of the
    // same config spreads those thousand rows evenly instead.
    const flat = histogram(run('repeat="0..5" separator=";"', 1000, 1));
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(flat.get(n)).toBeGreaterThan(160);
      expect(flat.get(n)).toBeLessThan(170);
    }
  });

  it('is not a per-row draw: the streaming engine agrees row for row', () => {
    const attrs = 'repeat="0..4" lengths="50,25,15,7,3" separator=";"';
    expect(run(attrs, 400, 2)).toEqual(run(attrs, 400, 1));
  });

  it('refuses a share list that does not match the possible lengths', () => {
    expect(() => run('repeat="0..5" lengths="40,25,15,10,10"', 10, 1)).toThrow(
      /5 share\(s\) for 6 possible/,
    );
  });

  it('refuses shares that do not sum to 100', () => {
    expect(() => run('repeat="0..2" lengths="40,25,15"', 10, 1)).toThrow(/sum to 80/);
  });

  it('leaves the flat quota alone when lengths= is absent', () => {
    const counts = histogram(run('repeat="0..3" separator=";"', 400, 1));
    for (const n of [0, 1, 2, 3]) expect(counts.get(n)).toBe(100);
  });
});
