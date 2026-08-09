/**
 * Everything checked on one `<data>` in a `<block>`.
 *
 * Lives apart from `validate.ts` because that file is at its 1000-line ceiling,
 * and because this is a coherent unit on its own: the interpolation filters, the
 * typed-column declaration, and the row condition are the three things a `<data>`
 * can get wrong.
 */

import type { Diagnostic } from '../errors/index.js';
import type { AttrContext, DataElementContext } from '../generated/TDCParser.js';
import { extractDataAttrs, extractDataText } from '../processor/walk.js';

import { checkDataColumnConditional, checkDataColumnType } from './column-type.js';
import { checkInterpolationFilters } from './data-refs.js';
import { checkIfExpression } from './expr-check.js';

/**
 * What this needs from the validator's context — declared structurally so the
 * check does not have to import the Ctx class and create a cycle.
 */
export interface DataCheckSink {
  readonly diagnostics: Diagnostic[];
  readonly inject: string;
  rememberExpression(attr: AttrContext, expr: string, eachBuiltins?: readonly string[]): void;
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

/**
 * Flag unknown filters in `${{ name | filter | … }}`. Only runs for the default
 * `${{%}}` inject (custom delimiters are left unchecked, and any `${{…|…}}` under
 * the default IS a real interpolation, so there are no false positives).
 */
export function checkData(
  data: DataElementContext,
  ctx: DataCheckSink,
  eachBuiltins: readonly string[] = [],
): void {
  checkInterpolationFilters(extractDataText(data), data, ctx.inject, ctx.diagnostics);
  const dAttrs = extractDataAttrs(data);
  // Find the attribute contexts so diagnostics point at the exact attribute.
  const node = data as unknown as { attr?: () => AttrContext[] };
  const attrList = typeof node.attr === 'function' ? node.attr() : [];

  checkDataColumnType(attrList, dAttrs, ctx.diagnostics);
  checkDataColumnConditional(attrList, dAttrs, ctx.diagnostics);

  if (dAttrs['if'] === undefined) return;
  const ifA = findAttr(attrList, 'if');
  if (ifA) {
    checkIfExpression(ifA, dAttrs['if'], ctx);
    ctx.rememberExpression(ifA, dAttrs['if'], eachBuiltins);
  }
}
