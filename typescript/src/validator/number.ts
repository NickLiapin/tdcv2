/**
 * Validation for `<gen type="number">` attributes.
 */

import { PercentMaskError, expandPercentMask } from '../distribution/index.js';
import { parseDistribution } from '../generators/distribution.js';
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
  try {
    parseDistribution(attrMap);
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
