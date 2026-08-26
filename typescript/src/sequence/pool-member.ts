/**
 * Which MEMBER of a pool a reference hands each row.
 *
 * One place, because three engines and one repair all need the same answer. The
 * in-memory engine asks for every row up front, the streaming engines ask for
 * row 900,000 without the rows before it, and a config-level `<distinct>` asks
 * "who did the sequence before me take" — those are the same question, and
 * before this file they were two copies of it that a change could separate.
 *
 * The pick is a pure function of (seed, reference name, row) plus, when a
 * `filter=` narrows the candidates, the values other columns hold on that row.
 * Purity is what lets the streaming engines seek and what lets the repair below
 * replay a row without materialising a column.
 */

import { matchKey } from '../expr/match-key.js';
import { seekableInt } from '../prng/seekable.js';
import {
  bucketByField,
  eligibleMembers,
  noCandidateMessage,
  rowValuesDetail,
  parseEqualityFilter,
} from './pool-filter.js';
import { poolRefName, poolRefStream, type PoolTable, type PoolTables } from './pool.js';
import { sequenceValueAt } from './types.js';
import type { Sequence, SequenceSpec } from './types.js';

/**
 * A reference's pick, opened up.
 *
 * `candidates` is the set the row may draw from — every member, or the ones a
 * `filter=` leaves standing. `pick` is the one it actually takes. They are
 * separate because the repair needs the set: told that its member is taken, it
 * draws again from what remains rather than guessing and retrying.
 */
export interface MemberPicker {
  readonly table: PoolTable;
  /** The members row `i` may have, in ascending order. Throws when none pass. */
  candidates: (i: number) => readonly number[];
  /** The member row `i` takes, with no group repair applied. */
  pick: (i: number) => number;
}

/** Draw one of `candidates` for row `i`, on the reference's own stream. */
export function drawFrom(
  seed: string,
  refName: string,
  candidates: readonly number[],
  i: number,
  attempt = 0,
): number {
  // Attempt 0 is the reference's plain stream, so a config that never collides
  // produces exactly what it produced before this file existed. A repair draw
  // is a NEW stream named for the attempt, the same shape `<distinct>` uses for
  // scalars — appended, never woven into the run's own sequence.
  const stream =
    attempt === 0 ? poolRefStream(refName) : `${poolRefStream(refName)}#ed${String(attempt)}`;
  return candidates[seekableInt(seed, stream, i, candidates.length)] ?? -1;
}

export function memberPicker(
  spec: SequenceSpec,
  poolName: string,
  table: PoolTable,
  registry: Record<string, Sequence>,
  seed: string,
): MemberPicker {
  const filter = (spec.gen?.attrs['filter'] ?? '').trim();
  const all = Array.from({ length: table.count }, (_, m) => m);
  if (filter === '') {
    return { table, candidates: () => all, pick: (i) => drawFrom(seed, spec.name, all, i) };
  }

  // `field == Column` is bucketed once; a row then costs a map lookup instead of
  // a walk over every member. Everything else is a scan per row, which is honest
  // and linear — and the reason a pool has a size ceiling at all.
  const equality = parseEqualityFilter(filter, table, (n) => registry[n] !== undefined);
  const buckets = equality ? bucketByField(table, equality.field) : undefined;

  const candidates = (i: number): readonly number[] => {
    let eligible: readonly number[];
    let detail = '';
    if (equality && buckets) {
      const driver = registry[equality.column];
      const wanted = driver ? (sequenceValueAt(driver, i) ?? '') : '';
      eligible = buckets.get(matchKey(wanted)) ?? [];
      detail = ` (${equality.column}="${wanted}")`;
    } else {
      const read = new Map<string, string>();
      eligible = eligibleMembers(
        filter,
        table,
        (name) => {
          const seq = registry[name];
          return seq ? (sequenceValueAt(seq, i) ?? '') : undefined;
        },
        read,
      );
      detail = rowValuesDetail(read);
    }
    if (eligible.length === 0) throw new Error(noCandidateMessage(poolName, filter, i, detail));
    return eligible;
  };

  return { table, candidates, pick: (i) => drawFrom(seed, spec.name, candidates(i), i) };
}

/**
 * `<distinct>` around two or more references to the same pool.
 *
 * The group asks that no two of them hand ONE row the same member. A record has
 * no value of its own to compare — `${{Doctor}}` is not a string — so the
 * comparison is by identity: which member of the pool this row took.
 *
 * The repair happens at PICK time rather than on finished columns, and that is
 * what makes it work in all three engines from one place: the pick is a pure
 * function of the row, so the streaming engines replay a row's group without
 * materialising a column, exactly as they already replay a filter.
 *
 * A collision is not retried blindly. The candidate set is known, so the member
 * is drawn again from the candidates this row has NOT already given away —
 * uniform over what remains, deterministic, and it either succeeds or proves
 * there was nothing left to take.
 */
export function poolGroupPickers(
  groups: readonly (readonly string[])[],
  pickers: ReadonlyMap<string, MemberPicker>,
  seed: string,
): Map<string, (i: number) => number> {
  const repaired = new Map<string, (i: number) => number>();
  for (const group of groups) {
    const members = group.filter((name) => pickers.has(name));
    if (members.length < 2) continue;

    // One row's answers, computed together and kept until the next row is
    // asked for. Every member of the group needs the picks of the members
    // before it, so computing them one at a time would repeat the walk once
    // per member; the engines ask column by column, so the cache is asked for
    // the same row as many times as the group has members.
    let cachedRow = -1;
    let cached = new Map<string, number>();
    const rowPicks = (i: number): Map<string, number> => {
      if (i === cachedRow) return cached;
      const picks = new Map<string, number>();
      const taken: number[] = [];
      for (const name of members) {
        const picker = pickers.get(name);
        if (!picker) continue;
        const candidates = picker.candidates(i);
        let pick = drawFrom(seed, name, candidates, i);
        if (taken.includes(pick)) {
          const free = candidates.filter((m) => !taken.includes(m));
          if (free.length === 0) {
            throw new Error(
              `<distinct> across sequences: row ${String(i)} has no member left for "${name}" — ` +
                `the sequences in this group have taken every candidate the pool offers. ` +
                `A group of ${String(members.length)} references needs ${String(members.length)} ` +
                `members to choose from.`,
            );
          }
          pick = drawFrom(seed, name, free, i, 1);
        }
        picks.set(name, pick);
        taken.push(pick);
      }
      cachedRow = i;
      cached = picks;
      return picks;
    };

    for (const name of members) {
      repaired.set(name, (i) => rowPicks(i).get(name) ?? -1);
    }
  }
  return repaired;
}

/**
 * The repaired picks for every pool reference that a config-level `<distinct>`
 * has a say over — the one entry point the engines call.
 *
 * Empty when no group holds two references, which is every config that does not
 * ask for this. The engines then use each reference's plain pick and the run is
 * what it was.
 */
export function poolDistinctPicks(
  groups: readonly (readonly string[])[] | undefined,
  specs: readonly SequenceSpec[],
  registry: Record<string, Sequence>,
  pools: PoolTables | undefined,
  seed: string,
): Map<string, (i: number) => number> {
  if (!groups || groups.length === 0) return new Map();
  const pickers = new Map<string, MemberPicker>();
  for (const spec of specs) {
    const poolName = poolRefName(spec);
    if (poolName === undefined) continue;
    const table = pools?.[poolName];
    if (!table || table.count < 1) continue;
    pickers.set(spec.name, memberPicker(spec, poolName, table, registry, seed));
  }
  return poolGroupPickers(groups, pickers, seed);
}
