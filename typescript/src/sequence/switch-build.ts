/**
 * Building a `<switch>` column in RAM (Engine 1).
 *
 * Split out of build.ts, which had grown past the file-size limit, and this is
 * the piece that earned its own file: a switch is the only construct whose
 * branches each own a DIFFERENT SUBSET of the rows, so it carries rules nothing
 * else needs — which rows a branch draws over, in what order, and when it must
 * fall back to the whole run to keep the streaming engine's answer.
 */

import type { ExactLayout } from './per-row.js';
import { withRows } from './per-row.js';
import type { SequenceBuildContext } from './context.js';
import { computeParentMask, orderedRows } from './assemble.js';
import { buildCaseValues } from './mix-values.js';
import type { CaseSpec, Sequence, SequenceRegistry, SequenceSpec, SwitchSpec } from './types.js';
import { sequenceValueAt } from './types.js';

/**
 * Switch sequence (in-memory / Engine 1): build each entry's value-producer
 * over all rows, then per row look the subject sequence's value up in the
 * entries' keys — the FIRST entry whose keys contain it wins. No match → the
 * `<default>` value (if any), else empty. Like the conditional sequence, each
 * entry is built over the full row count; the subject just selects which
 * entry's value is used for the row.
 */
export function materializeSwitch(
  spec: SequenceSpec,
  switchSpec: SwitchSpec,
  registry: SequenceRegistry,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): Sequence {
  /*
   * Each branch is built over THE ROWS THAT CHOSE IT, not over the whole run.
   *
   * It used to be the whole run, as a concession to the streaming engine — one
   * branch column per entry keeps a lookup O(1) there. Applied to this engine it
   * was quietly wrong, and wrong in the worst way: a `<mix percent="20,80">`
   * inside `<case is="Male">` handed out its 20% over ALL the rows, and the ones
   * that landed on female rows were discarded. Measured before this change, on
   * 10 rows split 5/5: the branch produced exactly 2 specials every time — over
   * the wrong denominator — and 0, 1 or 2 of them survived. Every fourth run had
   * none at all, while the config plainly asked for one man in five.
   *
   * The denominator was never unknown. `registry[switchSpec.on]` below is the
   * subject's whole materialised column: the partition is available before a
   * single branch is built. `<mix>` and `parent=` have always done it this way —
   * see materializeMixSequence, which this now mirrors — and both are exact.
   */
  const subject = registry[switchSpec.on];
  const mask = computeParentMask(spec, registry, count);
  const applicable = orderedRows(spec, mask, ctx.layouts);

  // Partition first, build second. A row belongs to the FIRST entry whose keys
  // contain the subject's value — the same precedence the per-row loop had.
  const entryRows: number[][] = switchSpec.entries.map(() => []);
  const fallbackRows: number[] = [];
  for (const row of applicable) {
    const key = subject ? (sequenceValueAt(subject, row) ?? '') : '';
    const k = switchSpec.entries.findIndex((e) => e.keys.includes(key));
    if (k >= 0) entryRows[k]?.push(row);
    else fallbackRows.push(row);
  }

  const values = new Array<string | undefined>(count).fill(undefined);
  const place = (rows: readonly number[], produced: readonly string[]): void => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row !== undefined) values[row] = produced[i];
    }
  };

  // The whole run under a stream name — what a branch gets when its rows cannot
  // be numbered. Keeps `ctx.rows`, so a switch under a parent still resolves
  // against the right absolute rows.
  const named = (streamId: string): SequenceBuildContext => ({ ...ctx, streamId });

  switchSpec.entries.forEach((e, k) => {
    const rows = entryRows[k] ?? [];
    // A branch no row chose draws nothing at all — a quota over zero rows is not
    // a quota, and Hamilton must never be handed that denominator.
    if (rows.length === 0) return;
    const streamId = `${spec.name}#sw${String(k)}`;
    const ranked = rankedBranchRows(switchSpec.on, e.keys, rows, ctx.layouts);
    if (ranked) {
      place(
        ranked,
        buildCaseValues(e.value, ranked.length, prng, locale, now, withRows(ctx, streamId, ranked)),
      );
      return;
    }
    place(
      rows,
      unrankedBranchValues(e.value, rows, count, prng, locale, now, ctx, named(streamId)),
    );
  });

  if (switchSpec.fallback && fallbackRows.length > 0) {
    // <default> holds the rows no entry matched — a complement, which no layout
    // enumerates, so it is never rankable.
    const streamId = `${spec.name}#swdef`;
    place(
      fallbackRows,
      unrankedBranchValues(
        switchSpec.fallback,
        fallbackRows,
        count,
        prng,
        locale,
        now,
        ctx,
        named(streamId),
      ),
    );
  }
  return { name: spec.name, values };
}

