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
import { parseCharSet } from '../unicode/charset.js';
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

  checkDistinct(attrs, attrMap, repeatAttr, diagnostics);

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
      // The rule is a four-item refusal, not a whitelist, so the hint says which
      // four rather than listing what is allowed. The old wording listed seven
      // "supported" types, left `text` out of them, and then advised drawing a
      // list of words with regex or symbol — steering the reader away from the
      // generator that does exactly that, works, and is what multiple-values.mdx
      // teaches.
      hint:
        'Only increment, decrement, timeseries and pattern refuse it, and all four for the ' +
        'same reason: their value is decided by the row index, which a list of unknown ' +
        'length leaves undecided. Every other generator repeats, text included.',
      code: 'TDC204',
    });
  }
}

/**
 * `distinct="true"` — the row's values are drawn without replacement.
 *
 * Three refusals, and each one is a proof rather than a guess. They exist
 * because the alternative in every case is a config that says something and
 * silently gets something else.
 */
function checkDistinct(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string>,
  repeatAttr: AttrContext | undefined,
  diagnostics: Diagnostic[],
): void {
  const distinctAttr = findAttr(attrs, 'distinct');
  if (!distinctAttr) return;

  const raw = (attrMap['distinct'] ?? '').trim();
  if (raw !== 'true' && raw !== 'false') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(distinctAttr),
      message: `"distinct" takes true or false, not "${raw}"`,
      hint: 'distinct="true" draws a repeat list without replacement. Omit it, or write distinct="false".',
      code: 'TDC289',
    });
    return;
  }
  if (raw === 'false') return;

  // One value cannot repeat itself, so the attribute would be read and then do
  // nothing — the accepted-and-ignored failure this project keeps closing.
  if (!repeatAttr) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(distinctAttr),
      message: '"distinct" has no effect without "repeat"',
      hint:
        'distinct= stops one cell holding the same value twice, so there has to be a list. ' +
        'Add repeat="N" or repeat="A..B", or drop distinct=.',
      code: 'TDC290',
    });
    return;
  }

  // `percent` is an EXACT quota over the whole run; `distinct` is a guarantee
  // inside one row. Holding both would cost either streaming or the randomness
  // of the sample, so the pair is refused and the user is pointed at the
  // construct that does express proportions over lists.
  const percentAttr = findAttr(attrs, 'percent');
  if (percentAttr) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(percentAttr),
      message: '"percent" and "distinct" cannot both be on one <gen>',
      hint:
        'percent= promises exact proportions across the whole run; distinct= trades that promise ' +
        'away for a guarantee inside each row, so the two cannot both hold. Drop one — or put the ' +
        'proportions on a <mix> or <switch> outside, with repeat= on the <gen> inside.',
      code: 'TDC291',
    });
  }

  // The pool is only knowable up front for the types that carry it in the
  // config. Where it is not — a pack file, a regex — the same refusal fires at
  // run time instead, so a passing `check` never turns into a mid-run death.
  const pool = poolSizeFromConfig(attrMap);
  let longest: number | undefined;
  try {
    longest = parseRepeat(attrMap)?.max;
  } catch {
    return; // A malformed repeat= is already reported as TDC195.
  }
  if (pool !== undefined && longest !== undefined && longest > pool) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(repeatAttr),
      message: `"repeat" asks for up to ${String(longest)} different values, but the list holds only ${String(pool)}`,
      hint: `With distinct="true" a value cannot be used twice in one cell, so ${String(longest)} of them cannot be found. Lower repeat=, or widen value=.`,
      code: 'TDC292',
    });
  }
}

/**
 * How many different values this generator can offer, when the config alone
 * says so. `undefined` means "not knowable here" — never a guess.
 */
function poolSizeFromConfig(attrMap: Record<string, string>): number | undefined {
  const value = (attrMap['value'] ?? '').trim();
  if (value === '') return undefined;
  const type = attrMap['type'] ?? '';

  if (type === 'text') return new Set(value.split(',').map((v) => v.trim())).size;

  // A one-character symbol draws from its inline set, so the set IS the pool.
  // Only the plain shape is counted: a named `alphabet`, `include`/`exclude`,
  // or a length above one all change the answer, and a refusal built on a
  // guess is worse than no refusal at all. Those fall to the run-time arm.
  if (type === 'symbol') {
    const plain =
      (attrMap['alphabet'] ?? '') === '' &&
      (attrMap['include'] ?? '') === '' &&
      (attrMap['exclude'] ?? '') === '' &&
      ['', '1'].includes((attrMap['length'] ?? '').trim());
    if (!plain) return undefined;
    try {
      return new Set(parseCharSet(value)).size;
    } catch {
      return undefined; // A malformed set is TDC's charset error, not this one.
    }
  }

  if (type === 'number') {
    const dots = value.indexOf('..');
    if (dots < 0) return undefined;
    const lo = Number(value.slice(0, dots).trim());
    const hi = Number(value.slice(dots + 2).trim());
    // Only whole-number ranges have a countable pool; `1.0..2.0` does not.
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) return undefined;
    if ((attrMap['decimals'] ?? '').trim() !== '') return undefined;
    return hi - lo + 1;
  }

  return undefined;
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
