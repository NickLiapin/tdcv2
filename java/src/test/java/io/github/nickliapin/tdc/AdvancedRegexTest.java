package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** {@code advanced_regex} — the pattern dialect with exact shares. */
class AdvancedRegexTest {

  private static List<String> gen(String pattern, int count) {
    return AdvancedRegexGen.generate(
        Map.of("value", pattern), count, 32, Prng.create("unit-test"));
  }

  @Test
  @DisplayName("a weighted choice matches the reference value for value")
  void weightedChoice() {
    assertEquals(
        List.of("RU", "RU", "DE", "RU", "US", "RU", "RU", "RU", "US", "RU"),
        gen("(?%{70:RU;20:US;10:DE})", 10));
  }

  @Test
  @DisplayName("the shares are exact over the column, not approximate")
  void sharesAreExact() {
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (String value : gen("(?%{70:RU;20:US;10:DE})", 100)) {
      counts.merge(value, 1, Integer::sum);
    }
    // Exactly 70, not "about 70" — the whole reason this generator exists apart from `regex`.
    assertEquals(70, counts.get("RU"));
    assertEquals(20, counts.get("US"));
    assertEquals(10, counts.get("DE"));
  }

  @Test
  @DisplayName("weighted choices compose, side by side and nested")
  void composedChoices() {
    assertEquals(
        List.of("ay", "ay", "bx", "ax", "bx", "ay", "by", "ax", "by", "bx"),
        gen("(?%{50:a;50:b})(?%{50:x;50:y})", 10));
    assertEquals(
        List.of("aa", "ab", "b", "ab", "b", "aa", "ab", "aa", "b", "b"),
        gen("(?%{60:(?%{50:aa;50:ab});40:b})", 10));
  }

  @Test
  @DisplayName("a branch is a full pattern, not just a literal")
  void branchesArePatterns() {
    assertEquals(
        List.of("58", "02", "OU", "49", "NE", "13", "CL", "78", "ZZ", "EE"),
        gen("(?%{50:[0-9]{2};50:[A-Z]{2}})", 10));
  }

  @Test
  @DisplayName("the ordinary regex constructs still work, drawn column-wise")
  void plainConstructs() {
    // Different values from the plain `regex` generator for the same pattern, and that is
    // expected: this dialect builds every row together, so it consumes the stream in a
    // different order. Exact shares are what require it.
    assertEquals(
        List.of("JR-654", "AN-909", "NO-891", "IA-710", "QK-774", "NF-515"),
        gen("[A-Z]{2}-\\d{3}", 6));
    assertEquals(List.of("xx", "xxx", "xx", "xxx", "", "xxx"), gen("x{0,3}", 6));
    assertEquals(List.of("b-b", "b-b", "b-b", "b-b", "a-a", "b-b"), gen("([ab])-\\1", 6));
  }

  @Test
  @DisplayName("percentages that do not add to 100 are refused")
  void percentagesMustSum() {
    IllegalArgumentException e =
        assertThrows(IllegalArgumentException.class, () -> gen("(?%{70:a;20:b})", 4));
    assertTrue(e.getMessage().contains("expected 100"), e.getMessage());
    assertThrows(IllegalArgumentException.class, () -> gen("(?%{})", 4));
    assertThrows(IllegalArgumentException.class, () -> gen("(?%{50:a;50:b", 4));
    assertThrows(IllegalArgumentException.class, () -> gen("(?%{50:a,50:b})", 4));
  }

  @Test
  @DisplayName("the unbounded quantifiers stay refused here too")
  void stillFinite() {
    assertThrows(IllegalArgumentException.class, () -> gen("a*", 1));
    assertThrows(IllegalArgumentException.class, () -> gen("a+", 1));
    assertThrows(IllegalArgumentException.class, () -> gen("[a-z]{40}", 1));
  }

  @Test
  @DisplayName("a pattern reports whether it needs a whole column")
  void detectsWeightedChoice() {
    assertTrue(AdvancedRegexGen.hasWeightedChoice("(?%{70:a;30:b})"));
    assertFalse(AdvancedRegexGen.hasWeightedChoice("[A-Z]{2}"));
    // A malformed pattern answers no rather than throwing; the real error surfaces on the run.
    assertFalse(AdvancedRegexGen.hasWeightedChoice("(?%{70:a"));
  }

