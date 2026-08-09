/**
 * Validation for `each="NAME"` on a `<line>`.
 *
 * `each` walks a list, and there are exactly two ways to get it wrong: name
 * something that is not a sequence, or name a sequence that holds no list.
 * Both would render silently as zero lines — the child table would simply come
 * out empty, with no error anywhere, which is the failure mode this project
 * keeps refusing to ship.
 * Spec: docs/specs/2026-07-19-each-repeating-a-line-per-list-element.md §4
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import { CONDITIONAL_COLUMN_HINT } from './column-type.js';
import type { AttrContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind, extractDataAttrs, extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export interface EachContext {
  /** Sequence names declared in the env. */
  readonly declared: readonly string[];
  /** Of those, the ones whose generator repeats — the only walkable ones. */
  readonly repeating: readonly string[];
}

export function checkLineEach(
  lineEl: OpenCloseElementContext,
  ctx: EachContext,
  diagnostics: Diagnostic[],
): void {
  const attr = findAttr(lineEl.attr(), 'each');
  if (!attr) return;
  const name = (extractAttrs(lineEl.attr())['each'] ?? '').trim();

  if (name === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: 'each="" names no sequence',
      hint: 'Point it at a repeating sequence: <line each="Orders">.',
      code: 'TDC206',
    });
    return;
  }

  if (!ctx.declared.includes(name)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `each="${name}" — no sequence with that name`,
      hint: 'The name must match a <sequence name="…"> declared in <env>.',
      code: 'TDC206',
    });
    return;
  }

  if (!ctx.repeating.includes(name)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `each="${name}" — that sequence holds one value, not a list`,
      hint: `Add repeat= to its <gen>, e.g. <gen … repeat="1..5"/>, or drop each=.`,
      code: 'TDC207',
    });
    return;
  }

  // A named <data> is a typed output column. The columnar path collects those
  // per CARD and knows nothing about a line rendered several times, so the
  // column would silently take only one element.
  for (const el of contentElements(lineEl.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'data') continue;
    const columnName = extractDataAttrs(k.node)['name'];
    if (columnName === undefined || columnName.trim() === '') continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `a named <data name="${columnName}"> cannot sit inside an each= line`,
      hint:
        'Typed columns are collected once per card. For columnar output keep the list ' +
        'as a list column (type="[]…"); each= is for text and SQL.',
      code: 'TDC209',
    });
    return;
  }
}

/** The same rule one level up: a conditional `<line>` that holds a typed column. */
export function checkLineConditionalColumns(
  lineEl: OpenCloseElementContext,
  lineIf: AttrContext,
  diagnostics: Diagnostic[],
): void {
  for (const el of contentElements(lineEl.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'data') continue;
    const name = (extractDataAttrs(k.node)['name'] ?? '').trim();
    if (name === '') continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(lineIf),
      message: `<line if="…"> holds the typed column <data name="${name}">, so the condition cannot be honoured`,
      hint: CONDITIONAL_COLUMN_HINT,
      code: 'TDC209',
    });
    return;
  }
}
