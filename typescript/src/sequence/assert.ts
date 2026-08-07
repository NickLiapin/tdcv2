/**
 * `<assert that="Rows == 700" says="…">` — a config that checks its own output.
 *
 * ── What is worth asserting ──────────────────────────────────────────────────
 *
 * Not what the config already states. You wrote `percent="70"` and you assert
 * 70% — you have tested that TDC can count.
 *
 * What the config does NOT state is where the value is. You write
 * `percent="70"`, a `parent=` filter removes rows, and the share of the rows
 * that survive is 41%. Nothing errors. That is the failure this project is built
 * around, and the one an assertion has to catch.
 *
 * ── Three existing mechanisms, no new language ───────────────────────────────
 *
 * `that=` is the `if=` expression language, unchanged. The numbers come from
 * `<gen type="stat">`, which already computes a whole-run answer in all five
 * implementations. `says=` is the sentence the reader gets — required, because an
 * assertion that fires with only its expression to show makes the reader work out
 * what it was for.
 *
 * ── The rule that keeps it honest ────────────────────────────────────────────
 *
 * Every name the expression reads must be WHOLE-RUN CONSTANT. Without that,
 * `that="Amount > 100"` reads row 0 and reports on one row out of a thousand — a
 * check that passed because it barely looked, wearing a badge that says
 * "verified". So a per-row column is refused by name.
 *
 * Which names an expression reads is discovered by handing the evaluator a scope
 * that records what it is asked for: no parser change, and the same trick works
 * in every port, because all five evaluate through a scope function.
 *
 * ── No flag ──────────────────────────────────────────────────────────────────
 *
 * An assertion runs because it is written. A flag that must be remembered means
 * the default is a check nobody ran, and a config that looks verified and is not
 * is worse than one with no check at all.
 *
 * It costs no new engine consequence either: an assertion reads `stat` columns,
 * and `stat` already routes the config to the in-memory engine, out loud.
 */

import { evaluateInScope } from '../expr/evaluate.js';
import { sequenceValueAt } from './types.js';
import type { Sequence, SequenceRegistry, SequenceSpec } from './types.js';

/** One `<assert>` as written. */
export interface AssertSpec {
  /** The `if=`-style expression that must hold. */
  readonly that: string;
  /** The sentence a reader gets when it does not. */
  readonly says: string;
}

/** A run whose output did not hold up its own config's claim. */
export class AssertionError extends Error {
  public override readonly name = 'AssertionError';
}

/**
 * Built-ins that are the same on every row, so an assertion may read them.
 *
 * `_count`, `_first` and `_last` are deliberately absent: they say something
 * about the row you happen to be on, which is exactly what an assertion must not
 * depend on.
 */
const WHOLE_RUN_BUILTINS: ReadonlySet<string> = new Set(['_total']);

/**
 * Constant from the SPEC alone, without reading a single row.
 *
 * Reading the column is the honest test and stays below, but it costs a pass
 * over the run — and on a streaming engine, where the counts get large, that
 * pass regenerates every value. Measured at two million rows: a third of a
 * second per name, which at a billion rows is minutes spent proving something
 * the spec already said.
 *
 * So the cheap proof runs first, and like the `uniq` capacity check it only ever
 * answers "definitely constant". Anything it cannot prove falls through to the
 * scan, so no config is refused that would have been accepted.
 */
function constantByConstruction(spec: SequenceSpec | undefined): boolean {
  const gen = spec?.gen;
  if (!gen) return false; // a compound, a mix, a switch — read it
  // A filtered column is empty on the rows the filter excluded, and `missing=`
  // and a conditional body both make a cell that may or may not be there. None
  // of those is settled by the spec.
  if (spec.parent !== undefined) return false;
  for (const attr of ['missing', 'anomaly', 'if', 'repeat']) {
    if (gen.attrs[attr] !== undefined) return false;
  }
  // One number for the whole run, by definition.
  if (gen.type === 'stat') return true;
  // A list of one is the same value on every row.
  if (gen.type === 'text') {
    const raw = gen.attrs['value'];
    return raw !== undefined && !raw.includes(',');
  }
  return false;
}

