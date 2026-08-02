/**
 * Resolve a builtin template path to a per-cell value factory.
 *
 * Only the two date-based GENERATORS remain builtin: `person.b_day` and
 * `date.range`. All name/place DATA now lives in locale-first packs
 * (`data/packs/<locale>/…`) and is resolved via `resolvePackAddress` + the
 * pack registry at the call sites (sequence/build.ts, processor/render.ts,
 * lib/gen.ts). Bare addresses are locale-relative (soft), locale-prefixed
 * ones are absolute (hard).
 *
 * Unknown paths return `undefined` so callers can produce a targeted error.
 */

import { renderBDay, renderDateRange } from '../generators/date.js';
import type { AttrMap } from '../processor/attrs.js';

/**
 * Given a dotted template path + runtime attributes, produce the string
 * value for one cell. Clock injection lets tests freeze dates.
 */
export type TemplateSource = (
  prng: () => number,
  attrs: AttrMap,
  locale: string,
  now: number,
) => string;

/**
 * Lookup a builtin template path to its per-cell source function. Returns
 * `undefined` for unknown paths (including all data addresses, which resolve
 * via the pack registry, not here).
 */
export function resolveTemplate(path: string): TemplateSource | undefined {
  return REGISTRY[path];
}

const REGISTRY: Record<string, TemplateSource> = {
  'person.b_day': renderBDay,
  'date.range': renderDateRange,
};

/**
 * Register a custom template source at runtime. Part of the public API
 * (re-exported from the package entry) so embedders can add their own
 * template paths.
 */
export function registerTemplate(path: string, source: TemplateSource): void {
  REGISTRY[path] = source;
}
