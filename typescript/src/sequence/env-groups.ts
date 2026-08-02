/**
 * Config-level `<uniq>` groups: making a TUPLE unique across rows.
 *
 * Split out of `build.ts` when that file hit its line ceiling, and because the
 * rule below deserves a place to be explained rather than a comment squeezed
 * between two loops.
 *
 * A group does not redraw anything. It REARRANGES whole columns between rows,
 * so every column keeps its multiset and every declared percentage stays
 * exactly what it was. That is what decides who may join a group:
 *
 *   - a plain `<sequence>` may — its value is bound to nothing in its row;
 *   - a `<mix>` may — the multiset is preserved, so the shares survive;
 *   - a `<switch>` may ONLY MOVE BETWEEN ROWS WITH THE SAME SUBJECT — its value
 *     answers the subject of its own row, and a free swap would put a male name
 *     in a female row;
 *   - a `<compute>` may not, and never joins: it is a function of other columns
 *     in the same row (TDC218);
 *   - a compound may not: it owns a field per gen, not one column (TDC129).
 */

import { seekableGen } from '../prng/seekable.js';

import { buildGenValues } from './build.js';
import type { SequenceBuildContext } from './context.js';
import { buildMixValues } from './mix-values.js';
import { redrawCtx } from './per-row.js';
import { arrangeUnique, uniqUpperBound, valueCounts } from './uniq.js';
import type { Sequence, SequenceSpec } from './types.js';

/** Maximum redraws for one field of a `<distinct>` group before giving up. */
const DISTINCT_FUSE = 1000;

/** The message a refusal carries: what was asked for, and what the data allows. */
export function uniqGroupMessage(name: string, requested: number, achievable: number): string {
  return (
    `uniq: group "${name}" cannot produce ${String(requested)} unique combinations — ` +
    `the values drawn for these sequences allow at most ${String(achievable)} distinct ` +
    'rows. Add more values to a member (more distinct names, wider ranges…) or lower the count.'
  );
}

/** A sequence yields a single value per row (not a compound of fields). */
export function isScalarSpec(spec: SequenceSpec): boolean {
  return spec.gen !== undefined || spec.mixSpec !== undefined || spec.switchSpec !== undefined;
}

/**
 * The subjects the group's `<switch>` members are keyed by, in declaration
 * order and without repeats. Empty when no member is a switch, which is the
 * ordinary case and leaves the behaviour exactly as it was.
 */
function subjectsOf(members: readonly string[], specByName: Map<string, SequenceSpec>): string[] {
  const subjects: string[] = [];
  for (const name of members) {
    const on = specByName.get(name)?.switchSpec?.on;
    if (on !== undefined && !subjects.includes(on)) subjects.push(on);
  }
  return subjects;
}

/**
 * Split the rows into blocks that may be shuffled among themselves.
 *
 * With no switch member there is one block holding every row — the old
 * behaviour, bit for bit. With one, rows are grouped by the value of its
 * subject, so male rows only ever trade with male rows. JSON is the key rather
 * than a joined string because a drawn value may contain any separator anyone
 * could pick.
 */
function partitionRows(
  rows: readonly number[],
  subjects: readonly string[],
  registry: Record<string, Sequence>,
): number[][] {
  if (subjects.length === 0) return [[...rows]];
  const blocks = new Map<string, number[]>();
  for (const row of rows) {
    const key = JSON.stringify(subjects.map((s) => registry[s]?.values[row] ?? ''));
    const block = blocks.get(key);
    if (block) block.push(row);
    else blocks.set(key, [row]);
  }
  return [...blocks.values()];
}

/**
 * Enforce config-level `<uniq>` groups. Each group names scalar sequences whose
 * combined tuple must be unique across all rows. Over the rows where every
 * member is defined, rearrange the columns jointly so tuples are distinct;
 * refuse before any output if the data cannot supply that many combinations.
 */
