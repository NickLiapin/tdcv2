/**
 * Validation for `repeat` / `separator` on a `<gen>`.
 *
 * Runs for EVERY generator type, not just one, because the important check is
 * whether this type can carry `repeat` at all. Refusing here — before anything
 * is generated — is what keeps the two engines honest: the in-RAM builder could
 * happily repeat a counter, the streaming one cannot, and a config that quietly
 * means different things in different engines is worse than a rejected one.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';
import { RepeatError, parseRepeat, repeatUnsupportedReason } from '../sequence/repeat.js';
import { ACCUMULATE_OPS, AccumulateError, parseAccumulate } from '../sequence/accumulate.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export function checkGenRepeat(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const repeatAttr = findAttr(attrs, 'repeat');
  const separatorAttr = findAttr(attrs, 'separator');
  const accumulateAttr = findAttr(attrs, 'accumulate');

  // The op is checked whether or not `repeat` is there: a misspelling is worth
  // naming even on a config that has a second problem.
  if (accumulateAttr) {
    try {
      parseAccumulate(attrMap);
    } catch (err) {
      if (!(err instanceof AccumulateError)) throw err;
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(accumulateAttr),
        message: err.message,
        hint: `accumulate= keeps a running total across a repeat list. One of: ${ACCUMULATE_OPS.join(', ')}.`,
        code: 'TDC238',
      });
    }
    // `type="running"` accumulates down a COLUMN, so it carries the same word
    // with no list in sight. Only the list flavour needs `repeat`.
    if (!repeatAttr && attrMap['type'] !== 'running') {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(accumulateAttr),
        message: '"accumulate" has no effect without "repeat"',
        hint:
          'accumulate= turns the values of a repeat list into a running total, so there has to ' +
          'be a list. Add repeat="N", or drop accumulate=.',
        code: 'TDC237',
      });
    }
  }

  if (!repeatAttr) {
    if (separatorAttr) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(separatorAttr),
        message: '"separator" has no effect without "repeat"',
        hint: 'separator joins the values a repeating gen produces. Add repeat="N" or repeat="A..B".',
        code: 'TDC198',
      });
    }
    return;
  }

  try {
    parseRepeat(attrMap);
  } catch (err) {
    if (!(err instanceof RepeatError)) throw err;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(repeatAttr),
      message: err.message,
      hint: 'Use repeat="3" for a fixed count or repeat="1..5" for a range (0 to 64).',
      code: 'TDC195',
    });
    return;
  }

  const reason = repeatUnsupportedReason(attrMap['type'] ?? '');
  if (reason !== undefined) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(repeatAttr),
      message: `"repeat" is not supported on <gen type="${attrMap['type'] ?? ''}"> — ${reason}`,
      hint:
        'Repeat works on generators that draw each value independently: number, symbol, regex, ' +
        'advanced_regex, date, template, file. For a list of words, draw them with regex or ' +
        'symbol, or build the list with several sequences.',
      code: 'TDC204',
    });
  }
}

/**
 * `repeat` belongs to a `<gen>`, which produces values. A `<mix>` CHOOSES one
 * of its branches, so repeating it has no defined meaning and the runtime
 * ignores the attribute — the silent-and-wrong outcome this project keeps
 * refusing to ship. Flag it instead.
 */
export function checkMixRepeat(mixEl: OpenCloseElementContext, diagnostics: Diagnostic[]): void {
  for (const name of ['repeat', 'separator'] as const) {
    const attr = findAttr(mixEl.attr(), name);
    if (!attr) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `"${name}" is not supported on <mix> — it picks one branch, it does not produce a list`,
      hint: 'Put repeat= on the <gen> inside a <case>, or on a plain <sequence>.',
      code: 'TDC196',
    });
  }
}
