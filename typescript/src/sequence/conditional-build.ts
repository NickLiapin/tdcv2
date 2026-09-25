/**
 * Building an `if=` sequence in RAM (Engine 1).
 *
 * Split out of build.ts, which sits at the file-size limit, when the branches
 * learned to compute only the rows they win — the one rule this construct has
 * that nothing beside it in build.ts needs.
 */

import { evaluateIf } from '../expr/evaluate.js';

import { keepingOnly, isRowLocalDerived } from './branch-derived.js';
import { buildGenValues } from './build.js';
import type { SequenceBuildContext } from './context.js';
import { forStreamOf } from './per-row.js';
import type { CondBranch, Sequence, SequenceRegistry, SequenceSpec } from './types.js';

/**
 * Conditional sequence (in-memory / Engine 1): materialize each branch's gen
 * over all rows, then per row pick the FIRST branch whose `if` is truthy (or a
 * fallback branch with no `if`). None match → the row is empty. Conditions are
 * evaluated against the registry, which already holds earlier-declared
 * sequences (parent-before-child order).
 */
export function materializeConditional(
  spec: SequenceSpec,
  branches: readonly CondBranch[],
  registry: SequenceRegistry,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): { sequence: Sequence; flags: readonly { name: string; sequence: Sequence }[] } {
  // Each branch draws under its OWN stream — `Name#if0`, `Name#if1` — the ids
  // the streaming engine gives them in `buildConditionalSeq`. They used to share
  // the run's PRNG, which made a branch's values depend on how many draws the
  // columns before it had made: the same config and seed then produced different
  // data on the in-memory engine than on the streaming one.
  //
  // Which branch takes each row is decided by the conditions alone, so it is
  // settled BEFORE any branch is built: a formula or a date offset in a branch
  // then computes only the rows it won (see `keptRows`), while every other branch
  // is still built over the whole run, exactly where the streaming engine puts it.
  const winners = new Array<number>(count);
  const won: number[][] = branches.map(() => []);
  for (let i = 0; i < count; i++) {
    const k = branches.findIndex((b) => b.cond === undefined || evaluateIf(b.cond, registry, i));
    winners[i] = k;
    if (k >= 0) won[k]?.push(i);
  }
  const built = branches.map((b, k) => {
    const flagName = (b.gen.attrs['anomaly_flag'] ?? '').trim();
    const flags: string[] | undefined = flagName === '' ? undefined : [];
    const streamCtxOf = forStreamOf(ctx, `${spec.name}#if${String(k)}`);
    return {
      cond: b.cond,
      flagName,
      flags,
      values: buildGenValues(
        b.gen,
        count,
        prng,
        locale,
        now,
        isRowLocalDerived(b.gen) ? keepingOnly(streamCtxOf, won[k] ?? []) : streamCtxOf,
        flags,
      ),
    };
  });

  const values = new Array<string | undefined>(count);
  // One column per DISTINCT name: branches sharing `anomaly_flag="IsOutlier"`
  // share the column, which is the point of writing it on each branch.
  const flagCols = new Map<string, (string | undefined)[]>();
  for (const b of built) {
    if (b.flagName !== '' && !flagCols.has(b.flagName)) {
      flagCols.set(b.flagName, new Array<string | undefined>(count));
    }
  }

  for (let i = 0; i < count; i++) {
    const winner = built[winners[i] ?? -1];
    values[i] = winner?.values[i];
    // No branch matched: the row is not covered, so neither the value nor any
    // claim about it exists. Every flag column stays `undefined` here, masked
    // exactly like the value.
    if (!winner) continue;
    for (const [name, col] of flagCols) {
      // A covered row always has an answer. `false` — not empty — when the
      // branch that produced it cannot spike at all, because "no outlier" is
      // the truth about that row, and a detector scored against the column
      // needs it stated rather than left blank.
      col[i] = winner.flagName === name ? (winner.flags?.[i] ?? 'false') : 'false';
    }
  }

  return {
    sequence: { name: spec.name, values },
    flags: [...flagCols].map(([name, vals]) => ({ name, sequence: { name, values: vals } })),
  };
}
