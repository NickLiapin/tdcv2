/**
 * Date generator and legacy date template adapters.
 *
 * This module intentionally does not depend on moment.js. It uses the
 * portable date runtime in src/date so the same parsing/formatting rules
 * can be implemented in Python and Java later.
 */

import {
  DateRuntimeError,
  MS_PER_SECOND,
  formatDateTime,
  fromEpochDay,
  fromEpochMillis,
  parseDateRangeValue,
  parseDateTimeStrict,
  parseLegacyDateRange,
  startOfDay,
  subtractUtcYears,
  toEpochDay,
  toEpochMillis,
  addStep,
  DEFAULT_STEP,
  parseStep,
  parseWeekdays,
  stepsBetween,
  weekdayOf,
  type DatePrecision,
  type ParsedDateRange,
  type PlainDateTime,
  type StepSpec,
} from '../date/index.js';
import type { AttrMap } from '../processor/attrs.js';

import type { Generator } from './generator.js';

export interface DateGenAttrs {
  readonly value?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly range?: string | undefined;
  /** How far each row advances on a walked axis: `2`, `15m`, `1h30m`, `3mo`. */
  readonly step?: string | undefined;
  /** Which weekdays a walked axis keeps: `mon..fri`, `sun,wed`. */
  readonly weekdays?: string | undefined;
  readonly format?: string | undefined;
  readonly local?: string | undefined;
  readonly oldest?: string | number | undefined;
  readonly youngest?: string | number | undefined;
  readonly precision?: string | undefined;
}

interface DatePlan {
  readonly kind: 'fixed' | 'range';
  readonly fixed?: PlainDateTime;
  readonly start?: PlainDateTime;
  readonly end?: PlainDateTime;
  readonly precision: DatePrecision;
  readonly format: string;
  readonly locale: string;
}

const DEFAULT_DATE_START = '1970-01-01';
const DEFAULT_FORMAT = 'L';

export function dateGenerator(attrs: DateGenAttrs, locale: string, now: number): Generator {
  const plan = buildDatePlan(attrs, locale, now);
  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const value = plan.kind === 'fixed' ? plan.fixed : pickRangeDate(plan, prng);
      if (!value) throw new DateRuntimeError('date generator: invalid generation plan');
      out[i] = formatDateTime(value, plan.format, plan.locale);
    }
    return out;
  };
}

/** True when a range was written with only its START — an axis with no end. */
function isOpenAxis(attrs: DateGenAttrs): boolean {
  return (
    attrs.from !== undefined &&
    attrs.to === undefined &&
    attrs.range === undefined &&
    (attrs.value ?? '') === ''
  );
}

const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * A date range as a walkable axis: how many steps it holds, and what the k-th is.
 *
 * `size` is undefined for an OPEN axis — `from=` with no end. That is the case
 * the first design missed: requiring an end meant working out what date the
 * millionth day falls on in order to write it down, when the end is simply
 * `start + count × step`. An open axis never wraps, because there is nothing to
 * wrap at.
 *
 * The range is never expanded into a list. A century stepped by the second is
 * three billion values and the streaming engine promises bounded memory whatever
 * the config says — so each date is `start + k × step`, measured from the START
 * rather than accumulated, which is what keeps a clamped February from dragging
 * every later month back with it.
 */
