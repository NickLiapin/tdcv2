/**
 * `<gen type="formula">` — a column computed from the other columns of its row.
 *
 * The engine already had a full expression language, with its own mathematics
 * agreeing bit for bit across five implementations. It could only ever answer a
 * yes/no question, though: `if=` and `filter=` consume the boolean and the value
 * behind it was thrown away. This generator keeps the value.
 *
 *     <gen type="formula" expr="0.75 * Height - 58 + Noise" decimals="1"/>
 *
 * That is the whole feature. Everything a formula can do — fractional
 * arithmetic, a division with a remainder you can print, a column correlated
 * with another one, a derived measure, a unit conversion — is the expression
 * language doing what it already did, now with somewhere to put the answer.
 *
 * ## It reads its OWN row, and that is the point
 *
 * Row i is computed from row i and nothing else, so a formula preserves the
 * property the streaming engines are built on: any row can be produced without
 * producing the rows before it. `running` (a cell of memory) and `stat` (the
 * whole run) are the two constructs that genuinely cannot, and they say so.
 *
 * That is not a theoretical nicety — it is why a formula RUNS on the streaming
 * engine, resolved lazily in `stream-build.ts` beside `<compute>`, which had
 * been reading siblings that way all along. Measured: 20,000,000 rows in 9.5 s
 * to a 291 MB file, peak memory 1.3× what a millionth of that used.
 *
 * ## Which layer to reach for
 *
 * `<compute>` stays the language of CHECK DIGITS — integer by design, because
 * mod-11 and Luhn need exactness that a double cannot promise. A formula is the
 * language of MATHEMATICS. The split is safe rather than merely advised,
 * because whole numbers stay whole in an expression: `1000000 * 1000000` is
 * exact here, and so is 10¹⁸ + 1. A formula only becomes approximate when the
 * config asked for something inexact.
 */

import { evaluateValueInScope } from '../expr/index.js';
import { sequenceValueAt } from './types.js';
import type { Sequence, SequenceSpec } from './types.js';

/** A value that reads as a number: the expression language's own idea of one. */
/** A cell that reads as a number. Shared with the distribution parameters. */
export const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** Raised when a formula cannot produce a value; surfaced as a run refusal. */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** The expression a formula evaluates, or `''` when the generator did not say. */
export function formulaExpr(spec: SequenceSpec): string {
  return (spec.gen?.attrs['expr'] ?? '').trim();
}

/** `decimals=`, or undefined when the answer is printed at full precision. */
export function formulaDecimals(attrs: Record<string, string>): number | undefined {
  const raw = (attrs['decimals'] ?? '').trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new FormulaError(`decimals="${raw}" is not a whole number from 0 to 10`);
  }
  return value;
}

/**
 * One evaluated answer, as the text that goes in the cell.
 *
 * The rendering rule is `stat`'s, deliberately and not by coincidence: without
 * `decimals=` the full value is printed, with it `toFixed` rounds. The same
 * question deserves the same answer in both places, and `stat`'s version is
 * already pinned across five implementations by shared fixtures.
 *
 * A whole number is printed from the bigint it still is. Going through a double
 * to print it would undo the exactness the expression language worked to keep.
 */
export function renderFormulaValue(
  value: unknown,
  decimals: number | undefined,
  read?: ColumnsRead,
): string {
  if (typeof value === 'bigint') {
    return decimals === undefined ? value.toString() : Number(value).toFixed(decimals);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // NaN is how "arithmetic on text" arrives here. In an `if=` it merely
      // makes every comparison false and the branch quietly does not fire; in a
      // column it would PRINT, and a file full of `NaN` that no one was warned
      // about is the defect this project keeps closing. Refuse instead.
      // Name the cause rather than guess at it. The scope records what the
      // expression actually read, so a text operand can be POINTED AT instead of
      // being offered as one of two possibilities — and when every operand was a
      // number, the maths is the cause and saying "a text column" would be a
      // diagnostic that lies.
      const text = read?.text;
      if (Number.isNaN(value)) {
        throw new FormulaError(
          text === undefined
            ? 'the expression has no number as its answer — 0/0, the square root of a ' +
                'negative, or another sum with no value'
            : `the expression is not a number: column "${text.name}" holds "${text.value}", ` +
                'which is text rather than a number',
        );
      }
      throw new FormulaError(
        `the expression is ${String(value)} — a division by zero, the logarithm of zero, ` +
          'or a value past the range a number can hold',
      );
    }
    return decimals === undefined ? String(value) : value.toFixed(decimals);
  }
  // Text. A formula is allowed to produce it — `expr="Age > 65 ? senior : adult"`
  // is a label, and labels are half of what a data-science config builds.
  //
  // Only a string reaches here: the expression language's own value model is
  // bigint | number | string | boolean, so anything else would be a bug in the
  // evaluator rather than a config to render.
  return typeof value === 'string' ? value : '';
}

