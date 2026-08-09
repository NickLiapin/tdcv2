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

/**
 * `if=` on a named `<data>`, or on the `<line>` holding one.
 *
 * A named `<data>` declares a typed output COLUMN, and a column has one cell per
 * card — the columnar writer collects it once per row and never asks whether the
 * line was rendered. So the condition was simply dropped, and the typed file
 * disagreed with the text rendering of the same config:
 *
 *     text        1  /  X  /  2  /  3  /  4END
 *     parquet     id=[1,2,3,4]  tail=['END','END','END','END']
 *                               only_first=['X','X','X','X']
 *
 * `each=` on a line holding a named `<data>` is refused one function over
 * (TDC209) for exactly this reason — "typed columns are collected once per
 * card". This is the same sentence about a different attribute.
 *
 * The working spelling is to put the condition on the SEQUENCE rather than on
 * the column: a `<gen if="…">` that produces nothing leaves the cell empty, and
 * an empty cell in a nullable column is a NULL — which is what a missing value
 * means in a typed file.
 */
export const CONDITIONAL_COLUMN_HINT =
  'A column has one cell per card, collected whether or not the line was rendered — the ' +
  'condition would be dropped and the typed file would disagree with the text one. Put the ' +
  'condition on the sequence instead (<gen if="…">) and declare the column nullable: an ' +
  'empty cell in a nullable column is a NULL.';

export function checkDataColumnConditional(
  attrList: readonly AttrContext[],
  dAttrs: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  const name = (dAttrs['name'] ?? '').trim();
  if (name === '' || dAttrs['if'] === undefined) return;
  const attr = findAttr(attrList, 'if');
  if (!attr) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message: `<data name="${name}"> declares a typed column, so its if= cannot be honoured`,
    hint: CONDITIONAL_COLUMN_HINT,
    code: 'TDC209',
  });
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