/**
 * A branch whose rows the streaming engine cannot number — a multi-key entry or
 * `<default>` — and the values that belong on those rows, in `rows` order.
 *
 * Two behaviours, and which one applies is decided by the same fact the router
 * decides on:
 *
 * - **It declares a share.** The streaming engines refuse such a branch, so the
 *   router sends the whole config here and no other engine will ever produce
 *   this column. Free to be exact, then: the quota goes over the branch's OWN
 *   rows. Before this, a `<case is="US|CA|MX">` holding `percent="30,70"` got
 *   its 30% over all the rows and kept only the ones that landed on its own —
 *   measured on 200,000 rows: 44,999 of an exact 45,000, close enough to read
 *   as right and not be.
 * - **It declares no share.** Then the streaming engines DO build it, over the
 *   whole run, reading the row they want. This engine must do the same, or one
 *   seed would mean two datasets.
 */
function unrankedBranchValues(
  body: CaseSpec,
  rows: readonly number[],
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  wholeRunCtx: SequenceBuildContext,
): string[] {
  if (!caseCarriesPercent(body)) {
    const whole = buildCaseValues(body, count, prng, locale, now, wholeRunCtx);
    return rows.map((row) => whole[row] ?? '');
  }
  return buildCaseValues(
    body,
    rows.length,
    prng,
    locale,
    now,
    withRows(ctx, wholeRunCtx.streamId ?? '', rows),
  );
}

/** Does this `<case>` body declare a share that the denominator has to be right for? */
function caseCarriesPercent(body: CaseSpec | undefined): boolean {
  return (body?.parts ?? []).some(
    (part) =>
      (part.kind === 'mix' && (part.mixSpec.attrs['percent'] ?? '').trim() !== '') ||
      (part.kind === 'gen' && (part.gen.attrs['percent'] ?? '').trim() !== ''),
  );
}

/**
 * A switch branch's rows in the order the STREAMING engine numbers them, or
 * `undefined` when it cannot number them at all.
 *
 * A branch keyed `Male` of `<switch on="Gender">` is the same subset as
 * `parent="Gender.Male"`, and both engines must lay a quota over it the same
 * way. That order is NOT row order: it is the rank inside the subject's exact
 * layout, which is what `orderedRows` computes for a child and what
 * `childRankAt` hands the streaming engine. Ordering by row instead put the
 * right COUNT of values on the wrong rows, and the two engines disagreed on a
 * config neither of them refused.
 *
 * `undefined` for a multi-key entry (`US|CA|MX`): its rows are a union of
 * subsets, and ranks across a union do not compose from the per-value ranks.
 */
function rankedBranchRows(
  on: string,
  keys: readonly string[],
  rows: readonly number[],
  layouts: ReadonlyMap<string, ExactLayout> | undefined,
): number[] | undefined {
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  const plan = layouts?.get(on);
  if (key === undefined || !plan) return undefined;
  const vi = plan.values.indexOf(key);
  if (vi < 0) return undefined;
  const lo = (plan.cumHi[vi] ?? 0) - (plan.counts[vi] ?? 0);

  const ordered = new Array<number>(rows.length);
  for (const row of rows) {
    const slot = plan.slotByRow.get(row);
    if (slot === undefined) return undefined;
    const rank = slot - lo;
    if (rank < 0 || rank >= ordered.length) return undefined;
    ordered[rank] = row;
  }
  return ordered;
}
