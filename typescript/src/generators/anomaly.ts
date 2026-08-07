/**
 * Anomaly injection — `anomaly="p"` on a numeric `<gen>`.
 *
 * With probability `p` a value is turned into an OUTLIER: multiplied by
 * `anomaly_factor` (default 10), so it lands far outside the normal range. One
 * PRNG draw per row → deterministic and seekable, both engines (same wrapper as
 * `missing`). Useful for stress-testing pipelines and detectors against spikes.
 *
 * v1 injects the outliers; a ground-truth label column (which rows are
 * anomalous) is the next iteration — it needs sequence-level plumbing so a
 * companion `_anomaly` flag stays consistent across both engines.
 */

export interface AnomalySpec {
  /** Probability in [0, 1] a value becomes an outlier. */
  readonly p: number;
  /** Multiplier applied to a value that is selected as an outlier. */
  readonly factor: number;
}

const DEFAULT_FACTOR = 10;

/** Parse `anomaly` / `anomaly_factor`; `undefined` when no `anomaly` is set. Throws on bad input. */
export function parseAnomaly(attrs: Record<string, string | undefined>): AnomalySpec | undefined {
  const raw = attrs['anomaly'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const p = Number(raw);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`anomaly: probability "${raw}" must be a number in [0, 1]`);
  }
  const factorRaw = attrs['anomaly_factor'];
  const factor =
    factorRaw === undefined || factorRaw.trim() === '' ? DEFAULT_FACTOR : Number(factorRaw);
  if (!Number.isFinite(factor)) {
    throw new Error(`anomaly: anomaly_factor "${factorRaw ?? ''}" must be a number`);
  }
  return { p, factor };
}

/**
 * Turn each selected value into an outlier (× `factor`), one PRNG draw per row.
 * Non-numeric values are left untouched (outliers only make sense for numbers).
 * Mutates and returns `values`.
 *
 * `flagsOut`, when given, records what ACTUALLY HAPPENED to the row, so an
 * `anomaly_flag` column is ground truth rather than a record of intent.
 *
 * It used to record the SELECTION (`draw < p`) on the reasoning that anomaly is a
 * numeric-only feature, so selected == spiked. That holds only for the gens whose
 * output is numeric by construction. A `type="template"` column of surnames is
 * selected like any other and then left alone here — and came out flagged `true`
 * beside an untouched ordinary name, while the page promised the flag and the
 * spike "can never disagree". A label that marks a row nothing happened to is
 * worse than no label: it is training data for an anomaly detector, and every
 * such row teaches it something false.
 *
 * `draw` is asked for the uniform of row i rather than for "the next" one: the
 * streaming engine derives it from the row, and the in-memory engine passes a
 * closure over its own PRNG. Same rows selected either way.
 */
export function applyAnomaly(
  values: string[],
  spec: AnomalySpec,
  draw: (i: number) => number,
  flagsOut?: boolean[],
): string[] {
  for (let i = 0; i < values.length; i++) {
    // The draw is asked for on every row whether or not it is used, so the
    // stream stays aligned: a column that skipped the draw on its text rows
    // would give different values to every row after the first one.
    const selected = spec.p > 0 && draw(i) < spec.p;
    const n = selected ? Number(values[i]) : Number.NaN;
    const spiked = selected && Number.isFinite(n);
    if (flagsOut) flagsOut[i] = spiked;
    if (spiked) values[i] = String(n * spec.factor);
  }
  return values;
}