export function enforceEnvUniq(
  groups: readonly (readonly string[])[],
  specs: readonly SequenceSpec[],
  registry: Record<string, Sequence>,
  count: number,
): void {
  const specByName = new Map<string, SequenceSpec>();
  for (const spec of specs) specByName.set(spec.name, spec);

  for (const group of groups) {
    const members = group.filter((name) => {
      const spec = specByName.get(name);
      return spec !== undefined && isScalarSpec(spec) && registry[name] !== undefined;
    });
    if (members.length < 2) continue;

    // Rows where every member produced a value (parent-defined for all).
    const rows: number[] = [];
    for (let i = 0; i < count; i++) {
      if (members.every((name) => registry[name]?.values[i] !== undefined)) rows.push(i);
    }
    if (rows.length === 0) continue;

    const label = members.join(' × ');
    const arrangedByRow = new Map<number, string[]>();

    for (const block of partitionRows(rows, subjectsOf(members, specByName), registry)) {
      const columns = members.map((name) => block.map((i) => registry[name]?.values[i] ?? ''));
      const upper = uniqUpperBound(columns.map(valueCounts));
      if (block.length > upper) {
        throw new Error(uniqGroupMessage(label, rows.length, upper));
      }
      const { columns: arranged, distinct } = arrangeUnique(columns);
      if (distinct < block.length) {
        throw new Error(uniqGroupMessage(label, rows.length, distinct));
      }
      block.forEach((row, k) => {
        arrangedByRow.set(
          row,
          members.map((_, m) => arranged[m]?.[k] ?? ''),
        );
      });
    }

    // Blocks are made unique on their own; two of them could still meet on the
    // same tuple when the subjects share a value (a name in both lists). Rare,
    // but silence here would be a broken promise, so it is counted and refused.
    const seen = new Set<string>();
    for (const row of rows) seen.add(JSON.stringify(arrangedByRow.get(row) ?? []));
    if (seen.size < rows.length) {
      throw new Error(uniqGroupMessage(label, rows.length, seen.size));
    }

    members.forEach((name, m) => {
      const values = [...(registry[name]?.values ?? [])];
      for (const row of rows) values[row] = arrangedByRow.get(row)?.[m] ?? '';
      registry[name] = { name, values };
    });
  }
}

/**
 * Enforce config-level `<distinct>` groups. Each group names scalar
 * sequences whose values must differ from each other within one row. For
 * each group and applicable row, walk the group's sequences in declaration
 * order; a value that collides with an already-accepted one is redrawn
 * (one fresh scalar from that sequence's own gen/switch, on a stream named
 * for the sequence and the attempt — the same one the streaming engine uses)
 * until it differs. Rows where a sequence produced `undefined` (filtered
 * out by a parent) are skipped for that sequence.
 *
 * Only scalar sequences (simple `<gen>` or `<mix>`) participate;
 * compound sequences have no single value and are excluded (the validator
 * rejects them in a group). Deterministic and fuse-bounded like the
 * field-level repair (see enforceDistinct).
 */
export function enforceEnvDistinct(
  groups: readonly (readonly string[])[],
  specs: readonly SequenceSpec[],
  registry: Record<string, Sequence>,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): void {
  const specByName = new Map<string, SequenceSpec>();
  for (const spec of specs) specByName.set(spec.name, spec);
  const keyed = ctx.seed === undefined ? undefined : { seed: ctx.seed };
  const redraw = redrawCtx(ctx);

  for (const group of groups) {
    const members = group.filter((name) => {
      const spec = specByName.get(name);
      return spec !== undefined && isScalarSpec(spec) && registry[name] !== undefined;
    });
    if (members.length < 2) continue;

    // Mutable working copies of each member's values.
    const arrays = new Map<string, (string | undefined)[]>();
    for (const name of members) arrays.set(name, [...(registry[name]?.values ?? [])]);

    for (let i = 0; i < count; i++) {
      const seen = new Set<string>();
      for (const name of members) {
        const values = arrays.get(name);
        if (!values) continue;
        let value = values[i];
        if (value === undefined) continue; // filtered-out row for this sequence
        let attempts = 0;
        while (seen.has(value)) {
          if (attempts >= DISTINCT_FUSE) {
            throw new Error(
              `<distinct> across sequences: could not find a value for sequence ` +
                `"${name}" different from the others after ${String(DISTINCT_FUSE)} attempts — ` +
                'its source likely has too few distinct values.',
            );
          }
          attempts += 1;
          const memberSpec = specByName.get(name);
          const draw = keyed ? seekableGen(keyed.seed, `${name}#ed${String(attempts)}`, i) : prng;
          value = memberSpec
            ? produceOneScalar(memberSpec, draw, locale, now, keyed ? redraw : ctx)
            : value;
        }
        values[i] = value;
        seen.add(value);
      }
    }

    for (const name of members) {
      registry[name] = { name, values: arrays.get(name) ?? [] };
    }
  }
}

/** Draw one fresh scalar value from a simple or switch sequence spec. */
function produceOneScalar(
  spec: SequenceSpec,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): string {
  if (spec.gen) return buildGenValues(spec.gen, 1, prng, locale, now, ctx)[0] ?? '';
  if (spec.mixSpec) return buildMixValues(spec.mixSpec, 1, prng, locale, now, ctx)[0] ?? '';
  return '';
}
