/**
 * Sequence types.
 *
 * The sequence engine materializes, for every named sequence declared
 * in `<env>`, an array of length `count` whose i-th entry is the value
 * that sequence produces for card `i`. Filtered (parent-constrained)
 * sequences store `undefined` in rows where the parent filter did not
 * match, so the row's cells can decide whether to emit content.
 *
 * See docs/vision/02-sequences.md for the domain model.
 */

import type { OpenCloseElementContext } from '../generated/TDCParser.js';

import type { AttrMap } from '../processor/attrs.js';

/**
 * Spec extracted from a `<sequence>` tag in the DSL.
 *
 * Two shapes, distinguished by how the `<gen>` children look:
 *
 *   - **Simple** — one unnamed `<gen>` child. The sequence is registered
 *     under its `name` and accessed via `${{Name}}`.
 *   - **Compound** — two or more `<gen name="...">` children. Each field
 *     is registered with a dotted key `${parentName}.${fieldName}` and
 *     accessed via `${{Parent.Field}}`. All fields of a compound share
 *     the same `parent` filter (if any) and thus materialize on exactly
 *     the same rows.
 *   - **Mix** — a `<mix>` distribution. The sequence itself is scalar, but
 *     the value is assembled from the selected `<case>`'s `<data>`,
 *     `<gen>`, and nested `<mix>` content, chosen by percentage.
 *
 * Which variant is in play is determined at extraction time — the
 * `gens` array being non-empty with named gens triggers "compound".
 */
export interface SequenceSpec {
  readonly name: string;
  /**
   * Parent reference in `Name.Value` dotnotation, e.g. `Gender.Male`.
   * When present, the sequence only materializes values in rows where
   * the named parent produced the given value. When absent, the
   * sequence applies to every row (root sequence).
   *
   * A bare `Name` without a `.Value` suffix is allowed for symmetry
   * but behaves exactly like "no filter" at this phase — future
   * compound/filtered-by-any semantics may attach richer meaning.
   */
  readonly parent?: string;
  /**
   * Simple-sequence variant: a single anonymous `<gen>`. Present iff
   * `gens` is absent.
   */
  readonly gen?: GenSpec;
  /**
   * Compound-sequence variant: an ordered list of named `<gen name="…">`
   * children. Present iff `gen` is absent. Field order is preserved
   * from the DSL — important because each field consumes PRNG bits
   * when materialized, and the order of consumption is part of the
   * deterministic contract.
   */
  readonly gens?: readonly CompoundField[];
  /**
   * Composed-sequence variant: the body read as ONE ordered list.
   *
   * A `<sequence>` whose children are not all named `<gen>`s composes its own
   * value: every unnamed `<gen>` and every `<data>` literal is concatenated, in
   * declaration order, into `${{Name}}`; a named `<gen>` is a field, reachable
   * as `${{Name.Field}}` and contributing nothing to the concatenation.
   *
   * One list rather than two, because a sequence's `<gen>` children draw in
   * declaration order and that order is part of the cross-language contract.
   * Splitting the body into "fields" and "parts" would make the draw order a
   * thing to remember instead of a thing the shape guarantees.
   *
   * Present iff the body holds a `<data>` element or an unnamed `<gen>` beside
   * anything else — a body of nothing but named `<gen>`s stays `gens` and the
   * lone unnamed one stays `gen`, so no config that was valid before takes this
   * path.
   */
  readonly items?: readonly SequenceItem[];
  /**
   * Mix-sequence variant: a `<mix>` distribution whose selected case
   * produces the scalar value for this sequence. A `<mix>` is a standalone,
   * env-level named construct (sibling of `<sequence>`) — it distributes its
   * `<case>` branches across the rows by `percent` (Hamilton method).
   */
  readonly mixSpec?: MixSpec;
  /**
   * Switch-sequence variant: a standalone env-level `<switch on="…">` that
   * deterministically picks a value by matching the subject sequence's value
   * against per-entry keys (a lookup table). Present iff the sequence comes
   * from a `<switch>` tag.
   */
  readonly switchSpec?: SwitchSpec;
  /**
   * Conditional-sequence variant: an ordered list of `<gen if="…">` branches.
   * The FIRST branch whose `if` is truthy — or a branch with no `if` (the
   * fallback / "else") — produces the sequence's scalar value. If none match,
   * the sequence is empty on that row. Present iff the sequence's `<gen>`
   * children carry `if` conditions. This keeps the branching logic in `<env>`
   * (e.g. male-vs-female name) instead of leaking it into the output block.
   */
  readonly conditional?: readonly CondBranch[];
  /**
   * Compute-sequence variant: a `<compute>` element that derives this
   * sequence's scalar value from other values (spec §3). The compute tree is
   * pure — it consumes no PRNG state — and reads other sequences via
   * `<field name="…">` with the same visibility as `${{…}}`. Present iff the
   * sequence's sole producer is a `<compute>`.
   */
  readonly compute?: ComputeSpec;
  /**
   * `<distinct>` groups on a compound sequence. Each inner array holds the
   * field names that must produce **different** values from each other
   * within one row. Only meaningful alongside `gens`. Absent when the
   * sequence declares no `<distinct>` wrapper.
   */
  readonly distinctGroups?: readonly (readonly string[])[];
  /**
   * `uniq="true"` on a compound sequence: the tuple of all fields must be
   * **unique across every row** (the across-rows twin of `<distinct>`).
   * Enforced by rearranging the materialized field columns; infeasible
   * configs error before output. Only meaningful alongside `gens`.
   */
  readonly uniq?: boolean;
}

