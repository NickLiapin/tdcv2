/**
 * Validation for `<gen type="number">` attributes.
 */

import { PercentMaskError, expandPercentMask } from '../distribution/index.js';
import { expressionParams, parseDistribution } from '../generators/distribution.js';
import {
  computeAllowedIntervals,
  parseNumberIntervalList,
  parseNumberLengthChoices,
  parseNumberRanges,
} from '../generators/number.js';
import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

export function checkGenNumber(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);

  // Distribution mode (`distribution="normal" ...`) replaces the range/percent
  // model, so it is validated on its own and the range checks below are skipped.
  const distAttr = findAttr(attrs, 'distribution');
  if (distAttr && (attrMap['distribution'] ?? '').trim() !== '') {
    checkDistribution(attrs, attrMap, distAttr, diagnostics);
    return;
  }

  const valueAttr = findAttr(attrs, 'value');
  const lengthAttr = findAttr(attrs, 'length');

  if (valueAttr) {
    const raw = attrMap['value'] ?? '';
    try {
      parseNumberRanges(raw);
    } catch {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(valueAttr),
        message: `invalid number range "${raw}"`,
        hint: 'Expected "bit", "MIN..MAX", or a comma-separated range list like "[0..100],[345..678]".',
        code: 'TDC081',
      });
      return;
    }
  }

  // include / exclude modifiers (integer values or `a..b` ranges).
  const includeAttr = findAttr(attrs, 'include');
  const excludeAttr = findAttr(attrs, 'exclude');
  const hasInclude = (attrMap['include'] ?? '').trim().length > 0;
  const hasExclude = (attrMap['exclude'] ?? '').trim().length > 0;
  if (hasInclude || hasExclude) {
    // `include`/`exclude` turn the draw into a pick from an explicit set of WHOLE
    // numbers — "each of the nine surviving numbers exactly a 1-in-9 chance". A
    // fractional value can never be in that set, so `decimals` describes a draw
    // that is no longer happening: the engine dropped it and emitted integers,
    // and the config that asked for 7.71 got 8 without a word.
    const decimalsAttr = findAttr(attrs, 'decimals');
    const decimals = (attrMap['decimals'] ?? '').trim();
    if (decimalsAttr && decimals !== '' && decimals !== '0') {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(decimalsAttr),
        message: `decimals="${decimals}" cannot be combined with ${
          hasInclude && hasExclude ? 'include/exclude' : hasInclude ? 'include' : 'exclude'
        }`,
        hint:
          'include= and exclude= build a set of whole numbers and pick one uniformly, so there ' +
          'are no fractional values to round. Drop decimals=, or bound the range with value= ' +
          'instead of a set.',
        code: 'TDC255',
      });
    }

    const rawValue = (attrMap['value'] ?? '').trim();
    if (!valueAttr || rawValue.length === 0) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(gen),
        message: '<gen type="number"> include/exclude require a numeric range in "value"',
        hint: 'Add a range first, e.g. value="0..9" exclude="3".',
        code: 'TDC087',
      });
    } else {
      let modsOk = true;
      if (hasInclude && includeAttr) {
        modsOk =
          checkInterval(attrMap['include'] ?? '', 'include', includeAttr, diagnostics) && modsOk;
      }
      if (hasExclude && excludeAttr) {
        modsOk =
          checkInterval(attrMap['exclude'] ?? '', 'exclude', excludeAttr, diagnostics) && modsOk;
      }
      if (modsOk) {
        try {
          computeAllowedIntervals(
            parseNumberRanges(rawValue),
            attrMap['include'],
            attrMap['exclude'],
          );
        } catch (err) {
          diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...nodeRange(gen),
            message: err instanceof Error ? err.message : String(err),
            hint: 'Make sure include/exclude do not remove every value from the range.',
            code: 'TDC087',
          });
        }
      }
    }
  }

  const firstZeroAttr = findAttr(attrs, 'first_zero');
  if (firstZeroAttr) {
    const fz = attrMap['first_zero'] ?? '';
    if (fz !== 'true' && fz !== 'false') {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(firstZeroAttr),
        message: `invalid first_zero "${fz}" — expected "true" or "false"`,
        code: 'TDC082',
      });
    }
  }

  if (lengthAttr) {
    const len = attrMap['length'] ?? '';
    try {
      parseNumberLengthChoices(len);
    } catch {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(lengthAttr),
        message: `invalid length "${len}" — expected a positive integer, range, or comma-separated length groups`,
        hint: 'Examples: length="10", length="2-10", length="2,10-12".',
        code: 'TDC083',
      });
      return;
    }
  }

  checkDecimalsReachSomething(attrs, attrMap, diagnostics);
  checkFirstZeroIsReachable(attrs, attrMap, diagnostics);

  const percentAttr = findAttr(attrs, 'percent');
  if (!percentAttr) return;

  const lengthChoices = lengthAttr ? parseNumberLengthChoices(attrMap['length'] ?? '') : [];
  try {
    expandPercentMask(attrMap['percent'] ?? '', lengthChoices.length);
  } catch (err) {
    if (!(err instanceof PercentMaskError)) throw err;
    const code = err.kind === 'length' ? 'TDC084' : err.kind === 'number' ? 'TDC085' : 'TDC086';
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(percentAttr),
      message: err.message,
      hint:
        lengthChoices.length === 0
          ? 'Number percent currently applies to length groups, so provide length="A,B-C" first.'
          : 'Filled positions must be non-negative numbers. Empty positions split the remaining percent equally.',
      code,
    });
  }
}

