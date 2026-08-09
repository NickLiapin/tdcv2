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
    const original = values[i] ?? '';
    const n = selected ? Number(original) : Number.NaN;
    const spiked = selected && Number.isFinite(n);
    if (flagsOut) flagsOut[i] = spiked;
    if (spiked) values[i] = keepShape(original, n * spec.factor);
  }
  return values;
}

/**
 * The spike keeps the SHAPE of the value it replaced.
 *
 * Multiplying and re-stringifying threw away everything the column had already
 * been rendered with — the zero padding `length=` asked for, and the decimal
 * places `decimals=` asked for — so the outlier rows were the only ones in the
 * file with a different shape:
 *
 *     length="5"    00014 00046 00053 …  and then  117
 *     decimals="2"  85.66 40.97 11.52 …  and then  6.445
 *
 * That is worse than it looks. A column of fixed-width identifiers stops being
 * fixed width on exactly the rows a test is about to exercise, and a column
 * declared with `decimals` is typed a float in Parquet — a spike with a third
 * place is a value the declared type never promised. An outlier is meant to be
 * far from the others in VALUE, not in format.
 *
 * So: the same number of decimal places, and at least the same digit width. The
 * padding only ever adds, so a spike that genuinely outgrew the width keeps its
 * extra digits — which is the whole point of one.
 */
export function keepShape(original: string, spiked: number): string {
  const dot = original.indexOf('.');
  const places = dot < 0 ? 0 : original.length - dot - 1;

  // Rounded on the SCALED integer, half away from zero, rather than by handing
  // an arbitrary product to a host formatter: `round` already means that
  // everywhere else in TDC, and it is the one rule all five spell the same.
  const scale = 10 ** places;
  const scaled = spiked * scale;
  const rounded = scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5);
  const text = (rounded / scale).toFixed(places);

  // Only a value that was ZERO-PADDED has a width to preserve. `12.89` is five
  // characters wide because the number is, not because the column asked for
  // five, and padding its spike to five would invent an `06.45`.
  const bare = original.startsWith('-') ? original.slice(1) : original;
  const wholePart = dot < 0 ? bare : bare.slice(0, bare.indexOf('.'));
  if (!wholePart.startsWith('0') || wholePart.length < 2) return text;

  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const cut = body.indexOf('.');
  const whole = cut < 0 ? body : body.slice(0, cut);
  const rest = cut < 0 ? '' : body.slice(cut);
  return (negative ? '-' : '') + whole.padStart(wholePart.length, '0') + rest;
}