export function dateAxis(
  attrs: DateGenAttrs,
  locale: string,
  now: number,
): { size: number | undefined; at: (k: number) => string } {
  const parsed = parseStep(attrs.step);
  const step: StepSpec = parsed.ok ? parsed.step : DEFAULT_STEP;
  const keep = parseWeekdays(attrs.weekdays);
  const plan = buildDatePlan(attrs, locale, now);
  const render = (value: PlainDateTime): string => formatDateTime(value, plan.format, plan.locale);

  if (plan.kind !== 'range' || !plan.start) {
    const fixed = plan.fixed ?? plan.start;
    if (!fixed) throw new DateRuntimeError('date generator: invalid generation plan');
    return { size: 1, at: () => render(fixed) };
  }
  const start = plan.start;

  // `weekdays=` keeps only some of the candidates, so the k-th KEPT one is wanted
  // rather than the k-th candidate. Which candidates match repeats on a cycle —
  // one week's worth of steps — so the offsets are found once and then indexed,
  // instead of scanning from the beginning for every row.
  const filtered = keep
    ? (() => {
        const perCycle = step.ms > 0 ? MS_PER_WEEK / gcd(step.ms, MS_PER_WEEK) : 7;
        const offsets: number[] = [];
        for (let i = 0; i < perCycle; i++) {
          if (keep.has(weekdayOf(addStep(start, step, i)))) offsets.push(i);
        }
        return { perCycle, offsets };
      })()
    : undefined;

  const candidateAt = (k: number): PlainDateTime => {
    if (!filtered || filtered.offsets.length === 0) return addStep(start, step, k);
    const cycles = Math.floor(k / filtered.offsets.length);
    const within = filtered.offsets[k % filtered.offsets.length] ?? 0;
    return addStep(start, step, cycles * filtered.perCycle + within);
  };

  if (isOpenAxis(attrs)) {
    return { size: undefined, at: (k) => render(candidateAt(k)) };
  }

  const end = plan.end;
  if (!end) return { size: undefined, at: (k) => render(candidateAt(k)) };
  const candidates = stepsBetween(start, end, step);
  const size = filtered
    ? Math.max(
        1,
        Math.floor(candidates / filtered.perCycle) * filtered.offsets.length +
          filtered.offsets.filter((o) => o < candidates % filtered.perCycle).length,
      )
    : candidates;
  return { size, at: (k) => render(candidateAt(k)) };
}

function buildDatePlan(attrs: DateGenAttrs, locale: string, now: number): DatePlan {
  const format = attrs.format ?? DEFAULT_FORMAT;
  const loc = attrs.local ?? locale;
  const value = attrs.value?.trim();

  if (value === 'today') {
    return {
      kind: 'fixed',
      fixed: startOfDay(fromEpochMillis(now)),
      precision: parsePrecision(attrs.precision, 'day'),
      format,
      locale: loc,
    };
  }

  if (value === 'now') {
    return {
      kind: 'fixed',
      fixed: fromEpochMillis(now),
      precision: parsePrecision(attrs.precision, 'millisecond'),
      format,
      locale: loc,
    };
  }

  if (value === 'birth') {
    const oldest = parseAge(attrs.oldest, 80, 'oldest');
    const youngest = parseAge(attrs.youngest, 10, 'youngest');
    if (youngest > oldest) {
      throw new DateRuntimeError('date generator: youngest must be less than or equal to oldest');
    }
    const start = fromEpochMillis(subtractUtcYears(now, oldest));
    const end = fromEpochMillis(subtractUtcYears(now, youngest));
    return rangePlan(
      { start: { value: start, hasTime: false }, end: { value: end, hasTime: false } },
      attrs,
      {
        format,
        locale: loc,
        fallbackPrecision: 'day',
      },
    );
  }

  const rangeFromAttrs = attrs.from !== undefined || attrs.to !== undefined;
  if (rangeFromAttrs) {
    // `from=` alone is an OPEN axis — legal when the range is WALKED, and the
    // plan carries only a start. `dateAxis` reads `end` as undefined and never
    // wraps; a DRAWN date with one end is still refused, by TDC150.
    if (attrs.from !== undefined && attrs.to === undefined) {
      const start = parseDateTimeStrict(attrs.from);
      return {
        kind: 'range',
        start: start.value,
        precision: parsePrecision(attrs.precision, start.hasTime ? 'millisecond' : 'day'),
        format,
        locale: loc,
      };
    }
    if (attrs.from === undefined || attrs.to === undefined) {
      throw new DateRuntimeError('date generator: "from" and "to" must be provided together');
    }
    return rangePlan(
      { start: parseDateTimeStrict(attrs.from), end: parseDateTimeStrict(attrs.to) },
      attrs,
      { format, locale: loc },
    );
  }

  if (attrs.range !== undefined) {
    return rangePlan(parseDateRangeValue(attrs.range), attrs, { format, locale: loc });
  }

  if (value !== undefined && value.length > 0) {
    if (value.includes('..')) {
      return rangePlan(parseDateRangeValue(value), attrs, { format, locale: loc });
    }
    const parsed = parseDateTimeStrict(value);
    return {
      kind: 'fixed',
      fixed: parsed.value,
      precision: parsePrecision(attrs.precision, parsed.hasTime ? 'millisecond' : 'day'),
      format,
      locale: loc,
    };
  }

  return rangePlan(
    {
      start: parseDateTimeStrict(DEFAULT_DATE_START),
      end: { value: fromEpochMillis(now), hasTime: true },
    },
    attrs,
    { format, locale: loc, fallbackPrecision: 'day' },
  );
}

