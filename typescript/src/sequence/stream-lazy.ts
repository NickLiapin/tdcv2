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
