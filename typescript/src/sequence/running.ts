/**
 * `<gen type="running">` — a total that carries down a COLUMN.
 *
 * `accumulate=` on a `repeat` list keeps a total inside one record. This is the
 * other axis: row i's value is the accumulation of every row up to it. An
 * account balance, a meter reading, a cumulative count.
 *
 * The two share their arithmetic on purpose — see `accumulateColumn` — so the
 * scale rule, the handling of an empty cell and the exactness of a decimal sum
 * cannot drift apart between them.
 *
 * This is the one construct in TDC that is genuinely NOT computable from a row
 * index alone: row 900,000,000 is the sum of everything before it. That is not
 * an oversight in the streaming engines, it is what "running" means. So the
 * streaming builder refuses it by name and the router sends the config to the
 * in-memory engine, exactly as it does for every other whole-column construct.
 */

import { accumulateColumn, readAccumulate } from './accumulate.js';
import { sequenceValueAt } from './types.js';
import type { Sequence, SequenceSpec } from './types.js';

/** The column a running total reads, or `''` when the generator did not say. */
export function runningOf(spec: SequenceSpec): string {
  return (spec.gen?.attrs['of'] ?? '').trim();
}

/** The column whose change restarts the total, or undefined for one total per run. */
export function runningReset(spec: SequenceSpec): string | undefined {
  const raw = (spec.gen?.attrs['reset'] ?? '').trim();
  return raw === '' ? undefined : raw;
}

/**
 * Publish the running column.
 *
 * Reads `of=` out of the registry rather than drawing anything: a running total
 * consumes no randomness at all, which is why adding one leaves every other
 * column exactly where it was.
 */
export function registerRunning(
  spec: SequenceSpec,
  registry: Record<string, Sequence>,
  count: number,
): void {
  const source = registry[runningOf(spec)];
  if (!source) return; // unknown column — the validator reports it

  const op = readAccumulate(spec.gen?.attrs ?? {});
  if (op === undefined) return; // no op — likewise

  const values = new Array<string | undefined>(count);
  for (let i = 0; i < count; i++) values[i] = sequenceValueAt(source, i);

  const resetName = runningReset(spec);
  const resetSeq = resetName === undefined ? undefined : registry[resetName];
  const resetValues =
    resetSeq === undefined
      ? undefined
      : Array.from({ length: count }, (_, i) => sequenceValueAt(resetSeq, i));

  const base = (spec.gen?.attrs['base'] ?? '').trim();
  registry[spec.name] = {
    name: spec.name,
    values: accumulateColumn(values, op, base === '' ? undefined : base, resetValues),
  };
}
