/**
 * `order="sequential"` — the position-driven read of a listed source.
 *
 * Extracted from `build.ts` at its line ceiling; the three of them answer as
 * one so a text list, a file column and a walked date range run out the same
 * way.
 */
import { resolveExistingDataSourcePath } from '../data-source/resolve.js';
import type { DataSourceOptions } from '../data-source/resolve.js';
import { loadCsvColumnFile, loadListFile } from '../generators/file.js';
import type { GenSpec } from './types.js';

/**
 * The ordered value list of a list-backed generator, for `order="sequential"`:
 * `text` splits its `value`, `file` loads its lines (or a CSV column) as-is.
 */
export function sequentialList(gen: GenSpec, dataSources: DataSourceOptions): string[] {
  if (gen.type === 'file') {
    const resolved = resolveExistingDataSourcePath(gen.attrs['src'] ?? '', dataSources).path;
    const column = gen.attrs['column'];
    const options = { column, header: gen.attrs['header'], delimiter: gen.attrs['delimiter'] };
    return column && column.trim().length > 0
      ? loadCsvColumnFile(resolved, options)
      : loadListFile(resolved);
  }
  return (gen.attrs['value'] ?? '').split(',').map((s) => s.trim());
}

/**
 * Which of `size` values row `index` gets: `index mod size` (loop), or an error
 * past the end when `cycle=false`.
 *
 * The one place that decides, so a text list, a file column and a walked date
 * range answer the same way — and say the same thing when they run out. A date
 * range never becomes a list (a century by the second is not a list anyone
 * should hold), which is why this takes a SIZE rather than the values.
 */
export function sequentialIndex(size: number, index: number, cycle: boolean): number {
  if (size <= 0) return 0;
  if (!cycle && index >= size) {
    // Say which ROW ran out, not how many rows were asked for: the streaming path
    // resolves one row at a time and does not know the run's size here. The old
    // wording read "only 4 values for 5 rows" on a config that said count="6",
    // so the one number a reader would take to their config was the wrong one.
    throw new Error(
      `order="sequential" cycle="false": the source has only ${String(size)} values, ` +
        `so row ${String(index + 1)} has none — shorten count= or lengthen the source`,
    );
  }
  return index % size;
}

/** Pick element `index mod N` (loop), or error past the end when `cycle=false`. */
export function pickSequential(list: readonly string[], index: number, cycle: boolean): string {
  if (list.length === 0) return '';
  return list[sequentialIndex(list.length, index, cycle)] ?? '';
}
