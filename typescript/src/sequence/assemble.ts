/**
 * Placing produced values back onto the full row range.
 *
 * A child sequence only generates values for the rows its `parent` selected, so
 * the builder works with a compacted array plus the list of rows those values
 * belong to. These three helpers are that bookkeeping: which rows apply, in
 * what ORDER the child builds them, and how the dense values go back over
 * `count` rows with the filtered ones left `undefined`. Extracted from build.ts
 * (the in-RAM bulk builder) so that file stays focused; pure, with no
 * dependency back on it.
 */

import type { ExactLayout } from './per-row.js';
import type { Sequence, SequenceRegistry, SequenceSpec } from './types.js';

/**
 * The rows a sequence builds, in the order it builds them.
 *
 * For an unparented column that is simply every row. For a child it is the
 * rows the parent selected, ordered by their RANK inside the parent's exact
 * layout — which is not their row order. The streaming engine hands a child
 * that rank as its position, so a `<mix>` under `parent="Gender.M"`, or a text
 * column under one, would otherwise arrange its own quota over a differently
 * ordered subset and land every value on the wrong row.
 *
 * Falls back to row order when the parent kept no layout — a bare
 * `parent="Name"` with no value, or a parent the streaming engine would refuse
 * as a parent anyway.
 */
export function orderedRows(
  spec: SequenceSpec,
  mask: readonly boolean[],
  layouts: ReadonlyMap<string, ExactLayout> | undefined,
): number[] {
  const applicable: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) applicable.push(i);

  const dot = spec.parent?.indexOf('.') ?? -1;
  if (spec.parent === undefined || dot < 0) return applicable;
  const plan = layouts?.get(spec.parent.slice(0, dot));
  if (!plan) return applicable;
  const vi = plan.values.indexOf(spec.parent.slice(dot + 1));
  if (vi < 0) return applicable;
  const lo = (plan.cumHi[vi] ?? 0) - (plan.counts[vi] ?? 0);

  const ordered = new Array<number>(applicable.length);
  for (const row of applicable) {
    const slot = plan.slotByRow.get(row);
    if (slot === undefined) return applicable;
    const rank = slot - lo;
    if (rank < 0 || rank >= ordered.length) return applicable;
    ordered[rank] = row;
  }
  return ordered;
}

/**
 * Spread `produced` over `count` rows, value i landing on row `rows[i]`. The
 * rows a sequence does not apply to stay `undefined`, which is what makes a
 * child render as empty rather than as a shifted neighbour's value.
 */
export function assembleAt(
  name: string,
  rows: readonly number[],
  produced: readonly string[],
  count: number,
): Sequence {
  const values: (string | undefined)[] = new Array<string | undefined>(count).fill(undefined);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined) values[row] = produced[i];
  }
  return { name, values };
}

/**
 * Which rows a sequence applies to. No `parent` → every row. `parent="Name"` →
 * rows where the parent produced anything. `parent="Name.value"` → rows where
 * the parent produced exactly that value.
 */
export function computeParentMask(
  spec: SequenceSpec,
  registry: SequenceRegistry,
  count: number,
): boolean[] {
  if (!spec.parent) {
    return new Array<boolean>(count).fill(true);
  }
  const dotIdx = spec.parent.indexOf('.');
  const parentName = dotIdx < 0 ? spec.parent : spec.parent.slice(0, dotIdx);
  const parentValue = dotIdx < 0 ? undefined : spec.parent.slice(dotIdx + 1);

  const parentSeq = registry[parentName];
  if (!parentSeq) {
    throw new Error(
      `sequence "${spec.name}" references unknown parent "${parentName}". ` +
        'Parent sequences must be declared before their children.',
    );
  }

  if (parentValue === undefined) {
    // Bare-name parent: apply to every row where the parent produced any value.
    return parentSeq.values.map((v) => v !== undefined);
  }
  return parentSeq.values.map((v) => v === parentValue);
}
