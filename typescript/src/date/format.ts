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
  const expanded = expandNamed(format ?? 'L', locale.formats);
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

/**
 * Replace every named format with the tokens it stands for, once.
 *
 * Bracketed text is skipped, so `[LL]` stays the literal letters. The result is NOT
 * expanded again: a locale's own `LL` is written in plain tokens, and a second pass could
 * only find a name a locale had put there — which would be a loop, not a feature.
 */
function expandNamed(
  format: string,
  formats: Readonly<Record<'L' | 'LL' | 'LLL' | 'LLLL', string>>,
): string {
  let out = '';
  for (let i = 0; i < format.length; ) {
    if (format[i] === '[') {
      const end = format.indexOf(']', i + 1);
      if (end < 0) {
        // Left for the scanner to report, so the message names the same thing it always did.
        out += format.slice(i);
        break;
      }
      out += format.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const name = NAMED_FORMATS.find((candidate) => format.startsWith(candidate, i));
    if (name !== undefined) {
      out += namedFormat(name, formats);
      i += name.length;
      continue;
    }
    out += format[i] ?? '';
    i += 1;
  }
  return out;
}

/**
 * The letters a TOKEN is spelled with, plus the two a reader arrives with from elsewhere.
 *
 * `A`/`a` is Moment's AM/PM and `h` its 12-hour clock; TDC has neither, and a format
 * carrying them was written by somebody expecting them to work. Letters outside this set
 * — the `o` and `f` of `of`, the `t` and `e` of `date:` — are ordinary words, and a word
 * beside a date is a reasonable thing to write unbracketed.
 */
const TOKEN_LETTERS = new Set(Array.from('YMDdHhmsSZAaL'));

export function validateDateFormat(format: string): void {
  // Same walk the formatter does, so what is refused here is exactly what would have been
  // printed as literal text there. A near-miss token used to pass validation and then
  // print itself: `hh:mm A` gave `hh:00 A`, `YYY` gave `24Y`, and the run said nothing.
  for (let i = 0; i < format.length; ) {
    if (format[i] === '[') {
      const end = format.indexOf(']', i + 1);
      if (end < 0) throw new DateRuntimeError(`date format: unterminated literal "${format}"`);
      i = end + 1;
      continue;
    }
    const named = NAMED_FORMATS.find((candidate) => format.startsWith(candidate, i));
    if (named !== undefined) {
      i += named.length;
      continue;
    }
    const token = TOKENS.find((candidate) => format.startsWith(candidate, i));
    if (token !== undefined) {
      i += token.length;
      continue;
    }
    if (TOKEN_LETTERS.has(format[i] ?? '')) {
      // The whole run, so the message names what the writer typed rather than one letter.
      let end = i;
      while (end < format.length && TOKEN_LETTERS.has(format[end] ?? '')) end += 1;
      throw new DateRuntimeError(
        `date format: "${format.slice(i, end)}" is not a token — ` +
          `write it as [${format.slice(i, end)}] if it is meant to be literal text`,
      );
    }
    i += 1;
  }
}

/**
 * The named formats, longest first — the order the scanner has to try them in.
 *
 * `LLLL` before `LLL` before `LL` before `L`, and `ISO_TIME` before `ISO`, or a longer
 * name is read as a shorter one followed by letters nobody asked for.
 */
const NAMED_FORMATS = ['LLLL', 'LLL', 'LL', 'L', 'ISO_TIME', 'ISO'] as const;

type NamedFormat = (typeof NAMED_FORMATS)[number];

/**
 * What a named format stands for.
 *
 * These are TOKENS, not whole formats. The reference table documents them beside `YYYY`
 * and `MM`, and a reader who writes `LL [at] HH:mm` is owed the date the table promises.
 * They used to be matched against the WHOLE format string, so `LL` alone worked and
 * `LL HH:mm` printed the literal text `LL 00:00` — the config was accepted, the run
 * succeeded, and the file was wrong. That is the failure this project exists to refuse.
 */
function namedFormat(
  name: NamedFormat,
  formats: Readonly<Record<'L' | 'LL' | 'LLL' | 'LLLL', string>>,
): string {
  if (name === 'ISO') return 'YYYY-MM-DD';
  if (name === 'ISO_TIME') return 'YYYY-MM-DDTHH:mm:ss';
  return formats[name];
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
