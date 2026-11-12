/**
 * The one-line building block every streaming column is made of.
 *
 * Its own file so the pieces split out of `stream-build.ts` can use it without
 * any of them pointing back at the others.
 */

import type { Sequence } from './types.js';

/** A column that computes row `i` on demand instead of holding an array. */
export function lazy(name: string, resolve: (i: number) => string | undefined): Sequence {
  return { name, values: [], resolve };
}

/**
 * The same column, answering a repeat read of the row it last answered without
 * computing it again.
 *
 * A row asks for one column more than once — `if="Hash == ''"` and the line
 * both read `Hash` — and each read drew it from scratch: the 64-character hash
 * in that example was generated twice per row. Every streaming column is a
 * function of the row alone, so keeping the last answer changes no value.
 */
export function rememberLastRow(seq: Sequence): Sequence {
  const resolve = seq.resolve;
  if (!resolve) return seq;
  let lastRow = -1;
  let lastValue: string | undefined;
  return {
    ...seq,
    resolve: (i) => {
      if (i === lastRow) return lastValue;
      const value = resolve(i);
      lastRow = i;
      lastValue = value;
      return value;
    },
  };
}
