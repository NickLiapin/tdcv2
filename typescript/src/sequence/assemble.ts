/**
 * Placing produced values back onto the full row range.
 *
 * A child sequence only generates values for the rows its `parent` selected, so
 * the builder works with a compacted array plus a boolean mask saying which
 * rows it belongs to. These two helpers are that bookkeeping: build the mask,
 * then spread the dense values back over `count` rows leaving the filtered rows
 * `undefined`. Extracted from build.ts (the in-RAM bulk builder) so that file
 * stays focused; pure, with no dependency back on it.
 */

import type { Sequence, SequenceRegistry, SequenceSpec } from './types.js';

/**
 * Spread `produced` (dense, one per applicable row) over `count` rows according
 * to `mask`. Rows the parent filtered out stay `undefined`, which is what makes
 * a child sequence render as empty rather than as a shifted neighbour's value.
 */
export function assembleValues(
  name: string,
  mask: readonly boolean[],
  produced: readonly string[],
  count: number,
): Sequence {
  const values: (string | undefined)[] = new Array<string | undefined>(count);
  let next = 0;
  for (let i = 0; i < count; i++) {
    if (mask[i]) {
      values[i] = produced[next];
      next += 1;
    } else {
      values[i] = undefined;
    }
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
