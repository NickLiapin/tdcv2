/**
 * Env-level `<uniq>` for Engine 2 — uniqueness without holding the run.
 *
 * Split out from `stream-build.ts` because it answers one question and answers
 * it in one place: given members that already resolve per row, make their
 * tuples distinct while every column keeps the multiset it drew.
 */

import { repairExactUniq } from './exact-uniq.js';
import { sequenceValueAt } from './index.js';
import type { Sequence, SequenceSpec } from './index.js';

/**
 * Enforce an env-level `<uniq>` group without holding the run.
 *
 * The in-memory engine draws the whole table, finds the repeated tuples and
 * swaps values until none is left. That is exact and it does not scale: the
 * repeats grow as the SQUARE of the row count, so a 4,000,000-row run spent
 * three and a half hours without writing a byte.
 *
 * Here the columns stay seekable — each is already a function of the row
 * number — and only the repeats are touched. `repairExactUniq` streams every
 * tuple through an external sort to find them, which is bounded memory and
 * O(N log N) on disk, then rearranges the few offenders in RAM. Its own
 * refusal (`ExactUniqRepairNeeded`) hands a pathologically tight config back to
 * the in-memory engine, so nothing is lost when the space really is too small.
 *
 * A `<switch>` member draws from a different list per subject value, so the
 * rearrangement is told which rows may trade with which — otherwise it would
 * put a female first name on a male row and call the tuple unique.
 *
 * **This changes the arrangement.** A repaired dataset is not the one the
 * in-memory engine produced from the same seed. Both are correct — every tuple
 * distinct, every column's multiset untouched, so the percentages hold — but
 * they are different arrangements, and a config that used a uniq group before
 * this change produces different data after it.
 */
export function applyEnvUniq(
  group: readonly string[],
  specByName: Map<string, SequenceSpec>,
  registry: Record<string, Sequence>,
  count: number,
): void {
  const members = group.filter((name) => registry[name] !== undefined);
  if (members.length < 2) return;

  const resolvers = members.map((name) => {
    const original = registry[name];
    return {
      id: name,
      resolve: (i: number): string => (original ? (sequenceValueAt(original, i) ?? '') : ''),
    };
  });

  // The columns a switch member is keyed by. Empty for an ordinary group, and
  // then every row may trade with every other, as it always could.
  const subjects: string[] = [];
  for (const name of members) {
    const on = specByName.get(name)?.switchSpec?.on;
    if (on !== undefined && !subjects.includes(on) && registry[on] !== undefined) subjects.push(on);
  }
  const blockOf =
    subjects.length === 0
      ? undefined
      : (() => {
          const columns = subjects.map((name) => registry[name]);
          return (row: number): string =>
            JSON.stringify(columns.map((seq) => (seq ? (sequenceValueAt(seq, row) ?? '') : '')));
        })();

  const repaired = repairExactUniq(resolvers, count, `"${members.join(' × ')}"`, {}, blockOf);
  for (const name of members) {
    const seq = repaired[name];
    if (seq) registry[name] = seq;
  }
}