function rangePlan(
  range: ParsedDateRange,
  attrs: DateGenAttrs,
  options: {
    readonly format: string;
    readonly locale: string;
    readonly fallbackPrecision?: DatePrecision;
  },
): DatePlan {
  const hasTime = range.start.hasTime || range.end.hasTime;
  return {
    kind: 'range',
    start: range.start.value,
    end: range.end.value,
    precision: parsePrecision(
      attrs.precision,
      options.fallbackPrecision ?? (hasTime ? 'millisecond' : 'day'),
    ),
    format: options.format,
    locale: options.locale,
  };
}

function pickRangeDate(plan: DatePlan, prng: () => number): PlainDateTime {
  const start = plan.start;
  const end = plan.end;
  if (!start || !end) throw new DateRuntimeError('date generator: range plan is incomplete');

  if (plan.precision === 'day') {
    const a = toEpochDay(start);
    const b = toEpochDay(end);
    return fromEpochDay(randomIntegerInclusive(prng, Math.min(a, b), Math.max(a, b)));
  }

  const divisor = plan.precision === 'second' ? MS_PER_SECOND : 1;
  const a = Math.floor(toEpochMillis(start) / divisor);
  const b = Math.floor(toEpochMillis(end) / divisor);
  const picked = randomIntegerInclusive(prng, Math.min(a, b), Math.max(a, b));
  return fromEpochMillis(picked * divisor);
}

function randomIntegerInclusive(prng: () => number, min: number, max: number): number {
  return Math.floor(prng() * (max - min + 1) + min);
}

function parseAge(raw: string | number | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 150) {
    throw new DateRuntimeError(`date generator: ${name} must be an integer from 0 to 150`);
  }
  return value;
}

export function parsePrecision(
  raw: string | undefined,
  fallback: DatePrecision = 'day',
): DatePrecision {
  if (raw === undefined) return fallback;
  if (raw === 'day' || raw === 'second' || raw === 'millisecond') return raw;
  throw new DateRuntimeError(
    `date generator: unsupported precision "${raw}" (supported: day, second, millisecond)`,
  );
}

/**
 * `person.b_day` template source. Exported so the template resolver can
 * register it directly in its static registry — see
 * templates/resolver.ts. (Previously wired via a side-effect import; the
 * explicit export removes that fragility.)
 */
export function renderBDay(
  prng: () => number,
  attrs: AttrMap,
  locale: string,
  now: number,
): string {
  return (
    dateGenerator(
      {
        value: 'birth',
        oldest: attrs['oldest'],
        youngest: attrs['youngest'],
        format: attrs['format'],
        local: attrs['local'],
        precision: attrs['precision'] ?? 'millisecond',
      },
      locale,
      now,
    )(1, prng)[0] ?? ''
  );
}

/**
 * `date.range` template source. Exported for the same reason as
 * {@link renderBDay} — direct registration in templates/resolver.ts.
 */
export function renderDateRange(
  prng: () => number,
  attrs: AttrMap,
  locale: string,
  now: number,
): string {
  const rangeText = attrs['range'] ?? '';
  let range: ParsedDateRange;
  try {
    range = parseLegacyDateRange(rangeText);
  } catch (error) {
    if (error instanceof DateRuntimeError) {
      throw new DateRuntimeError(`date.range: invalid range attribute "${rangeText}"`);
    }
    throw error;
  }
  return (
    dateGenerator(
      {
        from: serializeDateTime(range.start.value),
        to: serializeDateTime(range.end.value),
        format: attrs['format'],
        local: attrs['local'],
        precision: attrs['precision'] ?? 'day',
      },
      locale,
      now,
    )(1, prng)[0] ?? ''
  );
}

function serializeDateTime(value: PlainDateTime): string {
  return `${pad(value.year, 4)}-${pad(value.month, 2)}-${pad(value.day, 2)}T${pad(
    value.hour,
    2,
  )}:${pad(value.minute, 2)}:${pad(value.second, 2)}.${pad(value.millisecond, 3)}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
