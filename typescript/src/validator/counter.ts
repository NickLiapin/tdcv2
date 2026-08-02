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
import type { AttrContext } from '../generated/TDCParser.js';

/** The attribute node by name, so a complaint can point at its value. */
function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  return attrs.find((a) => a._attrName?.text === name);
}

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
    const n = Number(raw);
    if (!Number.isFinite(n)) {
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
