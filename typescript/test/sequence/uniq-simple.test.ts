import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * `uniq="true"` on a SIMPLE sequence: a draw without replacement. Before this
 * existed the attribute was accepted and silently dropped — 100 "unique" names
 * repeated 16 times over. These tests pin the three faces of the contract:
 * unique when the pool allows it, refused plainly when it does not, and
 * deterministic either way.
 */
const config = (body: string, count: number): string =>
  `<tdc version="0.01"><env count="${String(count)}" seed="u" local="en">` +
  `<sequence name="G" uniq="true">${body}</sequence></env>` +
  `<block><line><data>\${{G}}</data></line></block></tdc>`;

const valuesOf = async (body: string, count: number): Promise<string[]> => {
  const data = new TDC({ configString: config(body, count) });
  return (await data.toStringAsync()).trim().split('\n');
};

describe('uniq on a simple sequence', () => {
  it('a value list: every row differs, weights of the list order preserved', async () => {
    const out = await valuesOf('<gen type="text" value="a,b,c,d,e"/>', 5);
    expect(new Set(out).size).toBe(5);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a plain integer range: all rows distinct', async () => {
    const out = await valuesOf('<gen type="number" value="1..50"/>', 50);
    expect(new Set(out).size).toBe(50);
  });

  it('a weighted pack: unique across the run, which plain draws cannot do', async () => {
    const out = await valuesOf('<gen type="template" value="person.male.firstName"/>', 100);
    expect(out).toHaveLength(100);
    expect(new Set(out).size).toBe(100);
  });

  it('deterministic: the same seed gives the same hundred, in the same order', async () => {
    const a = await valuesOf('<gen type="template" value="person.male.firstName"/>', 100);
    const b = await valuesOf('<gen type="template" value="person.male.firstName"/>', 100);
    expect(a).toEqual(b);
  });

  it('a pool smaller than the count is refused, naming both numbers', async () => {
    await expect(valuesOf('<gen type="text" value="a,b,c"/>', 10)).rejects.toThrow(
      /cannot produce 10 unique values — its source holds only 3 distinct values/,
    );
  });

  it('a range smaller than the count is refused, naming the range', async () => {
    await expect(valuesOf('<gen type="number" value="1..5"/>', 10)).rejects.toThrow(
      /the range 1\.\.5 holds only 5 integers/,
    );
  });

  it('a generator whose values cannot be counted is refused, not ignored', async () => {
    // A date, not a pattern: both kinds of pattern are finite and countable, and take the redraw
    // paths below.
    await expect(
      valuesOf('<gen type="date" from="2026-01-01" to="2026-03-01" format="YYYY-MM-DD"/>', 10),
    ).rejects.toThrow(/cannot be enumerated/);
  });

  it('duplicate strings in the source merge — the pool counts distinct VALUES', async () => {
    await expect(valuesOf('<gen type="text" value="a,b,a,b"/>', 3)).rejects.toThrow(
      /holds only 2 distinct values/,
    );
  });

  it('increment stays on its normal build — unique by construction', async () => {
    const out = await valuesOf('<gen type="increment" value="1"/>', 5);
    expect(out).toEqual(['1', '2', '3', '4', '5']);
  });
});

/**
 * `uniq="true"` over a `type="regex"` pattern. It used to be refused as "cannot be enumerated",
 * which was never the requirement — the integer range beside it is not enumerated either, it
 * redraws on a repeat. What uniqueness needs is the SIZE of the source, and a finite pattern has
 * one. These pin the size, the refusal made from it, and the two ways the drawing can run dry.
 */
describe('uniq over a regex pattern', () => {
  it('a plate-number pattern: every row a different plate', async () => {
    const out = await valuesOf('<gen type="regex" value="[A-Z]{2}-[0-9]{4}/[0-9]{2}"/>', 2000);
    expect(out).toHaveLength(2000);
    expect(new Set(out).size).toBe(2000);
    for (const v of out) expect(v).toMatch(/^[A-Z]{2}-[0-9]{4}\/[0-9]{2}$/);
  });

  it('the whole of a small space: all hundred two-digit strings, once each', async () => {
    const out = await valuesOf('<gen type="regex" value="[0-9]{2}"/>', 100);
    expect([...out].sort()).toEqual(
      Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0')),
    );
  });

  it('one more than the space holds is refused before anything is drawn', async () => {
    await expect(valuesOf('<gen type="regex" value="[0-9]{2}"/>', 101)).rejects.toThrow(
      /cannot produce 101 unique values — the pattern "\[0-9\]\{2\}" makes at most 100/,
    );
  });

  it('a variable length counts every length it allows, not the shortest', async () => {
    // 10² + 10³ = 1 100. Counting only the shortest form would refuse this at 101.
    const out = await valuesOf('<gen type="regex" value="[0-9]{2,3}"/>', 1100);
    expect(new Set(out).size).toBe(1100);
    await expect(valuesOf('<gen type="regex" value="[0-9]{2,3}"/>', 1101)).rejects.toThrow(
      /makes at most 1100 different strings/,
    );
  });

  it('a pattern counted high stops with the reason, not in a loop', async () => {
    // `(a|a)` has two branches and one string, so it is counted as two. Asking for two passes
    // the count and then cannot be met — and says so after a run of repeats.
    await expect(valuesOf('<gen type="regex" value="(a|a)"/>', 2)).rejects.toThrow(
      /after 1 unique values the pattern "\(a\|a\)" produced only ones already drawn/,
    );
  });

  it('a back-reference does not multiply the space — the group it repeats is counted once', async () => {
    // `([ab])\\1` makes aa and bb: two, not four.
    const out = await valuesOf('<gen type="regex" value="([ab])\\1"/>', 2);
    expect([...out].sort()).toEqual(['aa', 'bb']);
    await expect(valuesOf('<gen type="regex" value="([ab])\\1"/>', 3)).rejects.toThrow(
      /makes at most 2 different strings/,
    );
  });

  it('deterministic: the same seed gives the same plates, in the same order', async () => {
    const a = await valuesOf('<gen type="regex" value="[A-Z]{2}[0-9]{3}"/>', 500);
    const b = await valuesOf('<gen type="regex" value="[A-Z]{2}[0-9]{3}"/>', 500);
    expect(a).toEqual(b);
  });
});

