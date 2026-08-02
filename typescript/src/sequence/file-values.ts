/**
 * Values drawn from a `<gen type="file">`.
 *
 * Two modes. Plain: pick uniformly from the file's lines (or a CSV column).
 * Row-linked (`row="K"`): every field sharing the key resolves the SAME CSV row
 * for a given card, so a name, an email and a city taken from one file stay
 * coherent instead of being three unrelated rows. That shared choice lives in
 * `ctx.fileRowLinks` — built once by whichever field asks first, then reused
 * and cross-checked by the rest.
 *
 * Extracted from build.ts so that file stays focused; depends on nothing in it.
 */

import { resolveExistingDataSourcePath } from '../data-source/index.js';
import {
  csvColumnCell,
  fileUniform,
  loadCsvColumnSource,
  resolveCsvColumnIndex,
  type CsvColumnSource,
} from '../generators/file.js';
import { distributeByPercent } from '../distribution/hamilton.js';
import { WeightedFileError, loadWeightedValues, weightColumnOf } from '../generators/weighted.js';
import { randomInt } from '../prng/random.js';

import type { SequenceBuildContext } from './context.js';
import { normalizeRowLink } from './row-link.js';
import type { GenSpec } from './types.js';

/**
 * Identifies the exact CSV reading a row link was built against. Two fields
 * claiming the same `row="K"` must agree on all of it — otherwise "the same
 * row" would silently mean different rows in different files.
 */
export function linkedFileSourceKey(src: string, delimiter: string, skipHeader: boolean): string {
  // NUL-separated: a path or a delimiter may contain any printable character,
  // so a visible separator could let two different readings collide.
  return `${src}\u0000${delimiter}\u0000${skipHeader ? 'header' : 'no-header'}`;
}

export function buildFileValues(
  gen: GenSpec,
  count: number,
  prng: () => number,
  ctx: SequenceBuildContext,
): string[] {
  const src = gen.attrs['src'] ?? '';
  const options = {
    column: gen.attrs['column'],
    header: gen.attrs['header'],
    delimiter: gen.attrs['delimiter'],
  };
  const rowKey = normalizeRowLink(gen.attrs['row']);
  const resolvedSrc = resolveExistingDataSourcePath(src, ctx.dataSources).path;

  // `weight=` takes the proportions from a column of the file and honours them
  // EXACTLY — the same Hamilton path `percent=` uses, not a weighted coin flip.
  const weightColumn = weightColumnOf(gen.attrs);
  if (weightColumn !== undefined && !rowKey) {
    const { values, percents } = loadWeightedValues(resolvedSrc, options, weightColumn);
    return distributeByPercent({ count, values, percents, prng });
  }

  if (!rowKey) return fileUniform(resolvedSrc, options)(count, prng).slice();

  if (!options.column || options.column.trim().length === 0) {
    throw new Error('sequence: row-linked file generator requires a CSV "column" attribute');
  }

  const source = loadCsvColumnSource(resolvedSrc, options);
  if (source.rows.length === 0) {
    throw new Error(`file generator: CSV file at "${src}" has no data rows`);
  }
  if (!source.rows.some((row) => csvColumnCell(row, source.columnIndex).length > 0)) {
    throw new Error(`file generator: CSV column "${source.column}" at "${src}" has no values`);
  }

  const sourceKey = linkedFileSourceKey(resolvedSrc, source.delimiter, source.skipHeader);
  let plan = ctx.fileRowLinks.get(rowKey);
  if (!plan) {
    // With `weight=` the shared rows are drawn to an EXACT quota by the weight
    // column (every linked field then follows those same rows); without it the
    // rows are uniform. Either way the plan is one row index per card.
    const indexes =
      weightColumn !== undefined
        ? weightedRowIndexes(source, weightColumn, count, prng)
        : Array.from({ length: count }, () => randomInt(prng, 0, source.rows.length));
    plan = { sourceKey, indexes };
    ctx.fileRowLinks.set(rowKey, plan);
  } else {
    if (plan.sourceKey !== sourceKey) {
      throw new Error(`sequence: row link "${rowKey}" cannot mix different file sources`);
    }
    if (plan.indexes.length !== count) {
      throw new Error(`sequence: row link "${rowKey}" cannot be reused with a different row count`);
    }
  }

  return plan.indexes.map((index) => csvColumnCell(source.rows[index] ?? [], source.columnIndex));
}

/**
 * Row INDICES drawn to the exact quota of a weight column — the row-linked
 * counterpart of `loadWeightedValues`. Returns `count` row indices (into
 * `source.rows`) so every field on the link follows the same weighted rows.
 * Validation mirrors `loadWeightedValues`: an empty weight cell is an error (a
 * blank must not silently become weight 0 and delete the row), a negative or
 * non-numeric weight is an error, and a genuine 0 drops that row.
 */
function weightedRowIndexes(
  source: CsvColumnSource,
  weightColumn: string,
  count: number,
  prng: () => number,
): number[] {
  const weightIndex = resolveCsvColumnIndex(source.headerRow, weightColumn);
  if (weightIndex === source.columnIndex) {
    throw new WeightedFileError(
      `file generator: weight column "${weightColumn}" is the same column as the values`,
    );
  }
  const indices: number[] = [];
  const counts: number[] = [];
  source.rows.forEach((row, i) => {
    const value = csvColumnCell(row, source.columnIndex);
    if (value === '') return;
    const raw = csvColumnCell(row, weightIndex);
    if (raw === '') {
      throw new WeightedFileError(
        `file generator: weight column "${weightColumn}" is empty for value "${value}" ` +
          `— write 0 to exclude it, or fill in the count`,
      );
    }
    const weight = Number(raw);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new WeightedFileError(
        `file generator: weight "${raw}" for value "${value}" is not a non-negative number`,
      );
    }
    if (weight === 0) return;
    indices.push(i);
    counts.push(weight);
  });
  if (indices.length === 0) {
    throw new WeightedFileError(
      `file generator: weight column "${weightColumn}" has no rows with a positive weight`,
    );
  }
  const total = counts.reduce((sum, w) => sum + w, 0);
  const percents = counts.map((w) => (w / total) * 100);
  return distributeByPercent({ count, values: indices, percents, prng });
}
