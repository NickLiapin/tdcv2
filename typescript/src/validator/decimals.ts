/**
 * `decimals=` on a `number` range and on a `timeseries`: a whole number from 0 to 10.
 *
 * The rule the documentation always stated, now checked where the config is read. Until it,
 * a range's `decimals="17"` stopped the run in three implementations and printed in the other
 * two — `6.93276863731443840` in Rust, `…882` in C# — and a `timeseries` took any count at
 * all, printing the binary tail of a double as if it were data. `formula` (TDC294), `stat`
 * (TDC262) and a distribution (TDC089) already refused out-of-range values under their own
 * codes. Found by the article agent.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';

/** Refuse a `decimals=` that is not a whole number from 0 to 10. */
export function checkDecimalsAttr(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  const attr = attrs.find((a) => a._attrName?.text === 'decimals');
  if (!attr) return;
  const raw = (attrMap['decimals'] ?? '').trim();
  if (raw === '') return;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 10 && /^\d+$/.test(raw)) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message: `decimals="${raw}" is not a whole number from 0 to 10`,
    hint:
      'decimals= is how many digits follow the point. Past ten they are the binary tail of a ' +
      'double, not data — and two implementations print that tail differently.',
    code: 'TDC316',
  });
}
