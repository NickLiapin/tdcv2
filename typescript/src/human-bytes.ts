/**
 * A byte count written the way a person would say it: `800 B`, `2.6 KB`,
 * `123 KB`, `20.5 GB`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every one of the 294 shipped packs is smaller than a quarter of a megabyte —
 * the largest is 248 KB and 120 are under 10 KB. Printed in megabytes to one
 * decimal, as `pack list` did, the whole catalogue collapsed into three
 * strings: `0.0 MB` for 194 packs, `0.1 MB` for 53, `0.2 MB` for the last 47.
 *
 * A size that cannot tell two packs apart is not a size, it is a decoration;
 * and `0.0` actively misinforms, because it reads as "nothing" when the honest
 * answer is "three kilobytes".
 *
 * The rules are the ones people already read without noticing:
 *
 *   - below a kilobyte, whole bytes — `800 B`, never `0.8 KB`
 *   - below a hundred of a unit, one decimal — `2.6 KB` distinguishes packs
 *     that `3 KB` does not
 *   - at a hundred and above, whole numbers — `123 KB`, because a tenth of a
 *     kilobyte there is noise
 *
 * ── Why the arithmetic looks like this ──────────────────────────────────────
 *
 * All five implementations must produce the same string for the same number:
 * a shared CLI fixture compares their output byte for byte, so a size that
 * differs in the last digit is a five-way parity failure. Hence integers
 * throughout — no float division, no `toFixed`, and no reliance on how a
 * language happens to round a half.
 */

/** Kilobyte upwards. Terabytes are the end of it; nothing here measures more. */
const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * `round(n * 10 / d)`, without ever forming `n * 10`.
 *
 * The product overflows a signed 64-bit integer above about 800 petabytes, and
 * leaves the exactly-representable range of a double far sooner than that. This
 * splits the division instead, which is exact for every size any of the five
 * will be handed.
 */
function tenths(n: number, d: number): number {
  const whole = Math.floor(n / d);
  const rest = n - whole * d;
  return whole * 10 + Math.floor((rest * 10 + Math.floor(d / 2)) / d);
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const n = Math.floor(bytes);
  if (n < 1024) return `${String(n)} B`;

  // Climb to the unit the number reads in, and one further when rounding has
  // pushed it to a whole 1024 of that unit — 1023.6 KB is 1.0 MB, and nobody
  // writes the other one.
  let d = 1024;
  let unit: string = UNITS[0];
  let t = tenths(n, d);
  for (const next of UNITS.slice(1)) {
    if (n < d * 1024 && t < 10_235) break;
    d *= 1024;
    unit = next;
    t = tenths(n, d);
  }
  return t < 1000
    ? `${String(Math.floor(t / 10))}.${String(t % 10)} ${unit}`
    : `${String(Math.floor((t + 5) / 10))} ${unit}`;
}
