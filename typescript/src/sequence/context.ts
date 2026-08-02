/**
 * The state a single render shares across every generator it builds.
 *
 * Kept apart from build.ts so the pieces extracted from it (file sources,
 * per-row resolution) can depend on the shape without importing the builder
 * itself — which would make the imports circular.
 */

import type { DataSourceOptions } from '../data-source/index.js';
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
   * Set by the streaming engines, which resolve one row at a time. Anything that
   * is only correct across a whole column must refuse to run here rather than
   * quietly compute its quota over a single row.
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
   * Set only by the async render path. A `type="http"` generator makes a network
   * call, which cannot happen inside this synchronous builder — so it produces a
   * placeholder column here and an async post-pass fills it. When this flag is
   * absent, an http generator refuses rather than emit silent placeholders.
   */
  readonly httpDeferred?: boolean | undefined;
}
