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

  it('a generator whose values cannot be enumerated is refused, not ignored', async () => {
    // `advanced_regex`, not `regex`: a plain pattern is finite and countable, and takes the
    // redraw path below. The advanced one weighs its branches and reads what it wrote.
    await expect(valuesOf('<gen type="advanced_regex" value="[a-z]{4}"/>', 10)).rejects.toThrow(
      /cannot be enumerated/,
    );
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
