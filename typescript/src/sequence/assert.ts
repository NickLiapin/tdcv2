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
import type { Sequence, SequenceRegistry } from './types.js';

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

/** True when this column holds the same value on every row it applies to. */
function isWholeRunConstant(name: string, seq: Sequence | undefined, count: number): boolean {
  if (WHOLE_RUN_BUILTINS.has(name)) return true;
  if (!seq) return false;
  // Read rather than trusted: a `stat` column is constant by construction, but so
  // is a one-value `text` column, and refusing that would be a rule about the
  // spelling rather than about the data. Cheap — these columns are already built.
  let seen: string | undefined;
  for (let i = 0; i < count; i++) {
    const value = sequenceValueAt(seq, i);
    if (value === undefined) continue; // a filtered row says nothing either way
    if (seen === undefined) seen = value;
    else if (value !== seen) return false;
  }
  return seen !== undefined;
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
  count: number,
): void {
  for (const spec of asserts) {
    const read = new Map<string, string | undefined>();
    const scope = (name: string): string | undefined => {
      const value = registry[name] ? sequenceValueAt(registry[name], 0) : undefined;
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
      if (!isWholeRunConstant(name, registry[name], count)) {
        throw new AssertionError(
          `assert ("${spec.that}"): "${name}" is not the same on every row, so this would ` +
            'have checked the first row and called the run verified. An assertion reads ' +
            'whole-run values: give it a <gen type="stat" of="' +
            name +
            '" op="…"/> column, or _total.',
        );
      }
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
