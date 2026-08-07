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
  STEP_SYNTAX,
  WEEKDAY_NAMES,
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
import { parsePrecision } from '../generators/date.js';
import { fixesWeekday, parseStep, parseWeekdays } from '../date/index.js';
import { extractAttrs } from '../processor/walk.js';
import { checkGenDateOffset } from './date-offset.js';

export function checkGenDate(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  declaredAbove: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  // `of=` makes this an OFFSET rather than a draw: a different set of attributes
  // configures it, and a different set of mistakes is possible. Its own checks
  // REPLACE the ones below rather than joining them — everything here is about
  // how a draw is bounded, so it would be a second complaint about the same
  // attribute, naming a rule that no longer applies to it.
  if ((attrMap['of'] ?? '').trim() !== '') {
    checkGenDateOffset(gen, declaredAbove, diagnostics);
    return;
  }
  checkDateCommonAttrs(attrs, diagnostics);
  checkDateStep(attrs, attrMap, diagnostics);
  checkDateWeekdays(attrs, attrMap, diagnostics);

  const value = attrMap['value']?.trim();
  const fromAttr = findAttr(attrs, 'from');
  const toAttr = findAttr(attrs, 'to');
  const rangeAttr = findAttr(attrs, 'range');

  // `from=` with no `to=` is an OPEN axis when the range is WALKED: row i is
  // start + i steps, and `count` decides the length. Requiring an end there meant
  // working out what date the millionth day falls on in order to write it down.
  // On a DRAWN date one end still means nothing, so TDC150 stays for that.
  const walked = (attrMap['order'] ?? '').trim() === 'sequential';
  const openAxis = walked && fromAttr !== undefined && toAttr === undefined;
  if (!openAxis && (fromAttr || toAttr) && (!fromAttr || !toAttr)) {
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
    if (fromAttr) parseDateTimeStrict(attrMap['from'] ?? '');
    if (toAttr) parseDateTimeStrict(attrMap['to'] ?? '');
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

  const parsed = parseStep(raw);
  if (!parsed.ok) {
    // The two failures read differently because they ARE different: one is a
    // spelling nobody meant, the other a step whose meaning would depend on
    // which half was applied first.
    const mixed = parsed.reason === 'mixed';
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(stepAttr),
      message: mixed
        ? `step="${raw}" mixes a calendar unit with a fixed one`
        : `step="${raw}" is not a step this engine can walk`,
      hint: mixed
        ? 'A month is 28 to 31 days, so "one month and fifteen days" depends on which is applied first. Write one or the other: 45d, or 1mo.'
        : `Write ${STEP_SYNTAX}. A bare number means days, so step="2" is every other day.`,
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

/**
 * `weekdays="mon..fri"` — which weekdays a walked axis keeps.
 *
 * A FILTER, not a step: the spacing stops being even, since Friday to Monday is
 * a three-day jump. That is why it is a separate attribute — one word for both
 * operations would stop them being combinable, and "every 15 minutes, but only
 * on working days" is exactly what gets asked for.
 */
function checkDateWeekdays(
  attrs: readonly AttrContext[],
  attrMap: Readonly<Record<string, string>>,
  diagnostics: Diagnostic[],
): void {
  const daysAttr = findAttr(attrs, 'weekdays');
  if (!daysAttr) return;
  const raw = (attrMap['weekdays'] ?? '').trim();

  if (parseWeekdays(raw) === undefined) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(daysAttr),
      message: `unknown weekday in weekdays="${raw}"`,
      hint: `Names are ${WEEKDAY_NAMES.join(', ')} — a span like "mon..fri" or a list like "sun,wed".`,
      code: 'TDC249',
    });
    return;
  }

  if ((attrMap['order'] ?? '').trim() !== 'sequential') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(daysAttr),
      message: `weekdays="${raw}" has no order="sequential" on the same <gen> — nothing walks the range`,
      hint: 'Add order="sequential" to walk the range and keep only these days, or remove weekdays= and let the dates be drawn at random.',
      code: 'TDC248',
    });
    return;
  }

  const step = parseStep(attrMap['step']);
  if (step.ok && fixesWeekday(step.step)) {
    // Two different reasons wear one code, and they must not wear one sentence.
    //
    // A whole number of weeks really does land on the same weekday every time,
    // so the filter matches every row or none. Measured on the STEP rather than
    // on its spelling, so `14d` is caught as surely as `2w`.
    //
    // A CALENDAR step does not: 15 January 2026 is a Thursday, 15 February a
    // Sunday, 15 March a Sunday, 15 April a Wednesday. Saying it "already fixes
    // the weekday" was simply false, and a reader who checked would find it out.
    // The combination is still refused — a month holds a different number of
    // days each time, so which rows survive is a property of the calendar and
    // not of anything the config said — but it is refused for its own reason.
    const written = (attrMap['step'] ?? '').trim();
    const wholeWeeks = step.step.months === 0;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(daysAttr),
      message: wholeWeeks
        ? `weekdays="${raw}" cannot narrow step="${written}" — that step already fixes the weekday`
        : `weekdays="${raw}" cannot narrow step="${written}" — a calendar step is not measured in days`,
      hint: wholeWeeks
        ? 'A whole number of weeks lands on the same weekday every time, so this would match every row or none. Use a step that is not a multiple of a week, or drop weekdays=.'
        : 'A month and a year hold a different number of days each time, so which rows survive the filter follows the calendar rather than anything written here. Use a step measured in days or hours, or drop weekdays=.',
      code: 'TDC250',
    });
  }
}
