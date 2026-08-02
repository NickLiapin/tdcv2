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
 * `flagsOut`, when given, records the per-row SELECTION (`draw < p`) so a
 * `anomaly_flag` ground-truth column can mark exactly these rows. It reflects the
 * draw, not whether the value happened to be numeric — anomaly is a numeric-only
 * feature, so for supported gens selected == spiked.
 */
export function applyAnomaly(
  values: string[],
  spec: AnomalySpec,
  prng: () => number,
  flagsOut?: boolean[],
): string[] {
  for (let i = 0; i < values.length; i++) {
    const selected = spec.p > 0 && prng() < spec.p;
    if (flagsOut) flagsOut[i] = selected;
    if (!selected) continue;
    const n = Number(values[i]);
    if (Number.isFinite(n)) values[i] = String(n * spec.factor);
  }
  return values;
}
