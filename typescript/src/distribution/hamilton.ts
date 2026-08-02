/**
 * Hamilton's largest-remainder method for distributing a total count
 * across a set of values according to given percentages.
 *
 * Use case: given `count = 1_000_000` and the rule "60% men, 40% women",
 * produce exactly 600 000 men and 400 000 women cells. When percentages
 * don't divide `count` evenly, the unallocated remainder is distributed
 * to the values with the largest fractional part first; ties are broken
 * randomly via the supplied PRNG.
 *
 * Ported from the 2022-2024 TDC prototype's `Generator.allocateDataByPercentage`.
 * Bit-identical on the same (count, values, percents, prng-state) input
 * — see the golden vectors in the companion test file. Any future port
 * (Python, Java) MUST reproduce these outputs exactly.
 *
 * Both the tie-breaking and the final Fisher-Yates shuffle consume from
 * the supplied PRNG, in that order. The returned array is the
 * materialized, shuffled sequence.
 *
 * Full spec: docs/vision/02-sequences.md
 */

import { shuffle } from '../prng/random.js';

export interface DistributeOptions<T> {
  /** Total number of cells to materialize. Must be > 0. */
  readonly count: number;
  /** Distinct values to distribute across the cells. */
  readonly values: readonly T[];
  /**
   * Percentages for each value in `values`; length MUST equal values.length.
   * Values are expected to be non-negative and to sum to 100 (modulo
   * floating-point noise). No bounds check is performed here.
   */
  readonly percents: readonly number[];
  /** PRNG; consumed for tie-breaking and the final shuffle. */
  readonly prng: () => number;
}

/**
 * Distribute `count` cells across `values` in the proportions given by
 * `percents`, and return the materialized, shuffled sequence.
 */
export function distributeByPercent<T>(opts: DistributeOptions<T>): T[] {
  const { count, values, percents, prng } = opts;
  const truncCounts = computeCountsPerValue(count, percents, prng);
  return materializeAndShuffle(values, truncCounts, prng);
}

/**
 * Compute how many cells each value in `percents` should receive.
 * Exported separately so that higher-level sequence engine code can
 * consume the raw counts without forcing materialization + shuffle.
 */
export function computeCountsPerValue(
  count: number,
  percents: readonly number[],
  prng: () => number,
): number[] {
  const cardPercent = 100 / count;
  const truncCounts: number[] = new Array<number>(percents.length);
  const fracRemainders: number[] = new Array<number>(percents.length);

  let filled = 0;
  for (let i = 0; i < percents.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rawCells = percents[i]! / cardPercent;
    const whole = Math.trunc(rawCells);
    truncCounts[i] = whole;
    fracRemainders[i] = rawCells % 1;
    filled += whole;
  }

  let unallocated = count - filled;
  if (unallocated <= 0) return truncCounts;

  // Hand out the leftover cells to the largest fractional remainders.
  //
  // Sorted ONCE rather than rescanned per cell. The previous form called
  // `Math.max(...fracRemainders)` inside the loop, which cost O(cells x values)
  // and — worse — spread the whole array as arguments: at 160 000 values (the
  // size of the US census surname list) that overflows the call stack outright.
  // Measured before this change: 1000 values 0.01s, 50 000 values 0.47s,
  // 160 000 values "Maximum call stack size exceeded".
  //
  // Order is (remainder DESC, index ASC), which reproduces the old walk exactly:
  // it repeatedly took the maximum and, among ties, the lowest index first.
  const order = Array.from({ length: fracRemainders.length }, (_, i) => i).sort((a, b) => {
    const diff = (fracRemainders[b] ?? 0) - (fracRemainders[a] ?? 0);
    return diff !== 0 ? diff : a - b;
  });

  let at = 0;
  while (unallocated > 0 && at < order.length) {
    // Everything sharing this remainder forms one tie group.
    const remainder = fracRemainders[order[at] ?? 0] ?? 0;
    let end = at;
    while (end < order.length && (fracRemainders[order[end] ?? 0] ?? 0) === remainder) end++;
    const groupSize = end - at;

    if (groupSize <= unallocated) {
      // The whole group fits — every member gets a cell, lowest index first.
      for (let k = at; k < end; k++) {
        const index = order[k] ?? 0;
        truncCounts[index] = (truncCounts[index] ?? 0) + 1;
        unallocated -= 1;
      }
      at = end;
      continue;
    }

    // More tied than cells left. The old code picked one at random per cell
    // from the SHRINKING set of still-tied indices, consuming one prng call
    // each — reproduced here so the output does not move.
    const pool = order.slice(at, end);
    while (unallocated > 0) {
      const pick = Math.floor(prng() * pool.length);
      const index = pool[pick] ?? 0;
      truncCounts[index] = (truncCounts[index] ?? 0) + 1;
      pool.splice(pick, 1);
      unallocated -= 1;
    }
  }

  return truncCounts;
}

function materializeAndShuffle<T>(
  values: readonly T[],
  counts: readonly number[],
  prng: () => number,
): T[] {
  const sequence: T[] = [];
  for (let i = 0; i < values.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const n = counts[i]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const v = values[i]!;
    for (let j = 0; j < n; j++) sequence.push(v);
  }
  return shuffle(prng, sequence);
}