/**
 * Publish the formula column.
 *
 * Reads the registry rather than drawing anything: a formula consumes no
 * randomness at all, which is why adding one leaves every other column exactly
 * where it was.
 *
 * Registered in DECLARATION ORDER, like `running`, `stat` and a date offset —
 * which is also why a name inside `expr=` has to belong to a sequence declared
 * above it. The validator says so; here the column is simply not there yet.
 */
export function registerFormula(
  spec: SequenceSpec,
  registry: Record<string, Sequence>,
  count: number,
): void {
  const expr = formulaExpr(spec);
  if (expr === '') return; // no expr= — the validator reports it

  const decimals = formulaDecimals(spec.gen?.attrs ?? {});
  const values = new Array<string | undefined>(count);
  for (let i = 0; i < count; i++) {
    const read: ColumnsRead = {};
    const answer = evaluateValueInScope(expr, rowScope(registry, i, read));
    // A column this row does not have is not a zero. `parent=` leaves a cell
    // empty on the rows its condition did not pick, and `Height * 2` on such a
    // row used to print 0 — a number nobody generated, sitting in a file that
    // looks complete. `running` and `stat` already skip an emptied cell; a
    // formula propagates the emptiness instead, which is the same rule seen
    // from the other side.
    values[i] = read.empty === true ? undefined : renderFormulaValue(answer, decimals, read);
  }

  registry[spec.name] = { name: spec.name, values };
}

/**
 * What one row's evaluation actually read — filled in by the scope as it goes.
 *
 * Two things are worth knowing after the fact and cannot be known before it:
 * whether a column this row does not have was touched, and whether a column
 * holding text was handed to arithmetic. Both turn a silent wrong answer into a
 * refusal that names its cause.
 */
export interface ColumnsRead {
  /** A referenced column was empty on this row. */
  empty?: boolean;
  /** The first non-numeric column value the expression read. */
  text?: { name: string; value: string };
}

/**
 * How a name inside `expr=` is resolved: this row's value of that column.
 *
 * `_count` is the 1-based row number, spelled the same way it is in `if=` — one
 * expression language, one set of built-ins, so a condition and a formula
 * cannot come to mean different things by the same words.
 */
export function rowScope(
  registry: Record<string, Sequence>,
  iteration: number,
  read?: ColumnsRead,
): (name: string) => string | undefined {
  return (name) => {
    if (name === '_count') return String(iteration + 1);
    const seq = registry[name];
    if (!seq) return undefined; // not a column: a bare word, as `if=` reads it
    const value = sequenceValueAt(seq, iteration) ?? '';
    if (read) {
      if (value === '') read.empty = true;
      else if (read.text === undefined && !NUMERIC.test(value)) read.text = { name, value };
    }
    return value;
  };
}

/**
 * The formula column as a LAZY sequence, for the streaming engine.
 *
 * The same evaluation as `registerFormula`, one row at a time. `rowScope` needs
 * no streaming variant: it reads through `sequenceValueAt`, which already calls
 * a lazy column's own `resolve(i)` instead of indexing an array it does not
 * have. One evaluator, one set of rules, two ways of getting the value.
 */
export function lazyFormula(spec: SequenceSpec, registry: Record<string, Sequence>): Sequence {
  const expr = formulaExpr(spec);
  const decimals = formulaDecimals(spec.gen?.attrs ?? {});
  return {
    name: spec.name,
    values: [],
    resolve: (i: number) => {
      if (expr === '') return undefined; // no expr= — the validator reports it
      const read: ColumnsRead = {};
      const answer = evaluateValueInScope(expr, rowScope(registry, i, read));
      return read.empty === true ? undefined : renderFormulaValue(answer, decimals, read);
    },
  };
}
