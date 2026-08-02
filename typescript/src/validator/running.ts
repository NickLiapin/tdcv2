/**
 * Validation for `<gen type="running">` — a total that carries down a column.
 *
 * Two things have to hold before the engine ever sees it, and neither is
 * discoverable from the row it stands on:
 *
 *   - it has to say WHAT to accumulate (`of=`) and HOW (`accumulate=`);
 *   - the column it reads has to be declared ABOVE it, because the total is
 *     built in declaration order out of a column that already exists.
 *
 * The second is the same rule `parent=` follows, and for the same reason.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, closestMatch, formatCandidates, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { ACCUMULATE_OPS } from '../sequence/accumulate.js';

/** Every attribute a running total cannot do without. */
export function checkGenRunning(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  declaredAbove: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const attrs = extractAttrs(gen.attr());
  if (attrs['type'] !== 'running') return;

  const of = (attrs['of'] ?? '').trim();
  if (of === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="running"> does not say what to accumulate',
      hint:
        'Name the column it adds up: of="Delta". A running total reads another sequence — it ' +
        'draws nothing of its own.',
      code: 'TDC239',
    });
  }

  if ((attrs['accumulate'] ?? '').trim() === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="running"> does not say how to accumulate',
      hint: `Add accumulate="…" — one of: ${ACCUMULATE_OPS.join(', ')}.`,
      code: 'TDC239',
    });
  }

  // `of=` and `reset=` both read a column, so both take the declaration-order
  // rule. Reported separately: naming the wrong one would send the reader to
  // the wrong attribute.
  for (const name of ['of', 'reset'] as const) {
    const value = (attrs[name] ?? '').trim();
    if (value === '' || declaredAbove.includes(value)) continue;
    const suggestion = closestMatch(value, [...declaredAbove]);
    const attr = gen.attr().find((a) => a._attrName?.text === name);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: `${name}="${value}" is not a sequence declared above this one`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        declaredAbove.length === 0
          ? 'A running total is built from a column that already exists, so the column it reads ' +
            'has to come first.'
          : `Declared above: ${formatCandidates([...declaredAbove])}.`,
      code: 'TDC240',
    });
  }
}
