/**
 * The one-line building block every streaming column is made of.
 *
 * Its own file so the pieces split out of `stream-build.ts` can use it without
 * any of them pointing back at the others.
 */

import { httpInputWindowOf } from '../generators/http-column.js';
import type { Sequence, SequenceSpec } from './types.js';

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

/**
 * Each column an `http` sends as `in=`, and how many of its rows to keep.
 *
 * Found by walking the specs for any `{ type: 'http', attrs }`, so a call inside a `<mix>` or
 * `<switch>` case, an `if=` branch or a compound's field counts as well as a plain sequence.
 */
export function httpInputWindows(specs: readonly SequenceSpec[]): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new WeakSet();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const attrs = record['attrs'];
    if (record['type'] === 'http' && attrs !== null && typeof attrs === 'object') {
      const gen = attrs as Record<string, string | undefined>;
      const name = (gen['in'] ?? '').trim();
      if (name !== '') out.set(name, Math.max(out.get(name) ?? 0, httpInputWindowOf(gen)));
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(specs);
  return out;
}

/**
 * The same column, keeping its last `window` rows — for a column an `http` sends as `in=`.
 *
 * Row `i` lives in slot `i % window` until a row `window` away takes the slot. A batch and the
 * ones read ahead of it are consecutive rows within the window, so none of them pushes out
 * another. (A Map that dropped its oldest key on every insert was slower than drawing the row
 * again: V8 skips every deleted entry each time it looks for the first one.) See
 * `httpInputWindowOf`.
 */
export function rememberRows(seq: Sequence, window: number): Sequence {
  const resolve = seq.resolve;
  if (!resolve) return seq;
  const rows = new Array<number>(window).fill(-1);
  const values = new Array<string | undefined>(window);
  return {
    ...seq,
    resolve: (i) => {
      const slot = i % window;
      if (rows[slot] === i) return values[slot];
      const value = resolve(i);
      rows[slot] = i;
      values[slot] = value;
      return value;
    },
  };
}
