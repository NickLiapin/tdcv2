/**
 * Feistel index permutation — a "lottery with no tumbler".
 *
 * A keyed pseudo-random **bijection** on `[0, n)`: `permute(i, n, key)` maps
 * each row index to a unique, scrambled "slot" without ever building an
 * array. This is what lets the streaming engine place a sorted quota plan
 * (`[A×70%, B×30%]`) into random-looking positions and get EXACT percentages
 * — because a bijection sends exactly `0.7n` indices into the first `0.7n`
 * slots — with O(1) memory and O(1) per row.
 *
 * Construction: a balanced Feistel network on the smallest `2^(2·half) ≥ n`,
 * with **cycle-walking** to fold the domain back down to exactly `[0, n)` for
 * non-power-of-two `n` (re-apply until the result is in range; expected < 4
 * iterations since the padded domain is < 4n). `unpermute` is the inverse
 * (needed by uniq's mixed-radix decode later).
 *
 * Determinism is cross-language: the round function uses only `Math.imul` and
 * 32-bit ops, and the key comes from cyrb128. Combining halves uses plain
 * arithmetic (not bit-shifts) so it stays exact for `n` up to ~2^52.
 */

import { cyrb128 } from './prng.js';

const ROUNDS = 4;

/** Derive a 32-bit round key for a permutation stream. */
export function permuteKey(seed: string, streamId: string): number {
  return cyrb128(`${seed}|perm|${streamId}`)[0];
}

/** Padded domain for `n`: two equal halves, `2^(2·half) ≥ n`. */
function halfSizeFor(n: number): number {
  const bits = Math.max(2, Math.ceil(Math.log2(n)));
  const half = Math.ceil(bits / 2);
  return 2 ** half;
}

/** 32-bit avalanche of the low half `r`, mixed with the round and key. */
function roundFn(r: number, round: number, key: number): number {
  let h = (r ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = Math.imul((h ^ key) >>> 0, 0x27d4eb2f) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function feistelForward(x: number, halfSize: number, key: number): number {
  let left = Math.floor(x / halfSize);
  let right = x % halfSize;
  for (let round = 0; round < ROUNDS; round++) {
    const mixed = roundFn(right, round, key) % halfSize;
    const nextRight = (left ^ mixed) >>> 0;
    left = right;
    right = nextRight;
  }
  return left * halfSize + right;
}

function feistelInverse(y: number, halfSize: number, key: number): number {
  let left = Math.floor(y / halfSize);
  let right = y % halfSize;
  for (let round = ROUNDS - 1; round >= 0; round--) {
    const prevRight = left;
    const mixed = roundFn(prevRight, round, key) % halfSize;
    const prevLeft = (right ^ mixed) >>> 0;
    left = prevLeft;
    right = prevRight;
  }
  return left * halfSize + right;
}

/** Bijection `[0, n) → [0, n)`: the scrambled slot for row `index`. */
export function permute(index: number, n: number, key: number): number {
  if (n <= 1) return 0;
  const halfSize = halfSizeFor(n);
  let x = index;
  do {
    x = feistelForward(x, halfSize, key);
  } while (x >= n);
  return x;
}

/** Inverse of `permute`: the row index that maps to `slot`. */
export function unpermute(slot: number, n: number, key: number): number {
  if (n <= 1) return 0;
  const halfSize = halfSizeFor(n);
  let x = slot;
  do {
    x = feistelInverse(x, halfSize, key);
  } while (x >= n);
  return x;
}
