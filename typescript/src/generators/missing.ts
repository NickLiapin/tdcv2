/**
 * Missing-data injection — `missing="p"` on any `<gen>`.
 *
 * MCAR (Missing Completely At Random): each value is independently blanked with
 * probability `p`, drawing once per row from the same PRNG the generator uses —
 * so it is deterministic and seekable, and works in both the in-memory and
 * streaming engines. The blank is an empty string by default, or the
 * `missing_as="..."` token (e.g. `NULL`, `NA`).
 *
 * Real datasets are rarely complete; sprinkling in blanks lets you test how
 * downstream code handles gaps.
 */

export interface MissingSpec {
  /** Probability in [0, 1] that a value is blanked. */
  readonly p: number;
  /** Replacement for a blanked value (default empty string). */
  readonly token: string;
}

/** Parse `missing` / `missing_as`; `undefined` when no `missing` is set. Throws on a bad probability. */
export function parseMissing(attrs: Record<string, string | undefined>): MissingSpec | undefined {
  const raw = attrs['missing'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const p = Number(raw);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`missing: probability "${raw}" must be a number in [0, 1]`);
  }
  return { p, token: attrs['missing_as'] ?? '' };
}

/** Blank each value with probability `spec.p`, one PRNG draw per row. Mutates and returns `values`. */
export function applyMissing(values: string[], spec: MissingSpec, prng: () => number): string[] {
  if (spec.p <= 0) return values; // no draws when nothing can go missing
  for (let i = 0; i < values.length; i++) {
    if (prng() < spec.p) values[i] = spec.token;
  }
  return values;
}
