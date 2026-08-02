package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.date.DateFormatter;
import io.github.nickliapin.tdc.date.DateLocales;
import io.github.nickliapin.tdc.date.PlainDateTime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * The names a date prints, against the values the reference implementation prints.
 *
 * <p>The one place a port can look finished and be wrong without any test noticing: a date
 * generator that renders month names would silently fall back to English, and only a reader of
 * that language would ever spot it.
 */
class DateLocaleTest {

  private static final PlainDateTime OCT_18 = new PlainDateTime(2026, 10, 18, 0, 0, 0, 0);

  @ParameterizedTest
  @CsvSource(
      delimiter = '|',
      value = {
        "en|L|10/18/2026",
        "ru|LLLL|воскресенье, 18 октября 2026 г. 00:00",
        "es|LL|18 de octubre de 2026",
        "de|LL|18. Oktober 2026",
        "fr|LL|18 octobre 2026",
        "pt|LL|18 de outubro de 2026",
        "it|LL|18 ottobre 2026",
        "pl|LL|18 października 2026",
        "el|LL|18 Οκτωβρίου 2026",
        "zh-cn|LL|2026年10月18日",
        "ar|LL|18 أكتوبر 2026",
      })
  void printsItsOwnNames(String locale, String format, String expected) {
    assertEquals(expected, DateFormatter.format(OCT_18, format, locale));
  }

  @Test
  void anUnknownLanguageFallsBackRatherThanFailingTheRun() {
    // A country pack may name a language with no date table yet. English month names are a worse
    // answer than the right ones and a far better answer than no data at all.
    assertEquals("10/18/2026", DateFormatter.format(OCT_18, "L", "cs"));
    assertEquals("10/18/2026", DateFormatter.format(OCT_18, "L", null));
  }

  @Test
  void everyAdvertisedNameResolves() {
    for (String name : DateLocales.NAMES) {
      assertTrue(DateLocales.isKnown(name), name);
    }
  }
}
