/**
 * Text generators.
 *
 * Two flavours corresponding to the <gen type="text" ...> forms in the
 * TDC DSL:
 *
 *   - `textWithPercents(values, percents)` — Hamilton-distributes `count`
 *     cells across `values` according to exact `percents`, then shuffles.
 *     Corresponds to `<gen type="text" value="a,b" percent="30,70"/>`.
 *
 *   - `textUniform(values)` — picks independently and uniformly from
 *     `values` for each of the `count` cells. Corresponds to
 *     `<gen type="text" value="a,b"/>` without `percent=`.
 *
 * Both return an array of length `count` and consume PRNG calls
 * deterministically — identical (values, count, prng-state) yields
 * identical output across ports.
 */

import { distributeByPercent } from '../distribution/hamilton.js';
import { randomPick } from '../prng/random.js';

import type { Generator } from './generator.js';

/**
 * Build a Generator that distributes cells across `values` according
 * to `percents`, using Hamilton's largest-remainder method followed by
 * a shuffle. Values.length must match percents.length, and percents
 * must sum to 100 (modulo fp noise).
 */
export function textWithPercents(
  values: readonly string[],
  percents: readonly number[],
): Generator {
  return (count, prng) => distributeByPercent({ count, values, percents, prng });
}

/**
 * Build a Generator that populates each cell with an independent
 * uniform-random pick from `values`. `values` must be non-empty.
 */
export function textUniform(values: readonly string[]): Generator {
  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      out[i] = randomPick(prng, values);
    }
    return out;
  };
}
