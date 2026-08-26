/**
 * Can this `<uniq>` group produce `count` distinct rows AT ALL — asked before a
 * single row is built.
 *
 * The group already had a capacity check, and its message is the right one:
 * "cannot produce 10000000 unique combinations — the values drawn for these
 * sequences allow at most 100 distinct rows". But it ran over the FINISHED
 * columns, so reaching it meant materialising them first. Two lists of ten
 * values and `count="1000000000"` therefore died in the allocator with a V8
 * heap dump, and `count="5000000000"` with `Invalid array length` — exactly
 * where the warning is worth most, because the alternative is an eight-hour run
 * that was never going to succeed.
 *
 * So the same question is asked here from the SPECS alone: how many distinct
 * values can each member possibly produce? A `text` list of ten names can make
 * ten; an integer range `1..100` can make a hundred. The product is a true upper
 * bound on the distinct tuples, and `count` above it is impossible whatever the
 * seed.
 *
 * ── Why it only ever answers "definitely impossible" ─────────────────────────
 *
 * A member whose capacity is not knowable from its spec — a pack draw, a regex,
 * a file this has not read — makes the group unbounded, and then this says
 * nothing at all and the existing post-build check does its work as before. A
 * refusal here is a proof, never a guess: no config that could have worked is
 * turned away.
 */

import { parseNumberRanges } from '../generators/number.js';
import type { SequenceSpec } from './types.js';
import { isScalarSpec } from './env-groups.js';
import { uniqGroupMessage } from './uniq.js';

/** The most distinct values this spec can produce, or `undefined` when unknowable. */
function staticCapacity(spec: SequenceSpec): number | undefined {
  const gen = spec.gen;
  if (!gen) return undefined; // a mix, a switch, a compound — not bounded here

  // `repeat=` makes the cell a LIST of draws, whose distinct combinations are a
  // different and larger count than one draw's. Not bounded here.
  if (gen.attrs['repeat'] !== undefined) return undefined;

  if (gen.type === 'text') {
    const raw = gen.attrs['value'];
    if (raw === undefined) return undefined;
    const items = new Set(raw.split(',').map((s) => s.trim()));
    return items.size;
  }

  if (gen.type === 'number') {
    // A decimal range holds far more than its integer span, and `distribution=`
    // draws a real number: neither is the count of whole numbers between the
    // bounds, so neither is bounded here.
    if (gen.attrs['decimals'] !== undefined || gen.attrs['distribution'] !== undefined) {
      return undefined;
    }
    const spec_ = (gen.attrs['value'] ?? gen.attrs['range'] ?? '').trim();
    if (spec_ === '') return undefined;
    try {
      let total = 0;
      for (const range of parseNumberRanges(spec_)) {
        total += range.max - range.min + 1;
        if (!Number.isFinite(total)) return undefined;
      }
      return total > 0 ? total : undefined;
    } catch {
      return undefined; // a range this cannot read is the validator's to report
    }
  }

  return undefined;
}

/**
 * Refuse a `<uniq>` group whose members cannot possibly cover `count` rows.
 *
 * Called before any column is materialised. Silent unless every member's
 * capacity is known and their product is short of `count`.
 */
export function checkEnvUniqCapacity(
  groups: readonly (readonly string[])[],
  specs: readonly SequenceSpec[],
  count: number,
): void {
  const byName = new Map<string, SequenceSpec>();
  for (const spec of specs) byName.set(spec.name, spec);

  for (const group of groups) {
    const members = group
      .map((name) => byName.get(name))
      .filter((spec): spec is SequenceSpec => spec !== undefined && isScalarSpec(spec));
    if (members.length < 2) continue;

    // A parent filter means fewer rows carry the tuple than `count`, so the
    // group is asked for less than the whole run — the exact number is not known
    // until the parent is built, and refusing on `count` here could turn away a
    // config that fits.
    if (members.some((spec) => spec.parent !== undefined)) continue;

    let ceiling = 1;
    for (const spec of members) {
      const capacity = staticCapacity(spec);
      if (capacity === undefined) {
        ceiling = Number.POSITIVE_INFINITY;
        break;
      }
      ceiling *= capacity;
      if (ceiling >= count) break; // already enough — no need to finish multiplying
    }

    if (count > ceiling) {
      throw new Error(uniqGroupMessage(group.join(' × '), count, ceiling));
    }
  }
}
