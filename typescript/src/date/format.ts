/**
 * Portable Moment-like date formatter subset.
 */

import { utcWeekday } from './calendar.js';
import { resolveDateLocale } from './locale.js';
import { DateRuntimeError, type PlainDateTime } from './types.js';

const TOKENS = [
  'YYYY',
  'MMMM',
  'dddd',
  'MMM',
  'ddd',
  'SSS',
  'YY',
  'MM',
  'DD',
  'HH',
  'mm',
  'ss',
  'ZZ',
  'M',
  'D',
  'H',
  'm',
  's',
  'Z',
] as const;

type DateToken = (typeof TOKENS)[number];

export function formatDateTime(
  value: PlainDateTime,
  format: string | undefined,
  localeName: string | undefined,
): string {
  const locale = resolveDateLocale(localeName);
  const expanded = expandLocalizedFormat(format ?? 'L', locale.formats);
  let out = '';
  // Whether a day-of-month token has already been rendered. `MMMM` reads it to
  // choose between the two month forms — see `renderToken`.
  let afterDay = false;
  for (let i = 0; i < expanded.length; ) {
    const ch = expanded[i];
    if (ch === '[') {
      const end = expanded.indexOf(']', i + 1);
      if (end < 0) throw new DateRuntimeError(`date format: unterminated literal "${expanded}"`);
      out += expanded.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    const token = TOKENS.find((candidate) => expanded.startsWith(candidate, i));
    if (token) {
      out += renderToken(token, value, locale, afterDay);
      if (token === 'D' || token === 'DD') afterDay = true;
      i += token.length;
      continue;
    }

    out += ch ?? '';
    i += 1;
  }
  return out;
}

export function validateDateFormat(format: string): void {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '[') continue;
    const end = format.indexOf(']', i + 1);
    if (end < 0) throw new DateRuntimeError(`date format: unterminated literal "${format}"`);
    i = end;
  }
}

function expandLocalizedFormat(
  format: string,
  formats: Readonly<Record<'L' | 'LL' | 'LLL' | 'LLLL', string>>,
): string {
  if (format === 'ISO') return 'YYYY-MM-DD';
  if (format === 'ISO_TIME') return 'YYYY-MM-DDTHH:mm:ss';
  if (format === 'L' || format === 'LL' || format === 'LLL' || format === 'LLLL') {
    return formats[format];
  }
  return format;
}

/**
 * `afterDay` — whether a day-of-month token has already been rendered.
 *
 * Half the world writes the month differently depending on whether a day
 * number stands beside it. Slovak says `január` on its own and `15. januára
 * 2026` in a date; Finnish says `tammikuu` and `15. tammikuuta 2026`; Czech,
 * Croatian, Russian and Ukrainian all do the same. English and Hungarian do
 * not, and put the month first anyway.
 *
 * The rule is the one Moment settled on and every shipped `DATE_LOCALE.json`
 * already assumes: `MMMM` renders the in-date form when a day token came
 * BEFORE it, and the standalone form otherwise. It falls out of the format
 * string alone, so all five implementations can apply it identically:
 *
 *   D. MMMM YYYY      -> in-date     (Slovak, Czech, Finnish, Russian)
 *   MMMM D, YYYY      -> standalone  (English)
 *   YYYY. MMMM D.     -> standalone  (Hungarian, which wants the nominative)
 *   dddd, D MMMM YYYY -> in-date     (`dddd` is a weekday, not a day number)
 *
 * A locale with no such distinction sets `monthsInDate` equal to `months`, so
 * the branch costs it nothing.
 */
function renderToken(
  token: DateToken,
  value: PlainDateTime,
  locale: ReturnType<typeof resolveDateLocale>,
  afterDay: boolean,
): string {
  switch (token) {
    case 'YYYY':
      return pad(value.year, 4);
    case 'YY':
      return pad(value.year % 100, 2);
    case 'MMMM':
      return (
        (afterDay ? (locale.monthsInDate ?? locale.months) : locale.months)[value.month - 1] ?? ''
      );
    case 'MMM':
      return locale.monthsShort[value.month - 1] ?? '';
    case 'MM':
      return pad(value.month, 2);
    case 'M':
      return String(value.month);
    case 'DD':
      return pad(value.day, 2);
    case 'D':
      return String(value.day);
    case 'dddd':
      return locale.weekdays[utcWeekday(value)] ?? '';
    case 'ddd':
      return locale.weekdaysShort[utcWeekday(value)] ?? '';
    case 'HH':
      return pad(value.hour, 2);
    case 'H':
      return String(value.hour);
    case 'mm':
      return pad(value.minute, 2);
    case 'm':
      return String(value.minute);
    case 'ss':
      return pad(value.second, 2);
    case 's':
      return String(value.second);
    case 'SSS':
      return pad(value.millisecond, 3);
    case 'Z':
      return '+00:00';
    case 'ZZ':
      return '+0000';
  }
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
