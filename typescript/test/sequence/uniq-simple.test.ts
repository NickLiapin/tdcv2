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
    await expect(valuesOf('<gen type="regex" value="[a-z]{4}"/>', 10)).rejects.toThrow(
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
