package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.date.DateGen;
import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.generators.SymbolGen;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Each generator against values captured from the reference implementation.
 *
 * <p>Exact values, not shapes. Asserting that a number lands between 0 and 9999 would pass for a
 * port that drew the right kind of value in the wrong order, and order is the whole difficulty:
 * two implementations agree only when they consume the shared generator identically. These
 * vectors were produced by running the TypeScript generators with the seed {@code unit-test} and
 * pasting the output here.
 */
class GeneratorVectorTest {

  private static Prng.Sfc32 prng() {
    return Prng.create("unit-test");
  }

  private static void assertNumbers(Map<String, String> attrs, String... expected) {
    assertEquals(List.of(expected), NumberGen.generate(attrs, expected.length, prng()));
  }

  @Test
  @DisplayName("a range written with leading zeros pads to that width")
  void paddedRange() {
    assertNumbers(
        Map.of("value", "0000..9999"), "6924", "8003", "5645", "8474", "1428", "9498");
  }

  @Test
  @DisplayName("a range crossing zero, and bit")
  void plainRanges() {
    assertNumbers(Map.of("value", "-5..5"), "2", "3", "1", "4", "-4", "5");
    assertNumbers(Map.of("value", "bit"), "1", "1", "1", "1", "0", "1");
  }

  @Test
  @DisplayName("length with no value builds a digit string one digit at a time")
  void digitString() {
    // Four draws per value, not one — which is why this and a 1000..9999 range disagree.
    assertNumbers(
        Map.of("length", "4", "first_zero", "true"),
        "6858", "1930", "5365", "6550", "4178", "2938");
  }

  @Test
  @DisplayName("a list of ranges picks the range first, then the value")
  void rangeList() {
    assertNumbers(
        Map.of("value", "[1..3],[100..102]"), "102", "102", "3", "1", "100", "101");
  }

  @Test
  @DisplayName("exclude removes a value and the draw stays uniform over what is left")
  void excludeValue() {
    List<String> out =
        NumberGen.generate(Map.of("value", "0..9", "exclude", "3"), 6, prng());
    assertEquals(List.of("7", "8", "6", "8", "1", "9"), out);

    // One draw over the nine remaining values, never a redraw when it lands on 3 — a redraw
    // would consume a variable number of draws and desynchronise every column after it.
    List<String> many =
        NumberGen.generate(Map.of("value", "0..9", "exclude", "3"), 500, prng());
    assertTrue(many.stream().noneMatch("3"::equals), "an excluded value was produced");
  }

  @Test
  @DisplayName("decimals draw over the decimal grid in a single draw")
  void decimals() {
    assertNumbers(
        Map.of("value", "1..2", "decimals", "2"), "1.69", "1.80", "1.57", "1.85", "1.14", "1.95");
  }

  @Test
  @DisplayName("regex fills a pattern")
  void regexPattern() {
    assertEquals(
        List.of("UO-193", "NI-565", "AK-782", "JV-987", "ON-917", "LZ-045"),
        RegexGen.generate(Map.of("value", "[A-Z]{2}-\\d{3}"), 6, 32, prng()));
  }

  @Test
  @DisplayName("a backreference repeats what the group actually produced")
  void regexBackreference() {
    assertEquals(
        List.of("b-b", "b-b", "b-b", "b-b", "a-a", "b-b"),
        RegexGen.generate(Map.of("value", "([ab])-\\1"), 6, 32, prng()));
  }

  @Test
  @DisplayName("a bounded quantifier draws its repeat count, and zero repeats is empty")
  void regexBoundedRepeat() {
    assertEquals(
        List.of("xx", "xxx", "xx", "xxx", "", "xxx"),
        RegexGen.generate(Map.of("value", "x{0,3}"), 6, 32, prng()));
  }

  @Test
  @DisplayName("unbounded patterns and over-long ones are refused, not truncated")
  void regexRefusesUnbounded() {
    assertThrows(
        IllegalArgumentException.class,
        () -> RegexGen.generate(Map.of("value", "a*"), 1, 32, prng()));
    assertThrows(
        IllegalArgumentException.class,
        () -> RegexGen.generate(Map.of("value", "a+"), 1, 32, prng()));
    assertThrows(
        IllegalArgumentException.class,
        () -> RegexGen.generate(Map.of("value", "a{1,}"), 1, 32, prng()));
    // 40 characters against a limit of 32.
    assertThrows(
        IllegalArgumentException.class,
        () -> RegexGen.generate(Map.of("value", "[a-z]{40}"), 1, 32, prng()));
    // The same pattern passes when the tag raises its own limit.
    assertEquals(
        1,
        RegexGen.generate(Map.of("value", "[a-z]{40}", "regex_max_length", "64"), 1, 32, prng())
            .size());
  }

  @Test
  @DisplayName("symbol draws from a named alphabet")
  void symbolAlphabet() {
    assertEquals(
        List.of("suo", "wdy", "jan", "iqn", "rno", "akf"),
        SymbolGen.generate(Map.of("alphabet", "latin.lower", "length", "3"), 6, prng()));
  }

  @Test
  @DisplayName("symbol excludes a character from an inline set")
  void symbolExclude() {
    assertEquals(
        List.of("cccc", "acaa", "cacc", "ccca", "aacc", "acac"),
        SymbolGen.generate(Map.of("value", "[a-c]", "exclude", "b", "length", "4"), 6, prng()));
  }

  @Test
  @DisplayName("symbol needs exactly one of value and alphabet")
  void symbolRejectsAmbiguousPool() {
    assertThrows(
        IllegalArgumentException.class,
        () -> SymbolGen.generate(Map.of("value", "abc", "alphabet", "latin.lower"), 1, prng()));
    assertThrows(
        IllegalArgumentException.class, () -> SymbolGen.generate(Map.of("length", "2"), 1, prng()));
    assertThrows(
        IllegalArgumentException.class,
        () -> SymbolGen.generate(Map.of("alphabet", "klingon"), 1, prng()));
  }

  @Test
  @DisplayName("a date range with no times is drawn by day")
  void dateRangeByDay() {
    assertEquals(
        List.of(
            "2026-01-22", "2026-01-25", "2026-01-18", "2026-01-27", "2026-01-05", "2026-01-30"),
        DateGen.generate(
            Map.of("range", "2026-01-01..2026-01-31", "format", "YYYY-MM-DD"), "en", 0, 6, prng()));
  }

  @Test
  @DisplayName("precision=second draws a second inside the range, not a day")
  void dateRangeBySecond() {
    assertEquals(
        List.of(
            "2026-01-01T16:37:05",
            "2026-01-01T19:12:27",
            "2026-01-01T13:33:00",
            "2026-01-01T20:20:18",
            "2026-01-01T03:25:40",
            "2026-01-01T22:47:45"),
        DateGen.generate(
            Map.of(
                "range",
                "2026-01-01T00:00:00..2026-01-01T23:59:59",
                "format",
                "ISO_TIME",
                "precision",
                "second"),
            "en",
            0,
            6,
            prng()));
  }

  @Test
  @DisplayName("an impossible date is rejected rather than rolled into the next month")
  void dateRejectsImpossibleDays() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            DateGen.generate(Map.of("value", "2026-02-30"), "en", 0, 1, prng()));
    // 2024 is a leap year and 2026 is not, so the same day is valid in one and not the other.
    assertEquals(
        1, DateGen.generate(Map.of("value", "2024-02-29", "format", "ISO"), "en", 0, 1, prng()).size());
    assertThrows(
        IllegalArgumentException.class,
        () -> DateGen.generate(Map.of("value", "2026-02-29"), "en", 0, 1, prng()));
  }
}
