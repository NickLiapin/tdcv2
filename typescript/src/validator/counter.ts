/**
 * Per-type validation for `<gen type="increment"` / `"decrement">`.
 *
 * Every other generator type has had its checks in a module of its own since
 * they were written; these two stayed behind in `validate.ts` for no reason but
 * the order they were added in. Moved here so the family is complete and the
 * dispatch in `validate.ts` reads as one line per type.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { findAttr, isBlank } from './blank-value.js';

export function checkGenCounter(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  for (const name of ['value', 'step']) {
    const a = findAttr(attrs, name);
    if (!a) continue;
    const raw = attrMap[name] ?? '';
    // Number("") is 0, which is finite — so a blank start used to be read as a
    // start of zero and the column counted 0 1 2 from an attribute that named
    // nothing. Blank is not a number; the four ports already said so.
    const n = Number(raw);
    if (isBlank(raw) || !Number.isFinite(n)) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(a),
        message: `invalid ${name} "${raw}" — expected a number`,
        code: 'TDC090',
      });
    }
  }
}
