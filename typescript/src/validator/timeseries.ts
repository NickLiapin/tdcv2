/**
 * The seasonal attributes on a `<gen type="timeseries">`.
 *
 * A wave is `amplitude·cos(2π·(i − peak)/period)`, and `period`, `amplitude` and
 * `peak_at` describe the SAME waves position by position: `period="7,365"` with
 * `amplitude="120,400"` is a weekly wave 120 tall and a yearly one 400 tall.
 * Lengths that disagree describe no wave anybody can draw, so they are refused
 * rather than half-honoured.
 *
 * `peak_at` names the row the wave is highest on. Without it the peak sits a
 * quarter period in, which is where a plain sine already peaked — and for a year
 * of daily rows that is early April, the one season nobody means by "warmer in
 * summer". It is a ROW, not a shift, because the row is what the author knows:
 * 182 of 365 is the first of July. It is in the same unit as `period`, which is
 * also counted in rows, so the two read as one idea rather than two.
 */

import type { Diagnostic } from '../errors/index.js';
import { attrValueRange } from '../errors/source-map.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

/** The entries of a comma-separated attribute, or [] when it is absent or blank. */
function entries(raw: string | undefined): string[] {
  const text = (raw ?? '').trim();
  return text === '' ? [] : text.split(',').map((piece) => piece.trim());
}

function allNumbers(list: readonly string[]): boolean {
  return list.every((piece) => piece !== '' && Number.isFinite(Number(piece)));
}

export function checkGenTimeseries(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const periods = entries(attrMap['period']);
  const amplitudes = entries(attrMap['amplitude']);
  const peaks = entries(attrMap['peak_at']);

  checkNoiseCorrelation(attrs, attrMap, diagnostics);
  checkWaveLists(attrs, periods, amplitudes, peaks, diagnostics);

  const peakAttr = findAttr(attrs, 'peak_at');
  if (!peakAttr) return;

  const raw = (attrMap['peak_at'] ?? '').trim();
  if (peaks.length === 0 || !allNumbers(peaks)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(peakAttr),
      message: `peak_at="${raw}" is not a number`,
      hint: 'peak_at is the row the seasonal wave peaks on, counted like period= — peak_at="182" over period="365" puts the peak at the first of July. One entry per period=, so period="7,365" takes peak_at="5,182".',
      code: 'TDC252',
    });
    return;
  }

  // A wave needs a length before it can have a highest point. Without `period`
  // there is no wave at all, so `peak_at` would be read by nobody — the silent
  // no-op this whole family of checks exists to refuse.
  if (periods.length === 0 || !allNumbers(periods) || periods.some((p) => Number(p) <= 0)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(peakAttr),
      message: `peak_at="${raw}" has no period= on the same <gen> — there is no wave to place a peak on`,
      hint: 'Add period= (the length of one season, in rows), or remove peak_at=.',
      code: 'TDC253',
    });
  }
}

/**
 * The three seasonal lists have to line up, and every period has to be a length.
 *
 * Both used to be accepted and then half-read: `period="7,365" amplitude="120"`
 * gave the yearly wave an amplitude of zero — a config asking for two seasons and
 * getting one, with nothing said. A `0` among several periods is the same shape:
 * on its own `period="0"` means "no wave", which is a sensible thing to write, but
 * in a list it is a wave with no length beside waves that have one.
 */
function checkWaveLists(
  attrs: readonly AttrContext[],
  periods: readonly string[],
  amplitudes: readonly string[],
  peaks: readonly string[],
  diagnostics: Diagnostic[],
): void {
  if (periods.length === 0 || !allNumbers(periods)) return;

  if (periods.length > 1 && periods.some((p) => Number(p) <= 0)) {
    const attr = findAttr(attrs, 'period');
    if (attr) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(attr),
        message: `period="${periods.join(',')}" lists a season with no length — every period in a list must be above zero`,
        hint: 'period="0" on its own means "no seasonal wave". Among several it is a wave nothing can be drawn from: drop the entry, and its amplitude= with it.',
        code: 'TDC304',
      });
    }
  }

  // One amplitude for several periods is the shorthand for waves of equal height,
  // and is kept: it reads exactly as it looks. Any other mismatch does not.
  for (const [name, list] of [
    ['amplitude', amplitudes],
    ['peak_at', peaks],
  ] as const) {
    if (list.length === 0) continue;
    if (name === 'amplitude' && list.length === 1) continue;
    if (list.length === periods.length) continue;
    const attr = findAttr(attrs, name);
    if (!attr) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `${name}="${list.join(',')}" has ${String(list.length)} entries and period= has ${String(periods.length)} — they describe the same waves`,
      hint:
        name === 'amplitude'
          ? 'One amplitude per period — period="7,365" amplitude="120,400" — or a single amplitude for waves of equal height.'
          : 'One peak_at per period: period="7,365" peak_at="5,182".',
      code: 'TDC304',
    });
  }
}

/**
 * `noise_correlation=` — how much of one row's noise carries into the next.
 *
 * At 1 the noise would stop being noise and become a random walk with no level to
 * return to; at more than 1 it grows without bound. Both are refused rather than
 * clamped, because a config asking for either meant something else.
 */
function checkNoiseCorrelation(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string>,
  diagnostics: Diagnostic[],
): void {
  const attr = findAttr(attrs, 'noise_correlation');
  if (!attr) return;
  const raw = (attrMap['noise_correlation'] ?? '').trim();
  const value = Number(raw);

  if (raw === '' || !Number.isFinite(value) || Math.abs(value) >= 1) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `noise_correlation="${raw}" must be a number between -1 and 1`,
      hint: 'It is how much of one row’s noise carries into the next: 0 is independent noise, 0.8 is strongly correlated. At 1 the series would wander off and never come back.',
      code: 'TDC305',
    });
    return;
  }

  // Correlation of WHAT, when there is nothing to correlate. `noise="0"` and no
  // `noise=` at all both leave this attribute deciding nothing.
  const noise = (attrMap['noise'] ?? '').trim();
  if (value !== 0 && (noise === '' || Number(noise) === 0)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: 'noise_correlation= without noise= — there is no noise to correlate',
      hint: 'Add noise="p" (the strength of the jitter), or remove noise_correlation=.',
      code: 'TDC305',
    });
  }
}