/**
 * `decimals=` only describes a draw that HAS a fractional part.
 *
 * Two shapes reached the generator and were dropped there, each leaving a
 * column that looks fine and is not what the config asked for:
 *
 *     <gen type="number" length="4" decimals="2"/>            ->  4566
 *     <gen type="number" value="1..9" length="3" decimals="2"/>  ->  3.78
 *
 * The first has no range at all, so the generator produces a digit STRING — an
 * id, not a number — and there is nothing to round. The second does have a
 * range, so `decimals` wins and `length` is discarded instead: a fractional
 * value has no integer width to pad to. Either way one attribute was written
 * and read by nothing, which is the whole reason TDC015 exists; these two are
 * the same mistake spelled with attributes that ARE owned by this generator.
 *
 * The include/exclude pairing is refused separately, by TDC255 above.
 */
function checkDecimalsReachSomething(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  const decimalsAttr = findAttr(attrs, 'decimals');
  const decimals = (attrMap['decimals'] ?? '').trim();
  if (!decimalsAttr || decimals === '' || decimals === '0') return;

  const range = (attrMap['value'] ?? '').trim();
  if (range === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(decimalsAttr),
      message: `decimals="${decimals}" has nothing to round — without value= this generator produces a digit string`,
      hint:
        'Give it a range to draw from: value="0..100" decimals="2". A number with only ' +
        'length= is an identifier of that many digits, and an identifier has no decimal places.',
      code: 'TDC277',
    });
    return;
  }

  const lengthAttr = findAttr(attrs, 'length');
  if (lengthAttr && (attrMap['length'] ?? '').trim() !== '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(lengthAttr),
      message: `length="${(attrMap['length'] ?? '').trim()}" is not read beside decimals="${decimals}" — a fractional value has no integer width to pad`,
      hint:
        'Keep one of them: decimals= for a fractional value over the range, or length= for a ' +
        'whole number padded to a fixed width.',
      code: 'TDC278',
    });
  }
}

/**
 * `first_zero="false"` that the range can never satisfy.
 *
 * A value drawn from a range is padded to `length` with zeros, so it can only
 * avoid a leading one by being wide enough on its own. When the range's largest
 * value has fewer digits than the width, EVERY draw needs padding — and the
 * generator answered by redrawing a hundred times and then emitting the
 * forbidden shape anyway:
 *
 *     <gen type="number" value="0..5" length="3" first_zero="false"/>  ->  005 002 003
 *
 * A hundred wasted draws per row, and the attribute honoured on none of them.
 * Only reported where it is PROVABLE from the range and the width; a range that
 * can produce a wide enough value is left alone, because whether a given row
 * does is the draw's business.
 */
