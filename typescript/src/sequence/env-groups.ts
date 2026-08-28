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
import { buildCaseValues, buildMixValues } from './mix-values.js';
import { redrawCtx } from './per-row.js';
import { arrangeUnique, uniqGroupMessage, uniqUpperBound, valueCounts } from './uniq.js';
import { type Sequence, type SequenceSpec, type SwitchSpec, sequenceValueAt } from './types.js';

/** Maximum redraws for one field of a `<distinct>` group before giving up. */
const DISTINCT_FUSE = 1000;

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
 * Spread one member's values across the blocks before anything is arranged
 * inside them.
 *
 * A `text` list is laid out in exact shares over the WHOLE column, and then a
 * `<switch>` cuts the rows into blocks — so a block gets whichever values
 * happened to fall there, not a fair share of them. Measured on a group of four
 * over 29 rows: the male block came out `[7,3,4]` and `[6,5,3]` where an even
 * deal is `[5,5,4]` and `[5,5,4]`, and that difference is the difference
 * between 13 achievable tuples and 14. The run was refused for want of data it
 * had.
 *
 * Each value is split over the blocks in proportion to their sizes, largest
 * remainder first, clamped to the room a block has left. The MULTISET is
 * untouched — the same values in the same numbers, only distributed — so every
 * declared percentage survives exactly, which is the rule the whole group obeys.
 *
 * What this can and cannot recover is worth stating. It undoes the imbalance
 * the CUT introduced. It does nothing for imbalance that was in the draw to
 * begin with: a `template` column draws each row independently, so its counts
 * are uneven before any block exists, and dealing an already-random column
 * across two blocks leaves it just as random.
 */
function dealAcrossBlocks(column: readonly string[], blockSizes: readonly number[]): string[][] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const value of column) {
    if (!counts.has(value)) order.push(value);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const total = column.length;
  const out: string[][] = blockSizes.map(() => []);
  const room = [...blockSizes];

  for (const value of order) {
    const want = counts.get(value) ?? 0;
    const exact = blockSizes.map((size) => (total === 0 ? 0 : (want * size) / total));
    const share = exact.map((e, i) => Math.min(room[i] ?? 0, Math.floor(e)));
    let given = share.reduce((a, b) => a + b, 0);

    // The remainder goes to the blocks with the largest fraction owed, ties by
    // block order — the same largest-remainder rule the percentages use, so two
    // implementations cannot disagree about who gets the odd one.
    const owed = exact
      .map((e, i) => ({ i, rem: e - Math.floor(e) }))
      .sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (const { i } of owed) {
      if (given >= want) break;
      if ((share[i] ?? 0) < (room[i] ?? 0)) {
        share[i] = (share[i] ?? 0) + 1;
        given += 1;
      }
    }
    // A block that filled up sends its share on to the next with room. Without
    // this the last value would have nowhere to go and the deal would lose it.
    for (let i = 0; given < want && i < share.length; i++) {
      while (given < want && (share[i] ?? 0) < (room[i] ?? 0)) {
        share[i] = (share[i] ?? 0) + 1;
        given += 1;
      }
    }

    share.forEach((n, i) => {
      for (let k = 0; k < n; k++) out[i]?.push(value);
      room[i] = (room[i] ?? 0) - n;
    });
  }
  return out;
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

    const subjects = subjectsOf(members, specByName);
    const blocks = partitionRows(rows, subjects, registry);
    const blockSizes = blocks.map((b) => b.length);
    /*
     * Dealt before any block is looked at, so each one gets a fair share of
     * every value rather than whichever ones fell into it. With no switch there
     * is a single block and the deal is the identity — the old behaviour, bit
     * for bit.
     *
     * TWO members are held back, for two different reasons. A `<switch>`
     * answers the subject of its own row, so moving it would put a male name in
     * a female row. And the SUBJECT itself is what the blocks were cut by: deal
     * it and the block no longer describes the rows in it — measured, and the
     * output had eighteen rows of thirty-six carrying the wrong gender's name,
     * every one of them counted as a distinct row.
     */
    // One block means nothing was cut, so there is nothing to deal — and dealing
    // anyway is NOT a no-op: it rebuilds the column grouped by value, which is a
    // different order for `arrangeUnique` to work from and so a different (still
    // correct) arrangement. Two shared cases moved on exactly that, both of them
    // groups with no switch at all. A config that gains nothing here must not
    // pay a changed output for it.
    const dealt = members.map((name) =>
      blocks.length > 1 &&
      specByName.get(name)?.switchSpec === undefined &&
      !subjects.includes(name)
        ? dealAcrossBlocks(
            rows.map((i) => registry[name]?.values[i] ?? ''),
            blockSizes,
          )
        : undefined,
    );

    blocks.forEach((block, bi) => {
      const columns = members.map(
        (name, m) => dealt[m]?.[bi] ?? block.map((i) => registry[name]?.values[i] ?? ''),
      );
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
    });

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
            ? produceOneScalar(memberSpec, draw, locale, now, keyed ? redraw : ctx, registry, i)
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

/**
 * Draw one fresh scalar value from a simple, mix or switch sequence spec.
 *
 * A switch needs the ROW, which the other two do not: its branch is chosen by
 * the subject column's value on that row, so a redraw has to land in the same
 * branch the original did — a `<case is="Male">` row must stay a male name.
 * Without the row this function had nothing to select with and returned the
 * empty string, which the caller then accepted as a value different from every
 * other: the colliding row came out BLANK, on every engine, with no diagnostic.
 * The construct said it could redraw and produced nothing, which is the failure
 * this codebase keeps meeting; the doc comment even claimed the switch case was
 * handled.
 */
function produceOneScalar(
  spec: SequenceSpec,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  registry: Record<string, Sequence>,
  row: number,
): string {
  // One row, so the build must not reach for a whole-column plan — `perRow`
  // is the same mark the streaming engines put on their one-row contexts.
  const oneRow = { ...ctx, perRow: true };
  if (spec.gen) return buildGenValues(spec.gen, 1, prng, locale, now, oneRow)[0] ?? '';
  if (spec.mixSpec) return buildMixValues(spec.mixSpec, 1, prng, locale, now, oneRow)[0] ?? '';
  if (spec.switchSpec)
    return produceOneSwitch(spec.switchSpec, prng, locale, now, ctx, registry, row);
  return '';
}

/**
 * One fresh value from the branch this row's subject selects — the FIRST entry
 * whose keys hold the subject's value, else `<default>`, else the empty string,
 * exactly the precedence materializeSwitch uses when it builds the column.
 */
function produceOneSwitch(
  switchSpec: SwitchSpec,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  registry: Record<string, Sequence>,
  row: number,
): string {
  const subject = registry[switchSpec.on];
  const key = subject ? (sequenceValueAt(subject, row) ?? '') : '';
  const entry = switchSpec.entries.find((e) => e.keys.includes(key));
  const chosen = entry?.value ?? switchSpec.fallback;
  if (chosen === undefined) return '';
  return buildCaseValues(chosen, 1, prng, locale, now, ctx)[0] ?? '';
}
