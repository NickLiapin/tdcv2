/**
 * Validation for `type="…"` on a `<data>` — the typed output column.
 *
 * Caught at LOAD time rather than partway through writing a file: a bad type
 * discovered mid-write leaves a truncated .parquet behind, and the message
 * would point at a row instead of at the config.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';
import { parseOutputColumnType } from '../output/column-type.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export function checkDataColumnType(
  attrList: readonly AttrContext[],
  dAttrs: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  // `type=` declares a typed output column (see the Parquet writer). Catch a
  // bad type at LOAD time rather than partway through writing a file.
  const rawType = dAttrs['type'];
  if (rawType !== undefined) {
    const typeA = findAttr(attrList, 'type');
    try {
      parseOutputColumnType(rawType);
      const named = (dAttrs['name'] ?? '').trim() !== '';
      if (!named && typeA) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...attrValueRange(typeA),
          message: `type="${rawType}" has no name — only a named <data> becomes a column`,
          hint: 'Add name="…" to export this as a typed column, or drop type=.',
          code: 'TDC194',
        });
      }
    } catch (error) {
      if (typeA) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...attrValueRange(typeA),
          message: error instanceof Error ? error.message : String(error),
          hint:
            'Supported: bool, int32, int64, double, string, date, timestamp, decimal(p,s), uuid, json ' +
            '— plus |null, and []T for a list (e.g. []int64, []string|null).',
          code: 'TDC194',
        });
      }
    }
  }
}
