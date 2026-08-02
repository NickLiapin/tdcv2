/**
 * Validation for the positional index syntax of `mask="…"` — see
 * docs/specs/2026-07-23-mask-positional-reordering.md.
 *
 * A mask is lenient everywhere else on purpose: too few characters simply leave
 * a slot empty, because the input length is unknown until render time. A
 * malformed INDEX is a different thing — it is a typo, most likely `x[1-2]`
 * written from habit, and left alone it would abort mid-render with no position
 * to point at. Catching it here costs one parse of a string that is already
 * known at validation time.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import { applyMask } from '../format/transforms.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export function checkGenMask(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const maskAttr = findAttr(attrs, 'mask');
  if (!maskAttr) return;
  const pattern = extractAttrs(attrs)['mask'] ?? '';
  try {
    // The empty input is enough: parsing happens before anything is consumed.
    applyMask(pattern, '');
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(maskAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Indices are 0-based; ranges use "..", e.g. mask="x[0..3]" or mask="w[-1], w[0]".',
      code: 'TDC199',
    });
  }
}
