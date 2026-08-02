/**
 * Interpolation of `${{name}}` references in literal text.
 *
 * Shared by the render pipeline and the data-pack generator executor: a
 * generator's `<data>` output uses the same interpolation as a config's
 * `<data>`.
 */

import { applyFilter } from '../format/transforms.js';
import { sequenceValueAt } from '../sequence/index.js';
import type { SequenceRegistry } from '../sequence/index.js';

/**
 * Interpolate sequence references in a literal string using the `inject`
 * pattern. The pattern contains exactly one `%` marking the variable-name
 * slot, e.g. "${{%}}" means the markers are `${{` and `}}`.
 *
 * Resolution:
 *   - The name is looked up in `registry` (built-ins `_count`/etc. plus
 *     declared sequences).
 *   - A present value at `iteration` is substituted; `undefined`
 *     (parent-filtered row) becomes an empty string.
 *   - An unknown name is left as-is (helps spot typos).
 */
export function interpolate(
  text: string,
  inject: string,
  iteration: number,
  registry: SequenceRegistry,
): string {
  const segments = compileTemplate(text, inject);
  // Fast path: a template with no `${{…}}` refs is a single literal segment.
  if (segments.length === 1) {
    const only = segments[0];
    if (typeof only === 'string') return only;
  }
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'string') {
      out += seg;
      continue;
    }
    const seq = registry[seg.name];
    // Unknown name is left as-is (its original `${{…}}` marker) to help spot typos.
    if (!seq) {
      out += seg.orig;
      continue;
    }
    out += applyFilters(sequenceValueAt(seq, iteration) ?? '', seg.filters);
  }
  return out;
}

/** A `NAME | filter | filter…` reference inside `${{…}}`. */
interface Filter {
  readonly kind: string;
  readonly arg?: string;
}

/** A compiled template piece: a literal chunk, or a `${{ref}}` reference. */
type Segment =
  | string
  | { readonly name: string; readonly filters: readonly Filter[]; readonly orig: string };

/** Apply the interpolation filter chain (mask, case, slice/replace/trim/group). */
function applyFilters(value: string, filters: readonly Filter[]): string {
  let v = value;
  for (const f of filters) v = applyFilter(f.kind, f.arg, v);
  return v;
}

/**
 * Parse the braces' content `NAME ( "|" filter )*` into a name + filter chain.
 * `filter` is `word` (no-arg transform) or `word ":" arg` (e.g. `mask:xxx-xxx`);
 * the arg runs to the next `|` (mask patterns never contain `|`).
 */
function parseRef(raw: string): { name: string; filters: Filter[] } {
  const parts = raw.split('|');
  const name = (parts[0] ?? '').trim();
  const filters: Filter[] = [];
  for (let i = 1; i < parts.length; i++) {
    const piece = parts[i] ?? '';
    const colon = piece.indexOf(':');
    if (colon < 0) {
      const kind = piece.trim();
      if (kind) filters.push({ kind });
    } else {
      const kind = piece.slice(0, colon).trim();
      if (kind) filters.push({ kind, arg: piece.slice(colon + 1).trim() });
    }
  }
  return { name, filters };
}

/**
 * Compile a template into literal/reference segments ONCE, cached by
 * `inject`+`text`. The render loop calls `interpolate` for the same (memoized)
 * `<data>` text on every row; compiling to segments turns the per-row
 * `String.replace(regex, cb)` — a top hot spot — into a plain concat.
 */
const templateCache = new Map<string, readonly Segment[]>();

function compileTemplate(text: string, inject: string): readonly Segment[] {
  const cacheKey = `${inject}\u0000${text}`;
  const cached = templateCache.get(cacheKey);
  if (cached) return cached;

  const pattern = injectPattern(inject);
  const segments: Segment[] = [];
  if (!pattern) {
    segments.push(text);
  } else {
    pattern.lastIndex = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) segments.push(text.slice(last, m.index));
      segments.push({ ...parseRef(m[1] ?? ''), orig: m[0] });
      last = m.index + m[0].length;
      if (m[0].length === 0) pattern.lastIndex += 1; // guard against zero-width matches
    }
    if (last < text.length) segments.push(text.slice(last));
  }
  templateCache.set(cacheKey, segments);
  return segments;
}

/**
 * Compile the `inject` pattern into a reusable regex, cached by the
 * pattern string (it never changes during a render), avoiding
 * per-data-node, per-iteration regex construction on the hot path.
 *
 * Parsing matches the 2022-2024 prototype: the greedy regex `(.+)%(.+)`
 * picks the rightmost `%` that still leaves a non-empty prefix and
 * suffix (handles exotic wrappers where `%` itself appears literally,
 * e.g. inject="%{%}%").
 *
 * A cached `null` means "no `%` slot" — a no-op. The cache distinguishes
 * "absent" (`undefined`) from "known no pattern" (`null`).
 */
const INJECT_PATTERN_CACHE = new Map<string, RegExp | null>();

function injectPattern(inject: string): RegExp | null {
  const cached = INJECT_PATTERN_CACHE.get(inject);
  if (cached !== undefined) return cached;

  const patternMatch = /(.+)%(.+)/.exec(inject);
  let compiled: RegExp | null;
  if (!patternMatch) {
    compiled = null;
  } else {
    const prefix = patternMatch[1] ?? '';
    const suffix = patternMatch[2] ?? '';
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    compiled = new RegExp(`${escape(prefix)}(.+?)${escape(suffix)}`, 'g');
  }
  INJECT_PATTERN_CACHE.set(inject, compiled);
  return compiled;
}
