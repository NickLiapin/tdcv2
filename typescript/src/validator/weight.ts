/**
 * Validation for `weight="column"` on `<gen type="file">`.
 *
 * Every case below would otherwise fail late and confusingly — at generation
 * time, from inside a CSV reader, pointing at a line rather than at the config.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
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

export function checkGenWeight(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const map = extractAttrs(attrs);
  const weight = findAttr(attrs, 'weight');
  if (!weight || (map['weight'] ?? '').trim() === '') return;

  if (map['type'] !== 'file') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(weight),
      message: `"weight" applies to <gen type="file">, not type="${map['type'] ?? ''}"`,
      hint: 'For inline values the equivalent is percent=. weight= reads the shares from a CSV column.',
      code: 'TDC211',
    });
    return;
  }

  if ((map['column'] ?? '').trim() === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(weight),
      message: '"weight" needs "column" — the weights live in a second CSV column',
      hint: 'Name both: column="name" weight="count".',
      code: 'TDC212',
    });
    return;
  }

  // `order="sequential"` walks rows by position — there is no place for a share
  // to be honoured, so it stays incompatible. (`row=` composes fine: it says which
  // fields SHARE a row, not how the row is chosen; the row-linked plan is drawn to
  // the weighted quota. That runs on the in-memory engine — see resolveRenderEngine.)
  if ((map['order'] ?? '').trim() !== '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(weight),
      message:
        '"weight" cannot be combined with "order" — that walks rows by position, not by share',
      hint: `Drop one of them.`,
      code: 'TDC213',
    });
  }
}
