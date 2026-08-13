/**
 * The two `type="file"` columns the streaming engine resolves itself.
 *
 * ## The exact quantile sweep
 *
 * `read="quantile"` on its own needs nothing here: it is one uniform per row,
 * and the generic per-row path already answers it identically on every engine.
 * `sample="exact"` is different — it hands each row its own point on the sorted
 * sample, and which point follows from a scatter over the WHOLE run. The generic
 * path is handed a count of one and could not know how many rows there are, so
 * it would give every row the median. (Measured, before this existed: a hundred
 * thousand rows all came out 53.30.)
 *
 * Its own module because `stream-build.ts` is at the repo's ceiling on file
 * length, and because the arithmetic belongs beside the generator rather than
 * inside the dispatcher.
 */

import { resolveExistingDataSourcePath } from '../data-source/index.js';
import { loadFileValues } from '../generators/file.js';
import { exactQuantileAt, quantileSource } from '../generators/quantile.js';
import { permuteKey } from '../prng/permute.js';
import type { DataSourceOptions } from '../data-source/index.js';

import { exactSample } from './file-values.js';
import { csvColumnCell } from '../generators/file.js';
import { seekableInt } from '../prng/seekable.js';
import { prepareRowLinkedFileSource } from './row-link.js';
import type { GenSpec } from './types.js';

/**
 * The value at a population row, or undefined when this generator is not an
 * exact quantile sweep and the caller should carry on down its other branches.
 *
 * The file is read and sorted ONCE, when the column is prepared — not per row —
 * so a run of any length costs the sample, and nothing more.
 */
export function exactQuantileSweep(
  gen: GenSpec,
  dataSources: DataSourceOptions,
  seed: string,
  streamId: string,
  size: number,
): ((row: number) => string) | undefined {
  if (gen.type !== 'file') return undefined;
  if ((gen.attrs['read'] ?? '').trim() !== 'quantile') return undefined;
  if (!exactSample(gen)) return undefined;

  const src = gen.attrs['src'] ?? '';
  const resolved = resolveExistingDataSourcePath(src, dataSources).path;
  const source = quantileSource(
    loadFileValues(resolved, {
      column: gen.attrs['column'],
      header: gen.attrs['header'],
      delimiter: gen.attrs['delimiter'],
    }),
    src,
  );
  const raw = (gen.attrs['decimals'] ?? '').trim();
  const decimals = raw === '' ? source.decimals : Number(raw);
  const key = permuteKey(seed, streamId);
  return (row) => exactQuantileAt(source, decimals, size, key, row);
}

/** Apply a row resolver to a population index that may be filtered out. */
export function atRow(row: number | undefined, value: (row: number) => string): string | undefined {
  return row === undefined ? undefined : value(row);
}

/**
 * A row-linked file field (`row="K"`), or undefined when this is not one.
 *
 * Every field sharing the key must resolve the SAME CSV row for a given card —
 * that is what keeps a name, an email and a city coherent — while the row itself
 * varies per card. The in-memory engine builds a shared plan of `count` indexes;
 * a streaming resolver has no such plan (it answers one card at a time), so it
 * re-derives the card's row from a seekable stream keyed by the LINK, shared
 * across the link's fields and independent of each field's own stream.
 */
export function rowLinkedFileValue(
  gen: GenSpec,
  dataSources: DataSourceOptions,
  seed: string,
): ((card: number) => string) | undefined {
  if (gen.type !== 'file') return undefined;
  const linked = prepareRowLinkedFileSource(gen, dataSources);
  if (!linked) return undefined;
  return (card) => {
    const index = seekableInt(seed, linked.streamId, card, linked.rowCount);
    return csvColumnCell(linked.rows[index] ?? [], linked.columnIndex);
  };
}
