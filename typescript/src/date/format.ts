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
      out += renderToken(token, value, locale);
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

function renderToken(
  token: DateToken,
  value: PlainDateTime,
  locale: ReturnType<typeof resolveDateLocale>,
): string {
  switch (token) {
    case 'YYYY':
      return pad(value.year, 4);
    case 'YY':
      return pad(value.year % 100, 2);
    case 'MMMM':
      return locale.months[value.month - 1] ?? '';
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