/** A `<compute>` producer: the element whose tree is evaluated per row. */
export interface ComputeSpec {
  readonly node: OpenCloseElementContext;
}

/**
 * One item of a composed sequence's body, in source order.
 *
 * A named gen is a field; an unnamed gen and a literal are parts of the
 * sequence's own value.
 */
export type SequenceItem =
  | { readonly kind: 'field'; readonly name: string; readonly gen: GenSpec }
  | { readonly kind: 'gen'; readonly gen: GenSpec }
  | { readonly kind: 'text'; readonly text: string }
  /**
   * A named `<data name="x">F</data>` — a constant field.
   *
   * The only way to add a column without disturbing the run: a
   * `<gen type="text" value="F"/>` yields the same value and still takes a draw
   * per row, so inserting one shifts every column after it.
   */
  | { readonly kind: 'constant'; readonly name: string; readonly text: string };

/** A single named field inside a compound sequence. */
export interface CompoundField {
  readonly name: string;
  readonly gen: GenSpec;
}

/** One branch of a conditional sequence: a gen, optionally gated by an `if`. */
export interface CondBranch {
  /** The `if` expression. Absent → this branch is the fallback ("else"). */
  readonly cond?: string;
  readonly gen: GenSpec;
}

/** Spec extracted from a `<gen>` tag inside a `<sequence>`. */
export interface GenSpec {
  readonly type: string;
  readonly attrs: AttrMap;
}

export interface MixSpec {
  readonly attrs: AttrMap;
  readonly cases: readonly CaseSpec[];
}

/**
 * A standalone env-level `<switch on="Subject">` — deterministic selection by
 * looking the subject sequence's value up in a table of keys. Each entry maps
 * one or more keys to a value-producer (a `<case>` body, or a literal `<data>`
 * for compact `<map>` rows). An optional `fallback` (from `<default>`) supplies
 * the value when no key matches; without it, an unmatched row is empty.
 */
export interface SwitchSpec {
  /** Name of the subject sequence whose per-row value is looked up. */
  readonly on: string;
  /** Key→value entries, in document order (map rows first, then <case>s). */
  readonly entries: readonly SwitchEntry[];
  /** `<default>` value-producer used when no entry key matches. */
  readonly fallback?: CaseSpec;
}

/** One `<switch>` entry: a value-producer keyed by one or more match values. */
export interface SwitchEntry {
  /** Match keys (multi-key via `|`, e.g. `US|CA|MX`). Any match selects it. */
  readonly keys: readonly string[];
  /** How to produce the value when a key matches (literal for `<map>` rows). */
  readonly value: CaseSpec;
}

export interface CaseSpec {
  readonly parts: readonly CasePart[];
  /**
   * `<case anomaly="true">` — this branch is declared anomalous, so a
   * `<mix flag="NAME">` companion column marks the rows that chose it. Purely
   * a label: it injects nothing, the branch's own gen produces the outlier.
   */
  readonly anomaly?: boolean;
}

export type CasePart =
  | { readonly kind: 'data'; readonly text: string }
  | { readonly kind: 'gen'; readonly gen: GenSpec }
  | { readonly kind: 'mix'; readonly mixSpec: MixSpec }
  /**
   * A `<switch>` written inside a `<case>`. It contributes a value only — it has
   * no `name`, so nothing can interpolate it — and it looks its subject up over
   * the rows of the branch it sits in, not over the run.
   */
  | { readonly kind: 'switch'; readonly switchSpec: SwitchSpec };

/** A materialized sequence ready for per-iteration lookup. */
export interface Sequence {
  readonly name: string;
  readonly values: readonly (string | undefined)[];
  /**
   * Streaming (Engine 2) resolver: compute row `i`'s value on demand. When
   * present it is used INSTEAD of `values` (which stays empty), so memory is
   * O(1) per sequence instead of O(count). See `sequenceValueAt`.
   */
  readonly resolve?: (i: number) => string | undefined;
}

/** Read a sequence's value for row `i` — lazy resolver if present, else array. */
export function sequenceValueAt(seq: Sequence, i: number): string | undefined {
  return seq.resolve ? seq.resolve(i) : seq.values[i];
}

/** Map of materialized sequences, keyed by sequence name. */
export type SequenceRegistry = Readonly<Record<string, Sequence>>;
