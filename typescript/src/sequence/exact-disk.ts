/**
 * Engine 3 — exact-on-disk sequence registry.
 *
 * Engine 3's goal: everything Engine 1 does (EXACT percentages AND uniqueness,
 * including `percent` + `uniq` on the same columns), but for datasets larger
 * than RAM. Strategy:
 *
 *   1. Try the SEEKABLE builder (Engine 2's machinery) with exact-% uniq
 *      construction + external uniqueness verification. When it succeeds the
 *      whole run is O(1)-memory and byte-exact — the common, ample-slack case
 *      (unique records over a large combination space).
 *   2. If the seekable path can't do it — a feature it doesn't handle lazily
 *      (StreamUnsupportedError), or the exact-% construction leaves collisions
 *      on a tight config (ExactUniqRepairNeeded) — fall back to the in-memory
 *      exact engine (Engine 1). Correct always; bounded-memory for the common
 *      case. The bounded-memory repair for the tight case is stage 4.
 */

import { buildSequences, type SequenceBuildOptions } from './build.js';
import { ExactUniqRepairNeeded } from './exact-uniq.js';
import { buildLazyRegistry, StreamUnsupportedError } from './stream-build.js';
import type { SequenceRegistry, SequenceSpec } from './types.js';

export function buildExactDiskRegistry(
  specs: readonly SequenceSpec[],
  count: number,
  seed: string,
  prng: () => number,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
  envUniqGroups: readonly (readonly string[])[],
  envDistinctGroups: readonly (readonly string[])[],
): SequenceRegistry {
  try {
    // Seekable path with exact-% uniq (the last `true`). Bounded memory when it
    // works; throws to signal a fallback otherwise.
    return buildLazyRegistry(
      specs,
      count,
      seed,
      locale,
      now,
      options,
      { uniq: envUniqGroups, distinct: envDistinctGroups },
      true,
    );
  } catch (err) {
    if (err instanceof StreamUnsupportedError || err instanceof ExactUniqRepairNeeded) {
      return buildSequences(specs, count, prng, locale, now, {
        ...options,
        envUniqGroups,
        envDistinctGroups,
      });
    }
    throw err;
  }
}
