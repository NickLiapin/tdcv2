/**
 * Per-type validation for `<gen type="text">`.
 *
 * Every other generator type has had its checks in a module of its own since
 * they were written; these two stayed behind in `validate.ts` for no reason but
 * the order they were added in. Moved here so the family is complete and the
 * dispatch in `validate.ts` reads as one line per type.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { PercentMaskError, expandPercentMask } from '../distribution/index.js';
import type { AttrContext } from '../generated/TDCParser.js';

/** The attribute node by name, so a complaint can point at its value. */
function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  return attrs.find((a) => a._attrName?.text === name);
}

export function checkGenText(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  checkSequentialDropsPercent(gen, diagnostics);
  const valueAttr = findAttr(attrs, 'value');
  if (!valueAttr) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="text"> requires a "value" attribute',
      hint: 'Provide comma-separated values, e.g. value="Male,Female".',
      code: 'TDC050',
    });
    return;
  }
  const values = (attrMap['value'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const percentAttr = findAttr(attrs, 'percent');
  if (!percentAttr) return;
  try {
    expandPercentMask(attrMap['percent'] ?? '', values.length);
  } catch (err) {
    if (!(err instanceof PercentMaskError)) throw err;
    const code = err.kind === 'length' ? 'TDC051' : err.kind === 'number' ? 'TDC052' : 'TDC053';
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(percentAttr),
      message: err.message,
      hint:
        err.kind === 'length'
          ? 'Percent masks may be shorter than value only when missing positions can be inferred. They may never be longer than value.'
          : 'Filled positions must be non-negative numbers. Empty positions split the remaining percent equally.',
      code,
    });
  }
}

/**
 * `percent=` on a generator that walks its list in order — accepted, and read by
 * nothing.
 *
 * `order="sequential"` gives row r element `r mod N`, which is a rule about
 * POSITION and leaves no room for a rule about SHARE. The engine's own comment
 * says so ("ignoring the random pick and any percent"), and nothing told the
 * user: `percent="98,1,1"` over a hundred rows came out 34 / 33 / 33 from a
 * config `check` had called valid, which is the shape of the request answered
 * by its exact opposite.
 *
 * Shared by `type="text"` and `type="file"` — both walk a list, and both
 * dropped the shares the same way.
 */
export function checkSequentialDropsPercent(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  if ((attrMap['order'] ?? '').trim() !== 'sequential') return;
  const percentAttr = findAttr(attrs, 'percent');
  if (!percentAttr) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(percentAttr),
    message: `percent="${attrMap['percent'] ?? ''}" is not read beside order="sequential": walking the list in order fixes which value each row gets, so there is no share left to apportion`,
    hint: 'Drop order="sequential" to have the shares apportioned exactly, or drop percent= and take the values in the order they are written — each one as often as the others.',
    code: 'TDC271',
  });
}
