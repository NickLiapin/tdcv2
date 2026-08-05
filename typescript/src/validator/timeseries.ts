/**
 * `peak_at=` on a `<gen type="timeseries">`.
 *
 * A seasonal wave is `amplitude·cos(2π·(i − peak)/period)`, so `peak_at` names
 * the row the wave is highest on. Without it the peak sits a quarter period in,
 * which is where a plain sine already peaked — and for a year of daily rows that
 * is early April, the one season nobody means by "warmer in summer".
 *
 * `peak_at` is a ROW, not a shift, because the row is what the author knows: 182
 * of 365 is the first of July. It is in the same unit as `period`, which is also
 * counted in rows, so the two read as one idea rather than two.
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

export function checkGenTimeseries(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const peakAttr = findAttr(attrs, 'peak_at');
  if (!peakAttr) return;

  const raw = (attrMap['peak_at'] ?? '').trim();
  if (raw === '' || !Number.isFinite(Number(raw))) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(peakAttr),
      message: `peak_at="${raw}" is not a number`,
      hint: 'peak_at is the row the seasonal wave peaks on, counted like period= — peak_at="182" over period="365" puts the peak at the first of July.',
      code: 'TDC252',
    });
    return;
  }

  // A wave needs a length before it can have a highest point. Without `period`
  // there is no wave at all, so `peak_at` would be read by nobody — the silent
  // no-op this whole family of checks exists to refuse.
  const period = Number((attrMap['period'] ?? '').trim());
  if ((attrMap['period'] ?? '').trim() === '' || !Number.isFinite(period) || period <= 0) {
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
