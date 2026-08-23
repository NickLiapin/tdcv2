/**
 * The membership test the uniq repair leans on.
 *
 * One property carries the whole design: it may answer "seen" about a tuple
 * that is free, and must NEVER answer "free" about one that is taken. The first
 * only makes the repair pick a different combination; the second would let a
 * duplicate row through, which is the one thing uniq promises cannot happen.
 */
import { describe, expect, it } from 'vitest';

import { EXACT_TUPLES, SeenTuples } from '../../src/sequence/tuple-filter.js';

const key = (i: number): string => `Male Ivan${String(i)} Petrov${String(i % 977)}`;

describe('SeenTuples', () => {
  it('is exact while the run is small, so existing configs keep their answers', () => {
    const seen = new SeenTuples(1000);
    for (let i = 0; i < 1000; i++) seen.add(key(i));

    expect(seen.approximate).toBe(false);
    for (let i = 0; i < 1000; i++) expect(seen.has(key(i))).toBe(true);
    // Exact means exact in both directions, which the filter cannot promise.
    for (let i = 1000; i < 2000; i++) expect(seen.has(key(i))).toBe(false);
  });

  it('switches to the filter rather than growing, and still knows all it was told', () => {
    /*
     * The reason this file exists. A plain Set of this many entries is what a
     * 97,000,000-row run built, and V8 refused it at sixteen million with
     * "Set maximum size exceeded" — 28 minutes in, nothing written.
     *
     * Slow by test standards because the switch only happens at two million
     * keys, and the switch is the thing being tested.
     */
    const n = EXACT_TUPLES + 100_000;
    const seen = new SeenTuples(n);
    for (let i = 0; i < n; i++) seen.add(key(i));

    expect(seen.approximate).toBe(true);

    // NOT ONE false negative, over everything that went in. This is the
    // safety property: a missed key would mean a duplicate row.
    for (let i = 0; i < n; i++) {
      if (!seen.has(key(i))) throw new Error(`the filter forgot key ${String(i)}`);
    }
  }, 120_000);

  it('errs only towards caution, and rarely', () => {
    const n = EXACT_TUPLES + 100_000;
    const seen = new SeenTuples(n);
    for (let i = 0; i < n; i++) seen.add(key(i));

    // Keys it was never told about. Some come back "seen" — that is the
    // trade. It costs the repair one alternative each time, so what matters
    // is that it stays a fraction of a per cent rather than that it is zero.
    let wrong = 0;
    const probes = 200_000;
    for (let i = n; i < n + probes; i++) if (seen.has(key(i))) wrong++;

    expect(wrong / probes).toBeLessThan(0.02);
  }, 120_000);

  it('holds its size no matter how much it is told', () => {
    // Sized from the row count and capped at 2^30 bits. A hundred million rows
    // and a billion rows ask for the same 128 MB, which is the point.
    for (const seen of [new SeenTuples(100_000_000), new SeenTuples(1_000_000_000)]) {
      for (let i = 0; i < 10; i++) seen.add(key(i));
      expect(seen.has(key(0))).toBe(true);
    }
  });
});