function checkFirstZeroIsReachable(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  const firstZeroAttr = findAttr(attrs, 'first_zero');
  if (!firstZeroAttr || (attrMap['first_zero'] ?? '') !== 'false') return;
  const raw = (attrMap['value'] ?? '').trim();
  const lengthRaw = (attrMap['length'] ?? '').trim();
  if (raw === '' || lengthRaw === '') return;

  let widths: number[];
  let biggest: number;
  try {
    widths = parseNumberLengthChoices(lengthRaw).flatMap((c) =>
      Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i),
    );
    biggest = Math.max(...parseNumberRanges(raw).map((r) => r.max));
  } catch {
    return; // a malformed range or length is already reported above
  }
  if (widths.length === 0 || !Number.isFinite(biggest)) return;

  // A value renders without a leading zero at width W only if it has at least
  // W digits of its own, which needs max >= 10^(W-1).
  const unreachable = widths.filter((w) => w > 1 && biggest < 10 ** (w - 1));
  if (unreachable.length === 0) return;

  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(firstZeroAttr),
    message: `first_zero="false" cannot be honoured — no value in "${raw}" reaches ${
      unreachable.length === 1
        ? `${String(unreachable[0])} digits`
        : `${String(Math.min(...unreachable))} digits`
    }, so every draw has to be padded`,
    hint:
      `The widest value the range offers is ${String(biggest)}. Widen the range — ` +
      `value="${String(10 ** (Math.min(...unreachable) - 1))}..${String(10 ** Math.min(...unreachable) - 1)}" — or drop length=, or allow the zero.`,
    code: 'TDC279',
  });
}

/** Attributes that describe a range/percent — meaningless alongside a distribution. */
const DISTRIBUTION_INCOMPATIBLE = ['value', 'percent', 'length', 'include', 'exclude'] as const;

/**
 * Validate a `distribution="..."` number gen: it must not carry range/percent
 * attributes (they don't apply), and its name + parameters must be valid — for
 * which we reuse the runtime parser (`parseDistribution`) so validation and
 * generation never disagree.
 */
function checkDistribution(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string | undefined>,
  distAttr: AttrContext,
  diagnostics: Diagnostic[],
): void {
  for (const key of DISTRIBUTION_INCOMPATIBLE) {
    const a = findAttr(attrs, key);
    if (a && (attrMap[key] ?? '').trim() !== '') {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(a),
        message: `<gen type="number" distribution="..."> cannot be combined with "${key}"`,
        hint: `A distribution replaces the range/percent. Remove "${key}", or drop "distribution" to use a range.`,
        code: 'TDC088',
      });
    }
  }
  // A parameter written as an EXPRESSION is resolved per row against the other
  // columns, so its VALUE is not knowable here. Stand a plausible number in its
  // place and check everything else — the distribution's name, the parameters it
  // requires, the attributes it refuses — so writing `lambda="Traffic * 0.5"`
  // does not buy silence about the rest of the generator.
  //
  // `1` is the stand-in because every parameter in every distribution accepts
  // it: the positive ones are happy, and the unbounded ones do not care. A
  // parameter that resolves to something the distribution rejects — a negative
  // `sd`, say — is caught by the run, where the value finally exists, with the
  // same message this check would have produced.
  const dynamic = expressionParams(attrMap);
  const forCheck: Record<string, string | undefined> =
    dynamic.length === 0
      ? attrMap
      : { ...attrMap, ...Object.fromEntries(dynamic.map((k) => [k, '1'])) };
  try {
    parseDistribution(forCheck);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(distAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Distributions: normal (mean, sd), lognormal (meanlog, sdlog), exponential (rate), pareto (alpha, xmin). Optional: decimals, min, max.',
      code: 'TDC089',
    });
  }
}

/** Validate an include/exclude interval list parses; returns true if OK. */
function checkInterval(
  raw: string,
  label: string,
  attr: AttrContext,
  diagnostics: Diagnostic[],
): boolean {
  try {
    parseNumberIntervalList(raw, label);
    return true;
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Use integers or ranges, e.g. exclude="3" or exclude="3,7,40..60".',
      code: 'TDC087',
    });
    return false;
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}