/**
 * `uniq="true"` over an `advanced_regex` pattern — the plain pattern's redraw, with the one thing
 * this generator adds kept exact: its weighted shares. The column is dealt as it would be without
 * `uniq`; a repeated value is redrawn along the branches its row was dealt, so no share moves by a
 * single row; and "is there room?" is asked of each share as well as of the whole pattern.
 */
describe('uniq over an advanced_regex pattern', () => {
  const adv = (pattern: string): string => `<gen type="advanced_regex" value="${pattern}"/>`;
  const share = (out: readonly string[], prefix: string): number =>
    out.filter((v) => v.startsWith(prefix)).length;

  it('keeps every weighted share exact while making every row different', async () => {
    const out = await valuesOf(adv('(?%{70:RU;30:US})-[0-9]{4}'), 2000);
    expect(new Set(out).size).toBe(2000);
    expect(share(out, 'RU')).toBe(1400);
    expect(share(out, 'US')).toBe(600);
  });

  it('a share too small for its rows is refused by its percentage, before any redraw', async () => {
    // The whole pattern makes 2 000 strings — exactly as many as asked for. The RU share needs
    // 1 400 of the 1 000 that start RU-, and that is the refusal a reader can act on.
    await expect(valuesOf(adv('(?%{70:RU;30:US})-[0-9]{3}'), 2000)).rejects.toThrow(
      /the 70% \(branch 1 of 2\) share of the pattern ".*" is 1400 rows, and it can make at most 1000 different strings/,
    );
  });

  it('the whole pattern too small is refused first, as for a plain pattern', async () => {
    await expect(valuesOf(adv('(?%{50:a;50:b})'), 3)).rejects.toThrow(
      /cannot produce 3 unique values — the pattern ".*" makes at most 2/,
    );
  });

  it('every string of every share, with the shares still exact', async () => {
    const out = await valuesOf(adv('(?%{50:A;50:B})[0-9]{2}'), 200);
    expect(new Set(out).size).toBe(200);
    expect(share(out, 'A')).toBe(100);
    expect(share(out, 'B')).toBe(100);
  });

  it('a conditional that reads a weighted group still agrees with it after a redraw', async () => {
    // M rows take [a-c], F rows [x-z]: thirty strings each, and all thirty of each are asked for.
    const out = await valuesOf(adv('(?<s>(?%{50:M;50:F}))-(?if{s=M:[a-c];s=F:[x-z]})[0-9]'), 60);
    expect(new Set(out).size).toBe(60);
    for (const v of out) expect(v).toMatch(/^(M-[a-c]|F-[x-z])[0-9]$/);
    expect(share(out, 'M')).toBe(30);
  });

  it('a nested share is counted along both branches it took', async () => {
    const pattern = '(?%{50:(?%{50:a;50:b});50:c})[0-9]';
    const out = await valuesOf(adv(pattern), 20);
    expect([share(out, 'a'), share(out, 'b'), share(out, 'c')]).toEqual([5, 5, 10]);
    expect(new Set(out).size).toBe(20);
    await expect(valuesOf(adv(pattern), 30)).rejects.toThrow(
      /the 50% \(branch 2 of 2\) share .* is 15 rows, and it can make at most 10/,
    );
  });

  it('a weighted choice inside a repeat stays exact at every step', async () => {
    const out = await valuesOf(adv('((?%{50:a;50:b})){2}[0-9]'), 30);
    expect(new Set(out).size).toBe(30);
    expect(out.filter((v) => v.startsWith('a'))).toHaveLength(15);
    expect(out.filter((v) => v[1] === 'a')).toHaveLength(15);
  });

  it('a row under an alternation stays on the side it was dealt when it is redrawn', async () => {
    // Weighted choice under a free alternation: a redraw that wanders to the other side meets a
    // different set of weighted choices, and is thrown away rather than moving a share.
    const out = await valuesOf(adv('(x|(?%{50:a;50:b}))[0-9]{2}'), 60);
    expect(new Set(out).size).toBe(60);
    // The a and b rows are dealt between themselves exactly, however many took that side — so
    // an odd number splits one apart, never more.
    expect(Math.abs(share(out, 'a') - share(out, 'b'))).toBeLessThanOrEqual(1);
  });

  it('a pattern counted high stops with the reason, naming the share', async () => {
    await expect(valuesOf(adv('(?%{100:(a|a)})'), 2)).rejects.toThrow(
      /after 1 unique values the 100% \(branch 1 of 1\) share of the pattern/,
    );
  });

  it('deterministic: the same seed gives the same rows, in the same order', async () => {
    const body = adv('(?%{60:77;40:78})[A-Z]{2}[0-9]{2}');
    expect(await valuesOf(body, 800)).toEqual(await valuesOf(body, 800));
  });
});
