/**
 * Validation for `<gen type="stat">` — one number for the whole run.
 *
 * The same two things `running` needs, for the same two reasons: it has to say
 * WHAT to summarise (`of=`) and HOW (`op=`), and the column it reads has to be
 * declared ABOVE it, because the statistic is built in declaration order out of
 * a column that already exists.
 *
 * The declaration-order complaint is TDC240, shared with `running` on purpose —
 * it is the same rule with the same fix, and a second code for it would only
 * make the error reference longer without telling a reader anything new.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, closestMatch, formatCandidates, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { STAT_OPS, StatError, parseStatOp, statDecimals } from '../sequence/stat.js';

/** Every attribute a statistic cannot do without, and the ones it can only have one way. */
export function checkGenStat(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  declaredAbove: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const attrs = extractAttrs(gen.attr());
  if (attrs['type'] !== 'stat') return;

  const of = (attrs['of'] ?? '').trim();
  if (of === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="stat"> does not say what to summarise',
      hint:
        'Name the column it reads: of="Price". A statistic reads another sequence — it draws ' +
        'nothing of its own.',
      code: 'TDC262',
    });
  }

  if ((attrs['op'] ?? '').trim() === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="stat"> does not say which statistic',
      hint: `Add op="…" — one of: ${STAT_OPS.join(', ')}.`,
      code: 'TDC262',
    });
  } else {
    try {
      parseStatOp(attrs);
    } catch (e) {
      const attr = gen.attr().find((a) => a._attrName?.text === 'op');
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...(attr ? attrValueRange(attr) : nodeRange(gen)),
        message: e instanceof StatError ? e.message : String(e),
        ...(closestMatch((attrs['op'] ?? '').trim(), [...STAT_OPS])
          ? {
              suggestion: `did you mean "${closestMatch((attrs['op'] ?? '').trim(), [...STAT_OPS]) ?? ''}"?`,
            }
          : {}),
        hint: `One of: ${STAT_OPS.join(', ')}.`,
        code: 'TDC262',
      });
    }
  }

  try {
    statDecimals(attrs);
  } catch (e) {
    const attr = gen.attr().find((a) => a._attrName?.text === 'decimals');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: e instanceof StatError ? e.message : String(e),
      hint:
        'decimals= rounds the answer. A mean, a median and a standard deviation are ratios and ' +
        'print in full without it; sum, min and max keep the exact scale of the column.',
      code: 'TDC262',
    });
  }

  if (of !== '' && !declaredAbove.includes(of)) {
    const suggestion = closestMatch(of, [...declaredAbove]);
    const attr = gen.attr().find((a) => a._attrName?.text === 'of');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: `of="${of}" is not a sequence declared above this one`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        declaredAbove.length === 0
          ? 'A statistic is built from a column that already exists, so the column it reads has ' +
            'to come first.'
          : `Declared above: ${formatCandidates([...declaredAbove])}.`,
      code: 'TDC240',
    });
  }
}
