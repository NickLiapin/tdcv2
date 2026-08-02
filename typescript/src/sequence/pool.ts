/**
 * `<pool>` — a small table computed once, before the rows.
 *
 * Twenty doctors for two thousand patients. Ten departments for a thousand
 * employees. The problem an ordinary sequence cannot solve: a doctor is not a
 * VALUE, he is a RECORD — a gender, a first name and a last name that have to
 * agree with each other. A column of thirty names cannot keep `Male` next to
 * `Дмитрий`; a table of thirty rows can.
 *
 * The whole design rests on one observation: **a pool is a miniature `<env>`.**
 * Its body holds the same `<sequence>`, `<mix>`, `<switch>`, `<uniq>` and
 * `<distinct>` that live at the top level and means the same thing by them, so
 * this file extracts it with the very same walker — `extractSequenceSpecs` is
 * handed the pool node instead of the env node and needs no change at all.
 * Nothing new to learn for whoever writes the config, and nothing new to
 * maintain for whoever reads this code.
 *
 * A pool is not read directly. `${{Doctors.lastName}}` would give the dot a
 * second meaning next to `${{Sequence.Field}}`, and one mark with two jobs is
 * the defect this codebase keeps having to undo. Instead a sequence draws from
 * it — `<gen type="pool" value="Doctors"/>` — and that sequence is read exactly
 * like any other compound. It also hands us the hardest rule for free: one
 * sequence holds one value per row, so every field read from the same reference
 * in the same row comes from the same member. "Дмитрий Иванова" is not
 * prevented by a check; it is unrepresentable.
 */

import type { OpenCloseElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

import { seekableInt } from '../prng/seekable.js';
import { extractEnvDistinctGroups, extractEnvUniqGroups, extractSequenceSpecs } from './extract.js';
import type { SequenceSpec } from './types.js';

/** A pool declaration: how many members, and how each one is built. */
export interface PoolSpec {
  readonly name: string;
  /** Number of members. Separate from `<env count>` — thirty doctors, two thousand patients. */
  readonly count: number;
  /** The member's columns, in declaration order (draw order is part of the contract). */
  readonly specs: readonly SequenceSpec[];
  /** `<uniq>` groups inside the pool — thirty DIFFERENT doctors. */
  readonly uniqGroups: readonly (readonly string[])[];
  /** `<distinct>` groups inside the pool. */
  readonly distinctGroups: readonly (readonly string[])[];
}

/**
 * Every `<pool>` declared directly under `<env>`, in document order.
 *
 * Lenient on purpose, like the sequence extractor beside it: a missing `name`
 * or an unreadable `count` produces a spec the render path can still look at,
 * and the validator is what says so out loud (TDC222, TDC223). Declaring the
 * failure in two places would let the two drift apart.
 */
export function extractPoolSpecs(env: OpenCloseElementContext | undefined): PoolSpec[] {
  if (!env) return [];
  const pools: PoolSpec[] = [];
  for (const node of poolNodes(env)) {
    const attrs = extractAttrs(node.attr());
    const count = Number(attrs['count']);
    pools.push({
      name: attrs['name'] ?? '',
      count: Number.isFinite(count) ? Math.trunc(count) : 0,
      specs: extractSequenceSpecs(node),
      uniqGroups: extractEnvUniqGroups(node),
      distinctGroups: extractEnvDistinctGroups(node),
    });
  }
  return pools;
}

/** The `<pool>` elements under `<env>`. */
function* poolNodes(env: OpenCloseElementContext): Generator<OpenCloseElementContext> {
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind === 'open' && elementName(k.node) === 'pool') yield k.node;
  }
}

/**
 * A pool once it has been computed: `count` members, each a set of named
 * fields. Stored column-first because that is how a member is read — a row asks
 * for one field of one member, never for a whole member at once.
 */
export interface PoolTable {
  readonly name: string;
  readonly count: number;
  /** Field names in declaration order (the order `${{Ref.field}}` may use). */
  readonly fields: readonly string[];
  /** field → one value per member. */
  readonly columns: Readonly<Record<string, readonly string[]>>;
}

/** Every computed pool, by name. */
export type PoolTables = Readonly<Record<string, PoolTable>>;

/** A sequence that draws from a pool rather than generating its own value. */
export function poolRefName(spec: SequenceSpec): string | undefined {
  if (spec.gen?.type !== 'pool') return undefined;
  const value = spec.gen.attrs['value'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * The PRNG stream a reference draws its member from.
 *
 * Deliberately its OWN stream rather than the main sequential one, for the same
 * reason the pool itself is built from a derived seed: adding a reference to a
 * config must not shift the values of every column declared after it. A run
 * that gains a doctor column keeps its ids, ages and names exactly as they
 * were, and an old snapshot still matches.
 *
 * Seekable by row, so the streaming engines get the identical member for row
 * `i` without computing rows 0…i−1 — the pick costs the same whichever engine
 * asks. The string format is part of the cross-language contract.
 */
export function poolRefStream(refName: string): string {
  return `pool-ref:${refName}`;
}

/** Which member of `table` the reference hands to row `row`. */
export function pickMember(seed: string, refName: string, table: PoolTable, row: number): number {
  return seekableInt(seed, poolRefStream(refName), row, table.count);
}
