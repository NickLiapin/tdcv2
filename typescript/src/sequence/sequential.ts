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
import { joinParts, type RepeatSpec } from './repeat.js';
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

/**
 * The walk a fixed `repeat="N"` rides, or undefined when this is not that column.
 *
 * Both engines ask the same question here, so neither spells the condition out and
 * they cannot drift apart on which configs are walked.
 */
export function walkedRepeat(
  gen: GenSpec,
  spec: RepeatSpec | undefined,
  dataSources: DataSourceOptions,
): ((row: number) => string) | undefined {
  if (!spec || spec.min !== spec.max) return undefined;
  if (gen.type !== 'text' && gen.type !== 'file') return undefined;
  if (gen.attrs['order'] !== 'sequential') return undefined;
  const list = sequentialList(gen, dataSources);
  const cycle = gen.attrs['cycle'] !== 'false';
  return (row) => joinParts(sequentialRow(list, row, spec.max, cycle), spec);
}

/**
 * How a walked column answers ONE row — with a fixed `repeat=` or without.
 *
 * The streaming engine asks for exactly this and nothing else, so the choice
 * between the two shapes is made once, here, rather than at every row.
 */
export function walkedValueAt(
  gen: GenSpec,
  spec: RepeatSpec | undefined,
  dataSources: DataSourceOptions,
): (row: number) => string {
  const walk = walkedRepeat(gen, spec, dataSources);
  if (walk) return walk;
  const list = sequentialList(gen, dataSources);
  const cycle = gen.attrs['cycle'] !== 'false';
  return (row) => pickSequential(list, row, cycle);
}

/**
 * The values of ONE row when a fixed `repeat="N"` rides `order="sequential"`.
 *
 * Element k of row r takes source index `r * N + k`: the walk carries on across
 * rows rather than restarting, which is what makes `repeat="1"` mean exactly
 * what `order="sequential"` alone has always meant. A row is still a function of
 * its own number, so this resolves the same way on every engine.
 *
 * Only a FIXED repeat reaches here. A ranged one has no stride, and the
 * validator refuses it (`TDC254`) rather than inventing one.
 */
function sequentialRow(list: readonly string[], row: number, n: number, cycle: boolean): string[] {
  const out: string[] = new Array<string>(n);
  for (let k = 0; k < n; k++) {
    const at = row * n + k;
    // The bound is checked here rather than in `sequentialIndex`, because with a
    // repeat the number that ran out is a position in the walk and not a row —
    // and a message naming the wrong one sends a reader to the wrong attribute.
    if (!cycle && list.length > 0 && at >= list.length) {
      throw new Error(
        `order="sequential" cycle="false": the source has only ${String(list.length)} values, ` +
          `so row ${String(row + 1)} runs out at element ${String(k + 1)} — shorten count=, ` +
          'shorten repeat=, or lengthen the source',
      );
    }
    out[k] = pickSequential(list, at, true);
  }
  return out;
}
