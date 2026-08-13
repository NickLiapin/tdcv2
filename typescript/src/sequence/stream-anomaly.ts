/**
 * `missing=` and `anomaly=` for the streaming engines, and the `anomaly_flag`
 * column that goes with them.
 *
 * Split out of `stream-build.ts` because it is a self-contained node: the
 * per-row modifier that rewrites a value, and the companion column that says
 * what happened to it. The two have to agree exactly — the anomalies guide
 * promises the flag and the spike "can never disagree" — so keeping them side
 * by side is the point rather than an accident of size.
 */

import { keepShape, parseAnomaly } from '../generators/anomaly.js';
import { parseMissing } from '../generators/missing.js';
import { genFormatter } from '../format/transforms.js';
import { seekableUniforms } from '../prng/seekable.js';

import type { SequenceBuildOptions } from './build.js';
import { resolveGenAnomalyFlagTextAt } from './gen-resolve.js';
import { INLINE_ANOMALY_TYPES } from './per-row.js';
import { lazy } from './stream-lazy.js';
import type { Domain } from './stream-build.js';
import type { GenSpec, Sequence } from './types.js';

/**
 * A seekable per-row `missing`/`anomaly` modifier, or null if the gen sets
 * neither. The inline-built types (counters, timeseries, pattern, text) don't
 * route through `buildGenValues`, so they apply this to match the in-memory
 * engine. Each modifier draws one uniform on its OWN dedicated seekable stream
 * — deterministic, seekable, and independent of value generation.
 */
export function missingAnomalyMod(
  gen: GenSpec,
  seed: string,
  streamId: string,
  elementDraws = 1,
): ((i: number, v: string | undefined, k?: number) => string | undefined) | null {
  const anomaly = parseAnomaly(gen.attrs);
  const missing = parseMissing(gen.attrs);
  const hasAnomaly = anomaly !== undefined && anomaly.p > 0;
  const hasMissing = missing !== undefined && missing.p > 0;
  const fmt = genFormatter(gen.attrs['mask'], gen.attrs['case']);
  if (!hasAnomaly && !hasMissing && !fmt) return null;

  // With `repeat` a row needs one draw PER ELEMENT, so the whole row's draws
  // are pulled at once and indexed by `k`. Elements of a row arrive
  // consecutively, so a one-entry memo makes that a single pull per row rather
  // than one per element. `elementDraws = 1` reproduces the pre-repeat stream
  // exactly: seekableUniforms pulls sequentially, so [0] never depends on how
  // many were asked for.
  let cachedRow = -1;
  let anomDraws: number[] = [];
  let missDraws: number[] = [];
  const drawsFor = (i: number): void => {
    if (cachedRow === i) return;
    cachedRow = i;
    anomDraws = hasAnomaly ? seekableUniforms(seed, `${streamId}#anom`, i, elementDraws) : [];
    missDraws = hasMissing ? seekableUniforms(seed, `${streamId}#miss`, i, elementDraws) : [];
  };

  return (i, v, k = 0) => {
    if (v === undefined) return undefined; // an inactive row stays inactive
    drawsFor(i);
    let out = v;
    if (anomaly && hasAnomaly && (anomDraws[k] ?? 1) < anomaly.p) {
      const n = Number(out);
      // `keepShape`, not `String(...)`: the spike keeps the decimal places and
      // the zero padding of the value it replaced. Without it the outlier rows
      // were the only ones in the file with a different shape — `00042` spiking
      // to `294`, `19.99` to `199.89999999999998` — and the in-memory engine,
      // which has always shared this helper, disagreed with the streaming one.
      if (Number.isFinite(n)) out = keepShape(out, n * anomaly.factor);
    }
    if (missing && hasMissing && (missDraws[k] ?? 1) < missing.p) {
      out = missing.token;
    }
    return fmt ? fmt(out) : out;
  };
}

/**
 * Build the `anomaly_flag="NAME"` companion column for a streaming simple gen, or
 * null when there is no flag. It mirrors HOW `build()` applies anomaly so the flag
 * agrees with the value on every row: inline types use the seekable `#anom` draw
 * (same as `missingAnomalyMod`); independent types re-run the per-row build via
 * `resolveGenAnomalyFlagAt`. Parent-filtered rows are `undefined`.
 */
export function anomalyFlagSequence(
  gen: GenSpec,
  seed: string,
  streamId: string,
  domain: Domain,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
  rawAt?: RawAt,
): { name: string; sequence: Sequence } | null {
  const name = gen.attrs['anomaly_flag'];
  if (name === undefined || name.trim() === '') return null;
  const anomaly = parseAnomaly(gen.attrs);
  if (!anomaly) return null;
  const { popIndexAt } = domain;
  const p = anomaly.p;
  // Independent gens resolve the label as TEXT, because with `repeat` it is a
  // LIST parallel to the value list — a single boolean could not say which
  // element of the batch spiked. Inline types never carry `repeat` (the
  // validator refuses it), so their single draw stays a plain boolean.
  // The flag records what HAPPENED to the row, not what was selected. Selection
  // is only half of it: a spike replaces a NUMBER, so a selected text value is
  // left exactly as it was. Recording the selection marked such rows `true`
  // beside an untouched value — and the anomalies page promises the flag and the
  // spike "can never disagree". A label on a row nothing happened to is worse
  // than no label: it is training data for a detector, and every such row
  // teaches it something false. The in-memory engine has recorded the outcome
  // since `applyAnomaly` was written; this is the streaming twin.
  //
  // `rawAt` is the value BEFORE the modifier ran. It has to be the raw one: once
  // `missing=` has blanked a cell, a text value and a spiked number look alike.
  // A cell `missing=` blanked has no spike left to label. The independent types
  // get this from the in-memory builder they share; the inline ones decide here,
  // so the same rule has to be written down twice. Without it the pairing the
  // anomalies page recommends — `anomaly` beside `missing` — wrote `true` next to
  // an empty cell, and the two engines disagreed about it as well.
  const missing = parseMissing(gen.attrs);
  const blanked =
    missing && missing.p > 0
      ? (i: number): boolean =>
          (seekableUniforms(seed, `${streamId}#miss`, i, 1)[0] ?? 1) < missing.p
      : (): boolean => false;
  const decide = INLINE_ANOMALY_TYPES.has(gen.type)
    ? (i: number): string =>
        !blanked(i) &&
        (seekableUniforms(seed, `${streamId}#anom`, i, 1)[0] ?? 1) < p &&
        Number.isFinite(Number(rawAt ? rawAt(i) : Number.NaN))
          ? 'true'
          : 'false'
    : (i: number): string =>
        resolveGenAnomalyFlagTextAt(gen, i, seed, streamId, locale, now, options);
  const sequence = lazy(name, (i) => (popIndexAt(i) === undefined ? undefined : decide(i)));
  return { name, sequence };
}

/**
 * The value a gen produced for row `i` BEFORE `anomaly=`/`missing=`/`mask=`
 * touched it. Only the inline types publish one, and only `anomaly_flag` reads
 * it — to answer "was this row actually spiked?", which needs the raw value:
 * after the fact a blanked cell and a text cell look alike.
 */
export type RawAt = (i: number) => string | undefined;
