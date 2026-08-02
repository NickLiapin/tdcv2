/**
 * Row-linked CSV file sources (`<gen type="file" row="KEY">`).
 *
 * Extracted from build.ts: the streaming engines (Engine 2/3) resolve one card
 * at a time, so a row-linked file gen needs a seekable source keyed by the link
 * rather than Engine 1's whole-column plan. Kept in its own module so build.ts
 * (the in-RAM engine) stays focused; `normalizeRowLink` lives here too since both
 * engines share it.
 */

import { resolveExistingDataSourcePath, type DataSourceOptions } from '../data-source/index.js';
import { csvColumnCell, loadCsvColumnSource } from '../generators/file.js';
import { weightColumnOf } from '../generators/weighted.js';
import { StreamUnsupportedError } from './stream-build.js';
import type { GenSpec } from './types.js';

/** Normalise a `row="…"` attribute: trimmed non-empty string, or undefined. */
export function normalizeRowLink(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (value !== undefined && !trimmed) {
    throw new Error('sequence: file row link must not be empty');
  }
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A row-linked CSV source prepared for the streaming engines (Engine 2/3).
 * `streamId` is shared by every field/sequence on the same link so their
 * per-card row draws coincide.
 */
export interface RowLinkedFileSource {
  readonly rows: readonly (readonly string[])[];
  readonly columnIndex: number;
  readonly rowCount: number;
  /** Seekable stream id — shared across all fields on this link. */
  readonly streamId: string;
}

/**
 * Resolve a row-linked file gen for the STREAMING engines.
 *
 * Engine 1's `buildFileValues` builds a shared plan of `count` row indexes (one
 * per card) from the sequential PRNG — right there, because it materializes the
 * whole column at once. The streaming engines resolve ONE card at a time, so
 * that path degenerates: `count` is 1, the single-index plan is cached under the
 * row key on the first card, and then broadcast to every other card (the whole
 * dataset collapses to one CSV row). Streaming instead re-derives each card's
 * row index from a SEEKABLE stream keyed by the LINK, giving both properties the
 * plan gives Engine 1:
 *   - every field sharing `row="K"` lands on the SAME row for a given card
 *     (intra-card column coherence), because they share this `streamId`, and
 *   - the row varies per card, because the draw is keyed by the card index.
 * The stream id is derived solely from the (global) row-link key — matching
 * Engine 1, whose `fileRowLinks` plan is also keyed by the link across the whole
 * render, with a rule that forbids one key spanning two sources. Keeping it free
 * of the field id means adding a field to a link never perturbs its siblings
 * (the "does not advance PRNG again" invariant); keeping it free of the resolved
 * file PATH means the draw stays config-derived and portable across machines and
 * language ports, like every other streaming stream id.
 *
 * Returns `null` for a plain (non-linked) file gen so the caller falls through
 * to the ordinary per-field path. Validation mirrors `buildFileValues`.
 */
export function prepareRowLinkedFileSource(
  gen: GenSpec,
  dataSources: DataSourceOptions,
): RowLinkedFileSource | null {
  const rowKey = normalizeRowLink(gen.attrs['row']);
  if (!rowKey) return null;

  // `weight=` + `row=` needs an exact quota over the whole file, which the lazy
  // per-card draw can't give — defer to the in-memory engine (resolveRenderEngine
  // routes such configs there; a forced --engine 2/3 lands here and is told).
  if (weightColumnOf(gen.attrs) !== undefined) {
    throw new StreamUnsupportedError(
      `weight= combined with row= needs an exact quota over the whole file; ` +
        `the in-memory engine handles it (run without a forced streaming engine)`,
    );
  }

  const column = gen.attrs['column'];
  if (!column || column.trim().length === 0) {
    throw new Error('sequence: row-linked file generator requires a CSV "column" attribute');
  }
  const src = gen.attrs['src'] ?? '';
  const resolvedSrc = resolveExistingDataSourcePath(src, dataSources).path;
  const source = loadCsvColumnSource(resolvedSrc, {
    column,
    header: gen.attrs['header'],
    delimiter: gen.attrs['delimiter'],
  });
  if (source.rows.length === 0) {
    throw new Error(`file generator: CSV file at "${src}" has no data rows`);
  }
  if (!source.rows.some((row) => csvColumnCell(row, source.columnIndex).length > 0)) {
    throw new Error(`file generator: CSV column "${source.column}" at "${src}" has no values`);
  }
  return {
    rows: source.rows,
    columnIndex: source.columnIndex,
    rowCount: source.rows.length,
    streamId: `filerowlink|${rowKey}`,
  };
}
