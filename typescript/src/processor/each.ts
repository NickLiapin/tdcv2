/**
 * `each="NAME"` on a `<line>` — render it once per element of a list.
 *
 * This is what turns a card holding a list into normalized rows: a customer
 * with three orders emits three `INSERT INTO orders` lines instead of one line
 * with the orders comma-joined in a cell.
 *
 * The whole mechanism is an OVERLAY registry. `interpolate` resolves names
 * against a registry, so rendering an element only means handing it a registry
 * where `NAME` resolves to that element and the two positional built-ins exist.
 * Nothing in the interpolation path changes.
 *
 * Kept apart from render.ts so the splitting and the key arithmetic can be
 * checked without running a renderer.
 * Spec: docs/specs/2026-07-19-each-repeating-a-line-per-list-element.md
 */

import { parseRepeat } from '../sequence/repeat.js';
import type { Sequence, SequenceRegistry, SequenceSpec } from '../sequence/index.js';

/** 1-based position of the element within its card. */
export const ITEM_INDEX = '_item';

/** Key unique across the whole run — the primary key of the child table. */
export const ITEM_ID = '_item_id';

/** Built-ins that only mean anything inside an `each` line. */
export const EACH_BUILTINS: readonly string[] = [ITEM_INDEX, ITEM_ID];

/**
 * Split a card's cell into the elements the loop walks.
 *
 * An empty cell is an EMPTY LIST, not a list holding one blank — otherwise
 * `"".split(",")` would invent a phantom element and emit a row for a customer
 * with no orders. Same rule the Parquet list path uses.
 */
export function splitElements(cell: string | undefined, separator: string): string[] {
  if (cell === undefined || cell === '') return [];
  return cell.split(separator);
}

/**
 * The key for element `position` (1-based) of card `card` (1-based).
 *
 * Each card owns a block of `stride` keys, and each LIST owns a lane inside
 * that block starting at `lane`. Both are needed: a config with two repeating
 * sequences writes both into the same child table, and giving them one shared
 * counter makes their keys collide. Measured before this shape existed: 3501
 * rows produced only 3071 distinct keys.
 *
 * Derived from the card index alone, so a row still resolves without knowing
 * anything about its predecessors — which is what keeps `--jobs` and the
 * streaming engine working. It leaves gaps when a card holds fewer elements
 * than its list allows; that is the deliberate trade documented in the spec.
 * Keys that increase down the file read better in a SQL dump than gap-free
 * keys that jump around.
 */
export function itemKey(card: number, position: number, lane: number, stride: number): number {
  return (card - 1) * stride + lane + position;
}

/** A registry entry holding one fixed value for every row. */
function constant(name: string, value: string): Sequence {
  return { name, values: [], resolve: () => value };
}

/**
 * A registry for one element: the base registry, with `name` resolving to this
 * element and the positional built-ins added.
 *
 * Shallow — every other sequence still resolves per CARD, which is exactly what
 * makes the foreign key (`${{Id}}`) point at the right parent on every emitted
 * row.
 */
export function elementRegistry(
  base: SequenceRegistry,
  name: string,
  element: string,
  position: number,
  card: number,
  lane: number,
  stride: number,
): SequenceRegistry {
  return {
    ...base,
    [name]: constant(name, element),
    [ITEM_INDEX]: constant(ITEM_INDEX, String(position)),
    [ITEM_ID]: constant(ITEM_ID, String(itemKey(card, position, lane, stride))),
  };
}

/** What a line needs to know to walk a list and number its elements. */
export interface EachInfo {
  readonly separator: string;
  /** Where this list's lane starts inside a card's key block. */
  readonly lane: number;
  /** Keys per card, across ALL lists — so two lists never overlap. */
  readonly stride: number;
}

/**
 * Index the repeating sequences by name, once per render.
 *
 * Only sequences whose generator declares `repeat` appear: a name absent from
 * this map is not a list, which is what the validator reports as TDC207.
 */
export function buildEachInfo(specs: readonly SequenceSpec[]): Map<string, EachInfo> {
  // First pass: collect the lists and lay out their lanes in declaration order.
  const found: { name: string; separator: string; max: number }[] = [];
  for (const spec of specs) {
    const gen = spec.gen;
    if (!gen) continue;
    const repeat = parseRepeat(gen.attrs);
    if (!repeat) continue;
    found.push({ name: spec.name, separator: repeat.separator, max: repeat.max });
  }

  const stride = found.reduce((sum, f) => sum + f.max, 0);
  const out = new Map<string, EachInfo>();
  let lane = 0;
  for (const f of found) {
    out.set(f.name, { separator: f.separator, lane, stride });
    lane += f.max;
  }
  return out;
}
