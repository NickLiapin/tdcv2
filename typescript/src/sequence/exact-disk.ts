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
 *
 *      That fallback is for a config that asked for a COST — `mode="disk"`. A
 *      caller that NAMED engine 3 gets a refusal instead: see `named` below.
 */

import { buildSequences, type SequenceBuildOptions } from './build.js';
import { ExactUniqRepairNeeded, IN_MEMORY_FALLBACK_MAX_ROWS } from './exact-uniq.js';
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
  /**
   * Whether the caller NAMED this engine rather than describing a constraint.
   *
   * The rule is not new — the streaming side has followed it all along, and says
   * why: `engine="2"` and `mode="stream"` say WHICH engine to use, so a refusal
   * is the answer, because quietly running somewhere else hides exactly what the
   * author asked to be told. `mode="disk"` says what the run may COST, so
   * falling back to a slower engine still honours it.
   *
   * Engine 3 was never wired to that rule, and the gap was not theoretical: a
   * tight `<uniq>` under `--engine 3` produced BYTE-IDENTICAL output to
   * `--engine 1` while the same config inside the repair cap produced different
   * bytes on the two engines. Anyone measuring engine 3 on a tight config was
   * measuring engine 1, silently. It happened three times in one day to the
   * person who wrote the fallback.
   */
  named = false,
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
      /*
       * The fallback is only a fallback while the in-memory engine can hold
       * the table. Past that, falling back does not fail fast — it fails
       * after half an hour of materialising, out of memory, with nothing
       * written; measured on a 194-million-row run. A refusal that names the
       * problem is the honest outcome.
       */
      if (count > IN_MEMORY_FALLBACK_MAX_ROWS) {
        throw new Error(
          `${err.message.replace(/ — .*$/, '')} — and at ${String(count)} rows the ` +
            `in-memory engine cannot take over. Widen the uniq columns' values ` +
            `(more distinct names, wider ranges…) or lower the count.`,
        );
      }
      // Only the REPAIR CAP, not a feature the lazy path cannot express.
      //
      // The two look alike here and are not. A shape engine 2 refuses outright —
      // a weighted pack generator, say — means engine 3 never got to run the
      // config at all, and covering that is what engine 3 IS: "everything the
      // in-memory engine does, for runs that do not fit in memory". Refusing
      // there would make `--engine 3` unusable for ordinary configs, and every
      // implementation has tests saying so.
      //
      // The cap is the other case: engine 3 DID run this config, got most of the
      // way, and gave up on a memory budget — the very property the caller named
      // this engine to get. That is the substitution worth refusing.
      if (named && err instanceof ExactUniqRepairNeeded) {
        throw new Error(
          `${err.message.replace(/ — .*$/, '')} — and engine 3 was asked for by name, ` +
            `so it refuses rather than quietly running another engine. Remove the engine ` +
            `choice to let a uniq this tight go to the in-memory engine, which is what has ` +
            `been happening here all along.`,
        );
      }
      return buildSequences(specs, count, prng, locale, now, {
        ...options,
        envUniqGroups,
        envDistinctGroups,
      });
    }
    throw err;
  }
}
