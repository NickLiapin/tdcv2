/**
 * Columns computed from OTHER columns, resolved in declaration order.
 *
 * Four constructs share one rule and were four near-identical branches in the
 * main build loop until it hit the repo's ceiling on file length. They are
 * gathered here because they are genuinely one idea: a column that draws
 * nothing of its own and reads sequences that already exist. That is also why
 * each one's source must be declared ABOVE it — at this point in the loop a
 * later column simply is not in the registry yet, and the validator says so
 * with TDC240 rather than letting the run find out.
 *
 * They differ in how much of the run they need, and the difference is the whole
 * cost model:
 *
 *   `running`   every row BEFORE this one   — a cell of memory
 *   `stat`      every row, including after  — the whole run
 *   `formula`   this row only               — free
 *   date offset this row only               — free
 *
 * The bottom two preserve the property the streaming engines are built on: a
 * row can be produced without producing the rows before it. The top two cannot,
 * and say so by name so the router hands the config to the in-memory engine.
 */

import { registerDateOffset, isDateOffset } from './date-offset.js';
import { registerFormula } from './formula.js';
import { registerRunning } from './running.js';
import { registerStat } from './stat.js';
import type { Sequence, SequenceSpec } from './types.js';

/**
 * Publish `spec` if it is one of the four, and say whether it was.
 *
 * `true` means the caller should move on to the next spec — the column is
 * already in the registry.
 */
export function registerDerivedColumn(
  spec: SequenceSpec,
  registry: Record<string, Sequence>,
  count: number,
  prng: () => number,
  locale: string,
  instantColumns: ReadonlySet<string> | undefined,
): boolean {
  switch (spec.gen?.type) {
    case 'running':
      registerRunning(spec, registry, count);
      return true;
    case 'stat':
      registerStat(spec, registry, count);
      return true;
    case 'formula':
      registerFormula(spec, registry, count);
      return true;
    default:
      break;
  }
  if (isDateOffset(spec)) {
    registerDateOffset(spec, registry, count, prng, locale, instantColumns);
    return true;
  }
  return false;
}
