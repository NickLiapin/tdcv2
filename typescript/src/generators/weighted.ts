/**
 * `weight="column"` — take the proportions from the FILE instead of the config.
 *
 * Without it a list is drawn uniformly, so `Smith` and `Zabrowski` appear
 * equally often. Real distributions are never flat: the top US surnames cover a
 * large share of the population while the tail is vanishingly rare, and a
 * dataset that flattens that is the first thing an analyst notices.
 *
 * The proportions are honoured EXACTLY, not on average — the same Hamilton
 * machinery `percent=` uses. Weights `20000` and `10000` over 30 000 rows give
 * precisely 20 000 and 10 000, not "about twice as many".
 *
 * A weight is a raw COUNT, not a percentage: census and SSA files publish
 * occurrence counts, and asking a user to normalise them by hand would be a
 * pointless invitation to arithmetic errors.
 * Spec: docs/specs/2026-07-19-en-us-pack-structure.md
 */

import { loadCsvColumnSource, csvColumnCell, resolveCsvColumnIndex } from './file.js';
import type { FileSourceOptions } from './file.js';

export class WeightedFileError extends Error {
  public override readonly name = 'WeightedFileError';
}

export interface WeightedValues {
  readonly values: string[];
  /** Share of the total, in percent — what the Hamilton path expects. */
  readonly percents: number[];
}

/** The `weight` attribute, or undefined when the column is not weighted. */
export function weightColumnOf(attrs: Record<string, string | undefined>): string | undefined {
  const raw = attrs['weight'];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/**
 * Read value and weight columns side by side and turn the counts into percents.
 *
 * Rows whose weight is zero are DROPPED rather than kept at zero probability:
 * a value that can never appear only costs the distribution machinery memory,
 * and census files carry plenty of them.
 */
export function loadWeightedValues(
  path: string,
  options: FileSourceOptions,
  weightColumn: string,
): WeightedValues {
  const source = loadCsvColumnSource(path, options);
  // Resolve against the ORIGINAL header: `rows` may already have it stripped,
  // and its first entry would then be data.
  const weightIndex = resolveCsvColumnIndex(source.headerRow, weightColumn);

  if (weightIndex === source.columnIndex) {
    throw new WeightedFileError(
      `file generator: weight column "${weightColumn}" is the same column as the values`,
    );
  }

  const values: string[] = [];
  const counts: number[] = [];
  let total = 0;

  for (const [index, row] of source.rows.entries()) {
    const value = csvColumnCell(row, source.columnIndex);
    // The same refusal the plain path makes, for the same reason: skipping the
    // row takes it out of the run entirely, and a value that vanished because
    // one cell in the export was blank is discovered far too late. The weight
    // beside it has been refused on those grounds since this was written.
    if (value === '') {
      throw new WeightedFileError(
        `file generator: column "${source.column}" is empty on value row ${String(index + 1)} ` +
          '— a blank cell would drop that row from the values and quietly change the ' +
          'proportions. Fill it in, remove the row, or point column= at a complete column',
      );
    }
    const raw = csvColumnCell(row, weightIndex);
    // An empty cell must not slide through as a weight of zero. `Number('')`
    // is 0, which would silently DELETE the value from the run — a product
    // that vanishes from the catalogue because one cell in the export was
    // blank is discovered far too late. Missing data and a deliberate zero
    // are different statements, and only the second one is actionable.
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
    if (weight === 0) continue; // never drawn — no reason to carry it
    values.push(value);
    counts.push(weight);
    total += weight;
  }

  if (values.length === 0) {
    throw new WeightedFileError(
      `file generator: no values with a positive weight in column "${weightColumn}"`,
    );
  }

  return { values, percents: counts.map((c) => (c / total) * 100) };
}

/**
 * A weighted data-list pack as {values, percents}, or undefined when the pack
 * is absent or unweighted.
 *
 * Shared by BOTH engines so a weighted pack is drawn identically to a weighted
 * `text` or `file=` — the in-memory builder hands it to `distributeByPercent`,
 * the streaming builder into its slot machinery. Kept here, next to the other
 * weighted sources, so neither engine grows its own copy of the shape.
 */
export function weightedPackValues(
  entry:
    | { values?: readonly string[] | undefined; percents?: readonly number[] | undefined }
    | undefined,
): { values: string[]; percents: number[] } | undefined {
  if (!entry?.values || !entry.percents) return undefined;
  return { values: [...entry.values], percents: [...entry.percents] };
}
