/**
 * "Has this tuple been seen?" — answered in memory that does not grow with the
 * dataset.
 *
 * The uniq repair rearranges the few rows that collided, and it must not land
 * them on a tuple some other row already holds. So it needs a membership test
 * over every existing tuple. Holding them all is what a plain set does, and
 * that set is proportional to the WHOLE run rather than to the handful of rows
 * being repaired: on a 97,000,000-row config it passed sixteen million entries
 * and V8 refused it outright ("Set maximum size exceeded"), 28 minutes in, with
 * nothing written. The streaming half of the same run held steady under 2 GB —
 * this was the one part that did not scale.
 *
 * Below `EXACT_TUPLES` the set is kept exactly as before, so every config that
 * works today keeps the arrangement it has today. Past that it degrades to a
 * Bloom filter of fixed size: a bit array plus seven probes per key.
 *
 * The degradation is one-sided, and that is what makes it safe. A Bloom filter
 * can say "seen" about a tuple that is free — never "free" about one that is
 * taken. The repair then avoids a combination it could have used and picks
 * another; if it runs out of room it raises the same refusal it already raises
 * for a pool too tight, which hands the config to the in-memory engine. A
 * duplicate row cannot come out of this, whatever the filter says.
 *
 * Every number here is part of the cross-language contract. The size, the probe
 * count and the hash all decide WHICH tuples a run avoids, so five
 * implementations that differ in any of them produce different files from one
 * seed. The hash is `cyrb128`, which all five already carry and pin with golden
 * vectors.
 */

import { cyrb128 } from '../prng/prng.js';

/**
 * Keys held exactly before switching to the filter.
 *
 * Two million strings of tuple length cost a few hundred megabytes — affordable,
 * and far under V8's own ceiling of 2^24 set entries, which a run must never be
 * allowed to reach.
 */
export const EXACT_TUPLES = 2_000_000;

/** Probes per key. With the sizing below this leaves a false-positive rate near half a per cent. */
const PROBES = 7;

/** Never smaller than this, so a tiny run still has room to spare. */
const MIN_BITS = 1 << 10;

/**
 * Never larger than this: 2^30 bits is 128 MB, the point past which the filter
 * would be the memory problem it was added to solve.
 */
const MAX_BITS = 1 << 30;

/**
 * Bits for `expected` keys — twelve apiece, rounded UP to a power of two so the
 * index is a mask rather than a division. A power of two also removes the
 * modulo-bias question, which is one fewer thing for five languages to get
 * subtly different.
 */
function bitsFor(expected: number): number {
  const wanted = expected * 12;
  let bits = MIN_BITS;
  while (bits < wanted && bits < MAX_BITS) bits *= 2;
  return Math.min(bits, MAX_BITS);
}

/**
 * The tuples already taken.
 *
 * Exact while it is small, approximate — and only ever over-cautious — once it
 * is not. Callers use it through `add` and `has` and do not know which it is.
 */
export class SeenTuples {
  private exact: Set<string> | undefined = new Set<string>();
  private bits: Uint32Array | undefined;
  private mask = 0;

  /**
   * @param expected Upper bound on how many keys may be added — the row count.
   *   Only used to size the filter, and only if the exact set is outgrown.
   */
  constructor(private readonly expected: number) {}

  add(key: string): void {
    const exact = this.exact;
    if (exact !== undefined) {
      exact.add(key);
      if (exact.size < EXACT_TUPLES) return;
      // Outgrown: move what has been collected into the filter and let the
      // strings go. Both live for the length of this loop and no longer.
      this.startFilter();
      for (const held of exact) this.setBits(held);
      this.exact = undefined;
      return;
    }
    this.setBits(key);
  }

  has(key: string): boolean {
    const exact = this.exact;
    if (exact !== undefined) return exact.has(key);

    const bits = this.bits;
    if (bits === undefined) return false;
    const [h1, h2] = cyrb128(key);
    const step = (h2 | 1) >>> 0; // odd, so the probes walk the whole array
    for (let i = 0; i < PROBES; i++) {
      const at = ((h1 + i * step) >>> 0) & this.mask;
      if (((bits[at >>> 5] ?? 0) & (1 << (at & 31))) === 0) return false;
    }
    return true;
  }

  /** True once the answers are approximate — for tests and for reporting. */
  get approximate(): boolean {
    return this.exact === undefined;
  }

  private startFilter(): void {
    const total = bitsFor(this.expected);
    this.mask = total - 1;
    this.bits = new Uint32Array(total / 32);
  }

  private setBits(key: string): void {
    const bits = this.bits;
    if (bits === undefined) return;
    const [h1, h2] = cyrb128(key);
    const step = (h2 | 1) >>> 0;
    for (let i = 0; i < PROBES; i++) {
      const at = ((h1 + i * step) >>> 0) & this.mask;
      const word = at >>> 5;
      bits[word] = (bits[word] ?? 0) | (1 << (at & 31));
    }
  }
}
