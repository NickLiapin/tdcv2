/**
 * Counter generators: `<gen type="increment" [value="N"] [step="M"]/>`
 * and `<gen type="decrement" [value="N"] [step="M"]/>`.
 *
 * `increment` starts at `value` (default 0) and adds `step` (default 1)
 * for each cell. `decrement` is the symmetric complement. Both ignore
 * the prng; counters are deterministic by position regardless of seed.
 *
 * Output is the string form of the integer (no padding, no leading
 * zeros). Future phases may add `length` / `first_zero` if a fixture
 * demands it.
 */

import type { Generator } from './generator.js';

export interface CounterAttrs {
  readonly start?: number | undefined;
  readonly step?: number | undefined;
}

export function incrementGenerator(attrs: CounterAttrs = {}): Generator {
  const start = attrs.start ?? 0;
  const step = attrs.step ?? 1;
  return (count) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      out[i] = String(start + step * i);
    }
    return out;
  };
}

export function decrementGenerator(attrs: CounterAttrs = {}): Generator {
  const start = attrs.start ?? 0;
  const step = attrs.step ?? 1;
  return (count) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      out[i] = String(start - step * i);
    }
    return out;
  };
}