  @Test
  @DisplayName("it works through a config")
  void endToEnd() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc regex_max_length="40">
                  <env mode="memory" count="10" seed="adv" local="en">
                    <sequence name="Country">
                      <gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Country}}</data></line></block>
                </tdc>
                """)
            .build();
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (TDC.Row row : tdc.iterate()) {
      counts.merge(row.get("Country"), 1, Integer::sum);
    }
    assertEquals(7, counts.get("RU"));
    assertEquals(2, counts.get("US"));
    assertEquals(1, counts.get("DE"));
  }

  // ── named groups and conditionals ──────────────────────────────────────────────────────
  //
  // The constructs that let one part of a value follow another. The reference has a suite of
  // them and this port had none, which is the asymmetry that hides a divergence: a refusal
  // that fires there and not here is a config the two disagree about.

  /** The message a refused pattern carries, so a test can say WHICH refusal it expects. */
  private static String refuse(String pattern) {
    RuntimeException thrown = assertThrows(RuntimeException.class, () -> gen(pattern, 1));
    String message = thrown.getMessage();
    return message == null ? "" : message;
  }

  @Test
  @DisplayName("a conditional reads a named group and follows it")
  void conditionalFollowsItsGroup() {
    for (String value : gen("(?<sex>(?%{50:male;50:female}))/(?if{sex=male:Mr;sex=female:Ms})", 40)) {
      String[] halves = value.split("/");
      assertEquals(halves[0].equals("male") ? "Mr" : "Ms", halves[1], value);
    }
  }

  @Test
  @DisplayName("a conditional READS the weighted choice without disturbing it")
  void conditionalTakesNoDraw() {
    // The exact shares are the point of this generator, so a conditional that consumed a draw
    // would move every value after it and quietly break the one promise it makes.
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (String value : gen("(?<c>(?%{70:RU;20:US;10:DE}))-(?if{c=RU:x;*:y})", 200)) {
      counts.merge(value.split("-")[0], 1, Integer::sum);
    }
    assertEquals(140, counts.get("RU"));
    assertEquals(40, counts.get("US"));
    assertEquals(20, counts.get("DE"));
  }

  @Test
  @DisplayName("a row matching no branch produces nothing for that part")
  void noBranchMatches() {
    // Deliberate: the pattern said nothing about that value, and quietly taking the first
    // branch would pair the wrong things together in a file that otherwise looks right.
    for (String value : gen("(?<c>(?%{50:a;50:b}))-(?if{c=zzz:NEVER})", 10)) {
      assertTrue(value.endsWith("-"), value);
    }
  }

  @Test
  @DisplayName("a group name that repeats is refused, side by side or nested")
  void duplicateGroupName() {
    assertTrue(refuse("(?<a>x)(?<a>y)").contains("already used"));
    assertTrue(refuse("(?<a>(?<a>y))").contains("already used"));
  }

  @Test
  @DisplayName("a group name that is not a name is refused")
  void badGroupName() {
    assertTrue(refuse("(?<>x)").contains("needs a name"));
    assertTrue(refuse("(?<2fast>x)").contains("must start with a letter"));
  }

  @Test
  @DisplayName("a conditional reading a group declared LATER is refused")
  void forwardConditional() {
    // Built left to right, so that group has produced nothing and the branch could never be
    // taken — a check that silently never fires is worse than one that refuses.
    assertTrue(
        refuse("(?if{c=x:y})(?<c>(?%{100:x}))")
            .contains("which no (?<c>…) group before it declares"));
  }

  @Test
  @DisplayName("a branch with no name=value test is refused")
  void branchWithoutTest() {
    assertTrue(refuse("(?<c>(?%{100:x}))(?if{justtext})").length() > 0);
  }

  @Test
  @DisplayName("lookbehind stays lookbehind rather than becoming a group named \"=\"")
  void lookbehindIsNotAName() {
    assertTrue(refuse("(?<=a)b").length() > 0);
    assertTrue(refuse("(?<!a)b").length() > 0);
  }
}
