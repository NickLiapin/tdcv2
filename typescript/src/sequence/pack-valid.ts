/**
 * Reject-and-retry for a pack's `<valid>` guard.
 *
 * Some identifiers have combinations that were never issued — a region code that
 * does not exist, a date inside a national ID that never happened. A pack states
 * the rule as a predicate and the engine redraws the base until it passes.
 *
 * Its own file because it is a self-contained rule with two failure modes worth
 * explaining, and `build.ts` is large enough already.
 */

import { evaluateCompute, evaluateComputePredicate } from '../compute/index.js';
import type { OpenCloseElementContext } from '../generated/TDCParser.js';
import { buildGenValues, streamCtx, type SequenceBuildOptions } from './build.js';
import type { Sequence, SequenceSpec } from './types.js';
import { sequenceValueAt } from './types.js';

/** Fuse for reject-and-retry redraws before a generator is declared infeasible. */
const VALID_FUSE = 100;

/**
 * Reject-and-retry (migration spec §4.2). For each row whose `<valid>` predicate
 * is false, redraw the base sequences (simple `<gen>` producers) from the PRNG
 * and re-evaluate the compute sequences, up to `VALID_FUSE` attempts. Redraws
 * append to the PRNG stream, so the result stays deterministic. Overridden
 * (constant) sequences are never redrawn.
 */
export function enforceValid(
  validEl: OpenCloseElementContext,
  specs: readonly SequenceSpec[],
  registry: Record<string, Sequence>,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): void {
  const ctx = streamCtx(options);
  const holds = (i: number): boolean =>
    evaluateComputePredicate(validEl, (name) => {
      const seq = registry[name];
      return seq ? sequenceValueAt(seq, i) : undefined;
    });

  // What a redraw could actually change. A caller parameter REPLACES a local
  // sequence with a constant, and the loop below skips overrides — so pinning
  // every base the guard reads leaves it nothing to re-roll. The predicate's
  // answer was fixed before the first attempt: either it passes and no redraw is
  // wanted, or it never will and a hundred of them are a hundred no-ops per row,
  // ending in an error that named neither the parameter nor the value.
  const pinned = specs
    .filter((s) => !s.compute && options.overrides?.[s.name] !== undefined)
    .map((s) => s.name);
  const redrawable = specs.some((s) => !s.compute && options.overrides?.[s.name] === undefined);

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    if (!redrawable && !holds(i)) {
      const named = pinned.map((n) => `${n}="${options.overrides?.[n] ?? ''}"`).join(', ');
      throw new Error(
        `pack generator <valid> rejects the value built from ${named || 'the pinned parameters'}` +
          ', and every sequence the guard reads is pinned, so there is nothing left to redraw. ' +
          'Pass a value the pack accepts, or drop the parameter and let the pack draw its own.',
      );
    }
    while (!holds(i)) {
      if (attempts >= VALID_FUSE) {
        throw new Error(
          `pack generator <valid> constraint could not be satisfied for row ${String(i)} after ` +
            `${String(VALID_FUSE)} attempts — the base cannot produce a valid value`,
        );
      }
      attempts += 1;
      // Redraw base sequences (skip overrides and compute — recomputed below).
      for (const spec of specs) {
        if (options.overrides?.[spec.name] !== undefined || spec.compute) continue;
        if (!spec.gen) {
          throw new Error(
            `pack generator <valid> requires simple <gen> base sequences; ` +
              `sequence "${spec.name}" is not supported`,
          );
        }
        const seq = registry[spec.name];
        if (seq)
          (seq.values as (string | undefined)[])[i] = buildGenValues(
            spec.gen,
            1,
            prng,
            locale,
            now,
            ctx,
          )[0];
      }
      // Recompute derived sequences for this row, in declaration order.
      for (const spec of specs) {
        if (!spec.compute) continue;
        const seq = registry[spec.name];
        if (seq) {
          (seq.values as (string | undefined)[])[i] = evaluateCompute(spec.compute.node, (name) => {
            const s = registry[name];
            return s ? sequenceValueAt(s, i) : undefined;
          });
        }
      }
    }
  }
}
