/**
 * The compute-sequence variant of engine 1, on its own because it needs none of
 * the engine's machinery — no PRNG, no locale, no clock. That is the whole point
 * of `<compute>`: it is a pure function of columns that already exist, so it can
 * be read, tested and reasoned about without any of the draw apparatus around it.
 */

import { evaluateCompute } from '../compute/index.js';

import {
  type ComputeSpec,
  type Sequence,
  type SequenceRegistry,
  type SequenceSpec,
  sequenceValueAt,
} from './types.js';

/**
 * Materialize a compute sequence: evaluate the pure `<compute>` tree once per
 * row, resolving `<field name="X"/>` to `${{X}}`'s value at that row (any
 * sequence already in the registry). Consumes no PRNG state, so it never
 * perturbs the deterministic stream of sibling generators.
 */
export function materializeCompute(
  spec: SequenceSpec,
  compute: ComputeSpec,
  registry: SequenceRegistry,
  count: number,
): Sequence {
  const values = new Array<string | undefined>(count);
  for (let i = 0; i < count; i++) {
    values[i] = evaluateCompute(compute.node, (fieldName) => {
      const seq = registry[fieldName];
      return seq ? sequenceValueAt(seq, i) : undefined;
    });
  }
  return { name: spec.name, values };
}
