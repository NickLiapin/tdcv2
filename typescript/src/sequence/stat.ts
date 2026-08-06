/**
 * `<gen type="stat">` — one number for the WHOLE run, on every row.
 *
 * `accumulate=` totals a list inside one record. `<gen type="running">` totals a
 * column as it goes, so row i knows about rows 1..i. This is the third and last
 * axis: a row that knows something about EVERY row, including the ones after it.
 *
 *     <sequence name="Price"><gen type="number" value="10..200"/></sequence>
 *     <sequence name="Average"><gen type="stat" of="Price" op="mean"/></sequence>
 *     <sequence name="Flag">
 *       <gen if="Price > Average" type="text" value="above average"/>
 *       <gen type="text" value="ordinary"/>
 *     </sequence>
 *
 * "Is this row above average" cannot be asked any other way: the average is not
 * knowable until the last row exists, and a conditional gen is evaluated while
 * the row is being built.
 *
 * ── What it costs, said out loud ──────────────────────────────────────────────
 *
 * A statistic over the whole run is the strongest form of the thing `running`
 * already is: it cannot be answered one row at a time, and unlike `running` it
 * cannot even be answered by the rows SO FAR. So the streaming builder refuses
 * it by name and the router hands the config to the in-memory engine — the same
 * road `running`, `uniq` on a composed value and every other whole-column
 * construct takes.
 *
 * ── Where the arithmetic comes from ───────────────────────────────────────────
 *
 * `sum`, `min` and `max` are the last value of the corresponding RUNNING column,
 * computed by {@link accumulateColumn}. That is not a shortcut — it is how the
 * two features are kept from drifting: the fixed-point scale rule, the treatment
 * of an empty cell and the "min returns the winning element's own spelling" rule
 * are written once and used twice. A column of `19.99`s totals to the same bytes
 * whether it is read row by row or all at once.
 *
 * `mean`, `median` and `stddev` are ratios and cannot be exact, so they are
 * computed in floating point over the numeric values — the same three formulas
 * the expression language's list functions use, including the POPULATION
 * standard deviation. `decimals=` rounds the answer; without it the full value
 * is printed, because a mean that quietly lost digits is worse than an ugly one.
 */

import { accumulateColumn } from './accumulate.js';
import * as TdcMath from '../math/tdc-math.js';
import { sequenceValueAt } from './types.js';
import type { Sequence, SequenceSpec } from './types.js';

/** What a statistic can be. */
export type StatOp = 'sum' | 'mean' | 'median' | 'min' | 'max' | 'count' | 'stddev';

export const STAT_OPS: readonly StatOp[] = [
  'sum',
  'mean',
  'median',
  'min',
  'max',
  'count',
  'stddev',
];

export class StatError extends Error {
  public override readonly name = 'StatError';
}

/** The column a statistic reads, or `''` when the generator did not say. */
export function statOf(spec: SequenceSpec): string {
  return (spec.gen?.attrs['of'] ?? '').trim();
}

/**
 * Read `op=` where an unknown op simply means "none".
 *
 * The engine path uses this one: by the time a value is drawn the validator has
 * already refused a misspelled op, so throwing here would turn a reported
 * problem into a crash.
 */
export function readStatOp(attrs: Record<string, string | undefined>): StatOp | undefined {
  const raw = (attrs['op'] ?? '').trim();
  return STAT_OPS.includes(raw as StatOp) ? (raw as StatOp) : undefined;
}

/** The same, but strict — the validator's copy, which turns a bad op into a diagnostic. */
export function parseStatOp(attrs: Record<string, string | undefined>): StatOp | undefined {
  const raw = (attrs['op'] ?? '').trim();
  if (raw === '') return undefined;
  if (!STAT_OPS.includes(raw as StatOp)) {
    throw new StatError(`op="${raw}" is not one of ${STAT_OPS.join(', ')}`);
  }
  return raw as StatOp;
}

/** `decimals=`, or undefined when the answer is printed at full precision. */
export function statDecimals(attrs: Record<string, string | undefined>): number | undefined {
  const raw = (attrs['decimals'] ?? '').trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new StatError(`decimals="${raw}" is not a whole number from 0 to 10`);
  }
  return n;
}

/**
 * The statistic itself, as the text that goes in every cell.
 *
 * A cell the parent filter emptied does not take part — the same rule
 * `accumulateColumn` follows, so a filtered column has one meaning across the
 * three features rather than three.
 */
export function statisticOf(
  values: readonly (string | undefined)[],
  op: StatOp,
  decimals: number | undefined,
): string {
  const present = values.filter((v): v is string => v !== undefined && v.trim() !== '');
  if (op === 'count') return String(present.length);
  if (present.length === 0) return '';

  if (op === 'sum' || op === 'min' || op === 'max') {
    // The last value of the running column IS the total over every row, and
    // reusing it is what keeps the exact-decimal arithmetic from drifting.
    const running = accumulateColumn(values, op, undefined, undefined);
    const last = [...running].reverse().find((v) => v !== undefined) ?? '';
    return decimals === undefined ? last : fixed(Number(last), decimals);
  }

  const numbers = present.map((v) => Number(v));
  const answer =
    op === 'mean' ? mean(numbers) : op === 'median' ? median(numbers) : stddev(numbers);
  return decimals === undefined ? String(answer) : fixed(answer, decimals);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.trunc(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[half] ?? Number.NaN;
  return ((sorted[half - 1] ?? Number.NaN) + (sorted[half] ?? Number.NaN)) / 2;
}

/** The POPULATION standard deviation — divided by n, matching `stddev()` in an expression. */
function stddev(values: readonly number[]): number {
  const average = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - average) * (v - average), 0) / values.length;
  return TdcMath.sqrt(variance);
}

/**
 * `decimals=` applied.
 *
 * Written out rather than delegated to `toFixed`, because the five
 * implementations round differently at a tie and a statistic that changes in the
 * last digit between languages is exactly what this project refuses to ship. The
 * rule is TDC's own: a half goes AWAY FROM ZERO.
 */
function fixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  const scale = Math.pow(10, decimals);
  const scaled = value * scale;
  const rounded = scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5);
  const negative = rounded < 0;
  const digits = Math.abs(rounded)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const sign = negative ? '-' : '';
  return decimals === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * Publish the statistic column.
 *
 * Reads `of=` out of the registry rather than drawing anything: a statistic
 * consumes no randomness at all, which is why adding one leaves every other
 * column exactly where it was.
 */
export function registerStat(
  spec: SequenceSpec,
  registry: Record<string, Sequence>,
  count: number,
): void {
  const source = registry[statOf(spec)];
  if (!source) return; // unknown column — the validator reports it

  const attrs = spec.gen?.attrs ?? {};
  const op = readStatOp(attrs);
  if (op === undefined) return; // no op — likewise

  let decimals: number | undefined;
  try {
    decimals = statDecimals(attrs);
  } catch {
    return; // a bad decimals= is a diagnostic, not a crash
  }

  const values = new Array<string | undefined>(count);
  for (let i = 0; i < count; i++) values[i] = sequenceValueAt(source, i);

  // ONE value, on every row. Not "the statistic so far" — that is `running`.
  const answer = statisticOf(values, op, decimals);
  registry[spec.name] = { name: spec.name, values: new Array<string>(count).fill(answer) };
}
