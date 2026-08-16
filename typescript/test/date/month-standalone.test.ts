import { describe, expect, it } from 'vitest';

import { formatDateTime } from '../../src/date/format.js';
import { DATE_LOCALE_NAMES, resolveDateLocale } from '../../src/date/locale.js';
import type { PlainDateTime } from '../../src/date/types.js';

/**
 * A month has two forms in half the languages TDC ships, and until now the
 * engine could only produce one of them.
 *
 * `months` had always held the IN-DATE form for the six locales that
 * distinguish the two — `января`, `stycznia`, `січня`, `Ιανουαρίου`, `ledna`,
 * `tammikuuta`. That is why `LL` read correctly and why a plain
 * `format="MMMM"` — a month column, a report heading, a dropdown — printed
 * `января` where Russian wants `январь`. The wrong half was the one nobody
 * had a test for.
 *
 * The rule is the one Moment settled on and every shipped `DATE_LOCALE.json`
 * already assumes: the in-date form appears when a day number came BEFORE the
 * month in the format string. It reads off the format alone, so all five
 * implementations can apply it identically.
 */

const JAN_15: PlainDateTime = {
  year: 2026,
  month: 1,
  day: 15,
  hour: 14,
  minute: 5,
  second: 0,
  millisecond: 0,
};

const at = (format: string, locale: string): string => formatDateTime(JAN_15, format, locale);

/** locale → [standalone, in-date] for January. */
const TWO_FORMS: readonly (readonly [string, string, string])[] = [
  ['ru', 'январь', 'января'],
  ['pl', 'styczeń', 'stycznia'],
  ['uk', 'січень', 'січня'],
  ['el', 'Ιανουάριος', 'Ιανουαρίου'],
  ['cs', 'leden', 'ledna'],
  ['fi', 'tammikuu', 'tammikuuta'],
];

describe('the month takes its in-date form only beside a day number', () => {
  for (const [locale, standalone, inDate] of TWO_FORMS) {
    it(`${locale}: MMMM alone is "${standalone}", after a day it is "${inDate}"`, () => {
      expect(at('MMMM', locale)).toBe(standalone);
      expect(at('D MMMM', locale)).toBe(`15 ${inDate}`);
      expect(at('DD MMMM', locale)).toBe(`15 ${inDate}`);
      // A weekday token is not a day number.
      expect(at('dddd MMMM', locale)).toContain(standalone);
      // Month first, day after — the month is not "in" the date yet.
      expect(at('MMMM D', locale)).toContain(standalone);
    });
  }

  it('LL did not move for anyone — this fix must not re-baseline a single date', () => {
    expect(at('LL', 'ru')).toBe('15 января 2026 г.');
    expect(at('LL', 'cs')).toBe('15. ledna 2026');
    expect(at('LL', 'fi')).toBe('15. tammikuuta 2026');
    expect(at('LL', 'pl')).toBe('15 stycznia 2026');
    expect(at('LL', 'uk')).toBe('15 січня 2026');
    expect(at('LL', 'el')).toBe('15 Ιανουαρίου 2026');
    expect(at('LL', 'en')).toBe('January 15, 2026');
  });

  it('Hungarian writes the month BEFORE the day, and wants the nominative there', () => {
    // Its own LL is `YYYY. MMMM D.`, so the rule leaves it alone — which is
    // right: Hungarian has no separate in-date form to switch to.
    expect(at('LL', 'hu')).toBe('2026. január 15.');
    expect(at('MMMM', 'hu')).toBe('január');
  });

  it('a locale with one form is unaffected whichever way round the tokens sit', () => {
    for (const locale of ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'tr', 'ja']) {
      expect(at('D MMMM', locale)).toBe(`15 ${at('MMMM', locale)}`);
    }
  });

  it('every locale that declares monthsInDate declares twelve of them', () => {
    let withTwoForms = 0;
    for (const name of DATE_LOCALE_NAMES) {
      const locale = resolveDateLocale(name);
      if (locale.monthsInDate === undefined) continue;
      withTwoForms++;
      expect(locale.monthsInDate, name).toHaveLength(12);
      expect(locale.months, name).toHaveLength(12);
      // Declaring the field and then repeating `months` would be dead weight.
      expect(locale.monthsInDate, name).not.toStrictEqual(locale.months);
    }
    expect(withTwoForms).toBe(TWO_FORMS.length);
  });
});