/** What reading the column found: one value throughout, several, or a gap. */
type Constancy = 'constant' | 'varies' | 'empty-on-some-rows';

/** Whether this column holds one and the same value on every row of the run. */
function wholeRunConstancy(
  name: string,
  seq: Sequence | undefined,
  spec: SequenceSpec | undefined,
  count: number,
): Constancy {
  if (WHOLE_RUN_BUILTINS.has(name)) return 'constant';
  if (!seq) return 'varies';
  if (constantByConstruction(spec)) return 'constant';
  // Read rather than trusted: a one-value `text` column is as constant as a
  // `stat` one, and a rule that named approved generator types would be about
  // the spelling rather than about the data. A column that varies gives itself
  // away at the first difference, so this is a full pass only for one that does
  // not — and then the pass is the proof.
  //
  // An EMPTY cell fails the rule as surely as a different one. A column that a
  // `parent=` filter leaves blank on half the run has no whole-run value at all;
  // it is a per-row column that happens to hold one distinct string, and reading
  // it as though it described the run is the same trap in a better disguise —
  // the expression would compare against whatever row 0 happened to hold.
  let seen: string | undefined;
  for (let i = 0; i < count; i++) {
    const value = sequenceValueAt(seq, i);
    // An unset cell and an empty one are the same thing to a reader of the
    // output, and the ports store a filtered row as the empty string rather than
    // as nothing. Treating them alike is what keeps the five in step.
    if (value === undefined || value === '') return 'empty-on-some-rows';
    if (seen === undefined) seen = value;
    else if (value !== seen) return 'varies';
  }
  return seen === undefined ? 'empty-on-some-rows' : 'constant';
}

/**
 * Check every assertion against the finished run.
 *
 * Throws on the first one that does not hold, with the author's sentence and the
 * value of every column the expression read — so the reader sees the 41% rather
 * than only the word "false".
 */
export function checkAssertions(
  asserts: readonly AssertSpec[],
  registry: SequenceRegistry,
  specs: readonly SequenceSpec[],
  count: number,
): void {
  const byName = new Map<string, SequenceSpec>();
  for (const spec of specs) byName.set(spec.name, spec);

  for (const spec of asserts) {
    const read = new Map<string, string | undefined>();
    const scope = (name: string): string | undefined => {
      const column = registry[name];
      // Only a real column is recorded. A name that is not declared is not data
      // at all — the expression language reads it as its own literal text, which
      // is what lets `Kind == a` go unquoted — so it has nothing to be constant
      // about, and the validator is the one that asks whether it was a typo.
      if (!column) return undefined;
      const value = sequenceValueAt(column, 0);
      read.set(name, value);
      return value;
    };

    let held: boolean;
    try {
      held = evaluateInScope(spec.that, scope);
    } catch (error) {
      throw new AssertionError(
        `assert: cannot read "${spec.that}" — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The honesty rule, applied to every name the expression touched. The
    // evaluator walks both sides of `&&` rather than short-circuiting — in all
    // five implementations, since they share this walk — so which names are
    // checked does not depend on the order the operands happen to be in.
    for (const name of read.keys()) {
      const constancy = wholeRunConstancy(name, registry[name], byName.get(name), count);
      if (constancy === 'constant') continue;
      const why =
        constancy === 'varies'
          ? `"${name}" is not the same on every row, so this would have checked the first row ` +
            'and called the run verified'
          : `"${name}" is empty on some rows, so the run has no single value for it — this ` +
            'would have checked whatever the first row happened to hold';
      throw new AssertionError(
        `assert ("${spec.that}"): ${why}. An assertion reads whole-run values: give it a ` +
          `<gen type="stat" of="${name}" op="…"/> column, or _total.`,
      );
    }

    if (!held) {
      throw new AssertionError(`assert failed: ${spec.says}\n  ${describe(spec.that, read)}`);
    }
  }
}

/** The expression, followed by what each name it read actually held. */
function describe(that: string, read: ReadonlyMap<string, string | undefined>): string {
  if (read.size === 0) return that;
  const parts = [...read].map(([name, value]) => `${name} = ${value ?? '(empty)'}`);
  return `${that}   with ${parts.join(', ')}`;
}
