package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@code <gen type="number">} — the range grammar and what it refuses.
 *
 * <p>The shared fixtures pin the values a valid range produces. What they carry almost none of
 * is the other half: a range that cannot be read has to be REFUSED, and a port that quietly
 * repaired one — took the bounds the other way round, or read "1..x" as 1 — would produce a
 * column that looks entirely reasonable and is not the one the config asked for.
 */
class NumberGenTest {

  private static List<String> gen(String value, int count) {
    Map<String, String> attrs = new HashMap<>();
    attrs.put("value", value);
    return NumberGen.generate(attrs, count, Prng.create("unit-test"));
  }

  private static String refuse(String value) {
    RuntimeException thrown = assertThrows(RuntimeException.class, () -> gen(value, 1));
    String message = thrown.getMessage();
    return message == null ? "" : message;
  }

  @Test
  @DisplayName("a plain range stays inside its bounds, ends included")
  void plainRange() {
    boolean sawLow = false;
    boolean sawHigh = false;
    for (String value : gen("1..5", 500)) {
      int n = Integer.parseInt(value);
      assertTrue(n >= 1 && n <= 5, value);
      sawLow |= n == 1;
      sawHigh |= n == 5;
    }
    assertTrue(sawLow && sawHigh, "both ends of the range should be reachable");
  }

  @Test
  @DisplayName("a range that crosses zero produces both signs")
  void negativeRange() {
    boolean negative = false;
    boolean positive = false;
    for (String value : gen("-5..5", 200)) {
      int n = Integer.parseInt(value);
      assertTrue(n >= -5 && n <= 5, value);
      negative |= n < 0;
      positive |= n > 0;
    }
    assertTrue(negative && positive, "a range across zero should reach both sides");
  }

  @Test
  @DisplayName("leading zeros in the bounds pad the output to that width")
  void paddedRange() {
    for (String value : gen("0000..9999", 100)) {
      assertEquals(4, value.length(), value);
    }
  }

  @Test
  @DisplayName("value=\"bit\" is 0 or 1, and reaches both")
  void bit() {
    boolean zero = false;
    boolean one = false;
    for (String value : gen("bit", 100)) {
      assertTrue("0".equals(value) || "1".equals(value), value);
      zero |= "0".equals(value);
      one |= "1".equals(value);
    }
    assertTrue(zero && one, "a bit should take both values over 100 rows");
  }

  @Test
  @DisplayName("a single number is a range of one")
  void singleValue() {
    assertEquals(List.of("7", "7", "7"), gen("7", 3));
  }

  @Test
  @DisplayName("a list of ranges draws from all of them and from nothing between")
  void rangeList() {
    boolean low = false;
    boolean high = false;
    for (String value : gen("[1..3],[90..92]", 300)) {
      int n = Integer.parseInt(value);
      assertTrue((n >= 1 && n <= 3) || (n >= 90 && n <= 92), value);
      low |= n <= 3;
      high |= n >= 90;
    }
    assertTrue(low && high, "both ranges of the list should be drawn from");
  }

  @Test
  @DisplayName("an empty range is refused rather than read as zero")
  void emptyRange() {
    // Asserted on the parser rather than through generate(): an empty `value=` never reaches
    // the generator, because the validator refuses the config first (TDC081, and the same in
    // all five). What is pinned here is that the parser does not quietly answer "no ranges".
    assertTrue(
        assertThrows(RuntimeException.class, () -> NumberGen.parseRanges(""))
            .getMessage()
            .contains("range is empty"));
    assertTrue(
        assertThrows(RuntimeException.class, () -> NumberGen.parseRanges("   "))
            .getMessage()
            .contains("range is empty"));
  }

  @Test
  @DisplayName("bounds the wrong way round are refused rather than swapped")
  void invertedRange() {
    // Swapping them would be a silent repair: the config said something impossible and the
    // column would come out looking fine.
    assertTrue(refuse("9..1").contains("invalid numeric range"));
  }

  @Test
  @DisplayName("a range that is not a range is refused rather than partly read")
  void malformed() {
    assertTrue(refuse("1..x").length() > 0);
    assertTrue(refuse("..5").length() > 0);
    assertTrue(refuse("1..").length() > 0);
    assertTrue(refuse("one..five").length() > 0);
  }

  @Test
  @DisplayName("a bracketed list must actually close")
  void unclosedList() {
    assertTrue(refuse("[1..3").contains("invalid range list"));
    assertTrue(refuse("1..3]").contains("invalid range list"));
  }

  @Test
  @DisplayName("the same seed gives the same column, twice running")
  void deterministic() {
    assertEquals(gen("1..1000000", 50), gen("1..1000000", 50));
  }
}
