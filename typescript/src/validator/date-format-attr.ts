/**
 * The `format=` of a date column — checked the same way wherever a date is printed.
 *
 * A drawn date and a date measured from another (`of=`/`plus=`) both print through
 * `format=`, and only the drawn one used to have it checked: `format="YYY"` on an
 * offset printed `25Y` on every row and `check` called the file valid. One function,
 * called from both, so the two cannot drift apart again.
 */

import { minutesWithoutClock, validateDateFormat } from '../date/index.js';
import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

export function checkDateFormatAttr(
  attrs: readonly AttrContext[],
  diagnostics: Diagnostic[],
): void {
  const formatAttr = attrs.find((a) => a._attrName?.text === 'format');
  const format = extractAttrs(attrs)['format'];
  if (!formatAttr || format === undefined) return;
  try {
    validateDateFormat(format);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(formatAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket literals [text].',
      code: 'TDC152',
    });
    return;
  }
  const minutes = minutesWithoutClock(format);
  if (minutes === undefined) return;
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...attrValueRange(formatAttr),
    message: `"${minutes}" in format="${format}" is minutes, and nothing else here is a time of day`,
    hint:
      'A date without a time prints minutes as 00 on every row. The month is "MM" (or "M"); ' +
      'if the minutes are meant, put the hour beside them — HH:mm.',
    suggestion: `did you mean "${minutes.toUpperCase()}" (the month)?`,
    code: 'TDC310',
  });
}
