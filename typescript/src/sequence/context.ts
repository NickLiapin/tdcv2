/**
 * The state a single render shares across every generator it builds.
 *
 * Kept apart from build.ts so the pieces extracted from it (file sources,
 * per-row resolution) can depend on the shape without importing the builder
 * itself — which would make the imports circular.
 */

import type { DataSourceOptions } from '../data-source/index.js';
import type { ExactLayout } from './per-row.js';
import type { PackRegistry } from '../data-pack/index.js';

/**
 * The row choices behind one `row="K"` link: which CSV rows this card series
 * uses, and the exact file reading they were drawn from, so a second field
 * claiming the same key can be checked rather than silently disagree.
 */
export interface LinkedFileRowPlan {
  readonly sourceKey: string;
  readonly indexes: readonly number[];
}

export interface SequenceBuildContext {
  readonly regexMaxLength?: number | undefined;
  readonly dataSources: DataSourceOptions;
  readonly fileRowLinks: Map<string, LinkedFileRowPlan>;
  readonly packs?: PackRegistry | undefined;
  /**
   * The column this build belongs to, when the caller is a one-row resolver that
   * has no `seed`/`streamId` of its own to lend.
   *
   * Only a pack generator reads them: its body is seeded from the column's
   * identity, and the in-memory engine's one-row path has that identity to hand
   * while the streaming one does not. Carried under their own names rather than
   * as `seed`/`streamId`, because setting those on a one-row context switches on
   * every whole-column layout inside it — measured, a `<distinct>` redraw
   * changed its answer, and `<distinct>` has nothing to do with packs.
   */
  readonly columnSeed?: string | undefined;
  readonly columnStreamId?: string | undefined;
  /**
   * Set on a ONE-ROW build — by the streaming engines, which resolve every row
   * that way, and by the in-memory engine inside its own per-row loop. Anything
   * that is only correct across a whole column must refuse to run here rather
   * than quietly compute its quota over a single row.
   */
  readonly perRow?: boolean | undefined;
  /** The run's seed, for anything that derives a stream of its own. */
  readonly seed?: string | undefined;
  /**
   * The column being built, as the registry keys it — `Name`, or `Name.field`
   * for a compound field. It is the stream name the per-row derivation hashes,
   * and it must be the SAME string the streaming engine passes, or the two key
   * their randomness differently and produce different data from one seed.
   */
  readonly streamId?: string | undefined;
  /**
   * The ABSOLUTE row each drawn position belongs to, when the column does not
   * cover every row.
   *
   * A `parent="G.M"` column is built compacted — one value per applicable row,
   * spread over the mask afterwards — but the streaming engine derives it at the
   * row's real index. Without this, position 1 of the compacted column would be
   * keyed as row 1 while the streaming engine keys the same cell as row 3, and
   * the two engines part company on every filtered column. Absent means the
   * column covers every row, so position and row are the same number.
   */
  readonly rows?: readonly number[] | undefined;
  /**
   * The exact layout each finished column got, by column name — written by
   * `exactTextLayout`, read by a child that filters on one of them.
   *
   * A child's position inside its parent's subset is its RANK in the parent's
   * layout, not its ordinal among the matching rows, and the two are different
   * orders. Shared by reference across every derived context, so a column
   * declared later can see one built earlier.
   */
  readonly layouts?: Map<string, ExactLayout> | undefined;
  /**
   * Set only by the async render path. A `type="http"` generator makes a network
   * call, which cannot happen inside this synchronous builder — so it produces a
   * placeholder column here and an async post-pass fills it. When this flag is
   * absent, an http generator refuses rather than emit silent placeholders.
   */
  readonly httpDeferred?: boolean | undefined;
  /**
   * A finished column's value at an ABSOLUTE row — what a `<switch>` written
   * inside a `<case>` looks its subject up in.
   *
   * A nested switch is not a column and never appears in the registry itself,
   * so it cannot be resolved the way the env-level form is. It reads the
   * registry through this instead, which keeps the reader out of the type: the
   * streaming engine passes the same function over its own lazy columns.
   */
  readonly valueAt?: ((name: string, row: number) => string | undefined) | undefined;
  /**
   * Is this name a COLUMN at all?
   *
   * `valueAt` answers `undefined` both for a column that is empty on this row
   * and for a word that is no column — and the two must not be confused, since
   * an unresolved word is a text literal in this language (`if="Tier == hi"`).
   * Asked live rather than from a snapshot, because the streaming registry
   * fills in as columns are reached.
   */
  readonly hasColumn?: ((name: string) => boolean) | undefined;
  /**
   * Date columns that must keep their instant beside their text, because some
   * `<gen type="date" of="…">` measures from them.
   *
   * Collected once, before any column is built, so the cost of remembering the
   * real value falls only on the columns a config actually reads back — every
   * other date column stays a plain array of strings.
   */
  readonly instantColumns?: ReadonlySet<string> | undefined;
}
