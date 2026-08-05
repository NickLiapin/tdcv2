/**
 * Validation for `<gen type="date">` and date template attributes.
 */

import {
  DATE_LOCALE_NAMES,
  DateRuntimeError,
  isKnownDateLocale,
  parseDateRangeValue,
  parseDateTimeStrict,
  parseLegacyDateRange,
  STEP_UNITS,
  validateDateFormat,
} from '../date/index.js';
import {
  type Diagnostic,
  attrValueRange,
  closestMatch,
  formatCandidates,
  nodeRange,
} from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { parsePrecision, parseStepUnit } from '../generators/date.js';
import { extractAttrs } from '../processor/walk.js';

export function checkGenDate(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  checkDateCommonAttrs(attrs, diagnostics);
  checkDateStep(attrs, attrMap, diagnostics);

  const value = attrMap['value']?.trim();
  const fromAttr = findAttr(attrs, 'from');
  const toAttr = findAttr(attrs, 'to');
  const rangeAttr = findAttr(attrs, 'range');

  if ((fromAttr || toAttr) && (!fromAttr || !toAttr)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="date"> requires both "from" and "to" when either is used',
      hint: 'Use from="2020-01-01" to="2025-12-31" or value="2020-01-01..2025-12-31".',
      code: 'TDC150',
    });
    return;
  }

  try {
    if (fromAttr && toAttr) {
      parseDateTimeStrict(attrMap['from'] ?? '');
      parseDateTimeStrict(attrMap['to'] ?? '');
    }
    if (rangeAttr) parseDateRangeValue(attrMap['range'] ?? '');
    if (value !== undefined && value.length > 0) validateDateValue(value);
    checkBirthAges(attrs);
  } catch (err) {
    const attr = findPrimaryDateAttr(attrs);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Examples: value="2020-01-01..2025-12-31", value="birth", value="today", or value="now".',
      code: 'TDC151',
    });
  }
}

export function checkDateRangeTemplate(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const rangeAttr = findAttr(attrs, 'range');
  if (rangeAttr === undefined || attrMap['range'] === undefined) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: `<gen value="date.range"> requires a "range" attribute`,
      hint: 'Syntax: range="YYYY.MM.DD - YYYY.MM.DD".',
      code: 'TDC072',
    });
    return;
  }
  try {
    parseLegacyDateRange(attrMap['range']);
    checkDateCommonAttrs(attrs, diagnostics);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(rangeAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Expected two valid dates in "YYYY.MM.DD - YYYY.MM.DD" form.',
      code: 'TDC073',
    });
  }
}

export function checkBirthDateTemplate(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  try {
    checkDateCommonAttrs(attrs, diagnostics);
    checkBirthAges(attrs);
  } catch (err) {
    const attr = findPrimaryDateAttr(attrs);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: err instanceof Error ? err.message : String(err),
      code: 'TDC151',
    });
  }
}

function validateDateValue(value: string): void {
  if (value === 'birth' || value === 'today' || value === 'now') return;
  if (value.includes('..')) {
    parseDateRangeValue(value);
    return;
  }
  parseDateTimeStrict(value);
}

function checkDateCommonAttrs(attrs: readonly AttrContext[], diagnostics: Diagnostic[]): void {
  const attrMap = extractAttrs(attrs);
  const formatAttr = findAttr(attrs, 'format');
  if (formatAttr && attrMap['format'] !== undefined) {
    try {
      validateDateFormat(attrMap['format']);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(formatAttr),
        message: err instanceof Error ? err.message : String(err),
        hint: 'Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket literals [text].',
        code: 'TDC152',
      });
    }
  }

  const localAttr = findAttr(attrs, 'local');
  const local = attrMap['local'];
  if (localAttr && local !== undefined && !isKnownDateLocale(local)) {
    const suggestion = closestMatch(local, DATE_LOCALE_NAMES);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(localAttr),
      message: `unknown date locale "${local}"`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: `Known date locales: ${formatCandidates(DATE_LOCALE_NAMES)}.`,
      code: 'TDC153',
    });
  }

  const precisionAttr = findAttr(attrs, 'precision');
  if (precisionAttr) {
    try {
      parsePrecision(attrMap['precision']);
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(precisionAttr),
        message: err instanceof Error ? err.message : String(err),
        code: 'TDC154',
      });
    }
  }
}

function checkBirthAges(attrs: readonly AttrContext[]): void {
  const attrMap = extractAttrs(attrs);
  const oldest = parseAge(attrMap['oldest'], 80, 'oldest');
  const youngest = parseAge(attrMap['youngest'], 10, 'youngest');
  if (youngest > oldest) {
    throw new DateRuntimeError('date generator: youngest must be less than or equal to oldest');
  }
}

function parseAge(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 150) {
    throw new DateRuntimeError(`date generator: ${name} must be an integer from 0 to 150`);
  }
  return value;
}

function findPrimaryDateAttr(attrs: readonly AttrContext[]): AttrContext | undefined {
  return (
    findAttr(attrs, 'value') ??
    findAttr(attrs, 'range') ??
    findAttr(attrs, 'from') ??
    findAttr(attrs, 'to') ??
    findAttr(attrs, 'oldest') ??
    findAttr(attrs, 'youngest')
  );
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

/**
 * `step=` on a walked date range — and the two ways to write it that mean nothing.
 *
 * An unknown unit would silently fall back to days, so a config asking for
 * `step="fortnight"` would render a year of consecutive days and look right at a
 * glance. And `step=` without `order="sequential"` is read by nothing at all: the
 * range is still drawn at random, which is the harder mistake to see because the
 * dates ARE inside the range the config named.
 */
function checkDateStep(
  attrs: readonly AttrContext[],
  attrMap: Readonly<Record<string, string>>,
  diagnostics: Diagnostic[],
): void {
  const stepAttr = findAttr(attrs, 'step');
  if (!stepAttr) return;
  const raw = (attrMap['step'] ?? '').trim();

  if (parseStepUnit(raw) === undefined) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(stepAttr),
      message: `unknown step "${raw}"`,
      hint: `Supported: ${STEP_UNITS.join(', ')}.`,
      code: 'TDC247',
    });
    return;
  }

  if ((attrMap['order'] ?? '').trim() !== 'sequential') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(stepAttr),
      message: `step="${raw}" has no order="sequential" on the same <gen> — nothing walks the range`,
      hint: 'Add order="sequential" to walk the range one step at a time, or remove step= and let the dates be drawn at random.',
      code: 'TDC248',
    });
  }
}
