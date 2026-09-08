package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The regex generator: what it accepts, what it refuses, and why the refusals are the
 * interesting half.
 *
 * <p>Reading a pattern FORWARDS is a different job from matching one backwards, and the
 * difference shows up as a set of restrictions no matching engine has. Each exists so a config
 * cannot ask for a file of unbounded size.
 *
 * <p>The reference had 49 tests here and this port had none, which is the asymmetry worth
 * closing: a refusal that fires in TypeScript and not here is a config the two implementations
 * disagree about, and the shared fixtures only carry a handful of them.
 */
class RegexGenTest {

  private static List<String> gen(String pattern, int count) {
    return gen(pattern, count, 32);
  }

  private static List<String> gen(String pattern, int count, int maxLength) {
    Map<String, String> attrs = new HashMap<>();
    attrs.put("value", pattern);
    return RegexGen.generate(attrs, count, maxLength, Prng.create("unit-test"));
  }

  /** The message a refused pattern carries, so a test can say WHICH refusal it expects. */
  private static String refuse(String pattern) {
    RuntimeException thrown = assertThrows(RuntimeException.class, () -> gen(pattern, 1));
    String message = thrown.getMessage();
    return message == null ? "" : message;
  }

  @Nested
  @DisplayName("what it builds")
  class Building {

    @Test
    @DisplayName("fills a bounded pattern and varies between rows")
    void bounded() {
      List<String> out = gen("[A-Z]{2}[0-9]{6}", 100);
      assertEquals(100, out.size());
      for (String value : out) {
        assertTrue(value.matches("[A-Z]{2}[0-9]{6}"), value);
      }
      assertTrue(out.stream().distinct().count() > 1, "a drawn pattern should not be constant");
    }

    @Test
    @DisplayName("a backreference repeats what its group actually produced")
    void backreference() {
      for (String value : gen("([A-Z]{2})-\\1", 20)) {
        String[] halves = value.split("-");
        assertEquals(halves[0], halves[1], value);
      }
    }

    @Test
    @DisplayName("a named group is reached by name and by number alike")
    void namedGroup() {
      for (String value : gen("(?<code>[A-Z]{2})-\\k<code>", 20)) {
        assertEquals(value.split("-")[0], value.split("-")[1], value);
      }
      for (String value : gen("(?<code>[A-Z]{2})-\\1", 20)) {
        assertEquals(value.split("-")[0], value.split("-")[1], value);
      }
    }

    @Test
    @DisplayName("a conditional follows whether its group produced anything")
    void conditional() {
      boolean sawBoth = false;
      boolean sawDash = false;
      boolean sawWord = false;
      for (String value : gen("(?<area>[0-9]{3})?(?(area)-|nat )[0-9]{4}", 200)) {
        assertTrue(value.matches("[0-9]{3}-[0-9]{4}|nat [0-9]{4}"), value);
        sawDash |= value.contains("-");
        sawWord |= value.startsWith("nat ");
      }
      sawBoth = sawDash && sawWord;
      assertTrue(sawBoth, "both branches should be reachable over 200 rows");
    }

    @Test
    @DisplayName("a conditional draws nothing of its own")
    void conditionalTakesNoDraw() {
      // Reading a decision costs no randomness, so the digits either side are untouched. An
      // implementation that consumed a draw here would shift every value after it.
      assertEquals(gen("(?<a>[xy])Z[0-9]{4}", 30), gen("(?<a>[xy])(?(a)Z)[0-9]{4}", 30));
    }

    @Test
    @DisplayName("a dot is a printable ASCII character, not almost anything")
    void dotIsPrintableAscii() {
      for (String value : gen(".{8}", 50)) {
        for (char c : value.toCharArray()) {
          assertTrue(c >= ' ' && c <= '~', "got " + (int) c);
        }
      }
    }

    @Test
    @DisplayName("an anchor contributes nothing, because the value is the whole string")
    void anchors() {
      for (String value : gen("^[a-z]{3}$", 20)) {
        assertTrue(value.matches("[a-z]{3}"), value);
      }
    }

    @Test
    @DisplayName("regex_max_length lets an already-finite pattern be longer")
    void maxLength() {
      assertEquals(40, gen("[A-Z]{40}", 1, 64).get(0).length());
      assertTrue(refuse("[A-Z]{40}").contains("regex_max_length"));
    }
  }

  @Nested
  @DisplayName("what it refuses, and why")
  class Refusing {

    @Test
    @DisplayName("an unbounded quantifier, because the file would have no size")
    void unbounded() {
      assertTrue(refuse("[a-z]+").contains("unbounded"));
      assertTrue(refuse("[a-z]*").contains("unbounded"));
      assertTrue(refuse("[a-z]{1,}").contains("unbounded"));
    }

    @Test
    @DisplayName("a lazy or stacked quantifier, which is matcher grammar")
    void lazyAndStacked() {
      assertTrue(refuse("[a-z]{1,3}?").contains("lazy"));
      assertTrue(refuse("[a-z]{1,3}{2}").contains("stacked"));
    }

    @Test
    @DisplayName("lookaround, which inspects text rather than building it")
    void lookaround() {
      assertTrue(refuse("(?=a)a").contains("lookaround"));
      assertTrue(refuse("(?!a)a").contains("lookaround"));
      assertTrue(refuse("(?<=a)b").contains("lookaround"));
      assertTrue(refuse("(?<!a)b").contains("lookaround"));
    }

    @Test
    @DisplayName("a backreference to a group that has not been generated yet")
    void forwardBackreference() {
      assertTrue(refuse("\\1([0-9])").contains("not generated yet"));
      assertTrue(refuse("(A\\1)").contains("not generated yet"));
      assertTrue(refuse("(A)\\2").contains("not generated yet"));
    }

    @Test
    @DisplayName("a group name that repeats, even nested")
    void duplicateGroupName() {
      assertTrue(refuse("(?<a>x)(?<a>y)").contains("already used"));
      assertTrue(refuse("(?<a>(?<a>y))").contains("already used"));
    }

    @Test
    @DisplayName("a group name that is not a name")
    void badGroupName() {
      assertTrue(refuse("(?<>x)").contains("needs a name"));
      assertTrue(refuse("(?<2fast>x)").contains("must start with a letter"));
      assertTrue(refuse("(?<a-b>x)").contains("must start with a letter"));
    }

    @Test
    @DisplayName("a named reference that could not have been produced")
    void badNamedReference() {
      assertTrue(refuse("\\k<code>(?<code>[A-Z])").contains("not generated yet"));
      assertTrue(refuse("(?<code>[A-Z])\\k<other>").contains("not generated yet"));
      assertTrue(refuse("(?<code>[A-Z])\\kcode").contains("named backreference is written"));
    }

    @Test
    @DisplayName("a conditional whose test could never be true")
    void badConditional() {
      assertTrue(refuse("(?(area)-)(?<area>[0-9])").contains("not generated yet"));
      assertTrue(refuse("(?(1)-)([0-9])").contains("not generated yet"));
      assertTrue(refuse("([0-9])(?(2)-)").contains("not generated yet"));
      assertTrue(refuse("([0-9])(?()-)").contains("needs a group to test"));
    }

    @Test
    @DisplayName("a third conditional branch, rather than guessing which two count")
    void threeBranches() {
      assertTrue(refuse("([0-9])(?(1)a|b|c)").contains("at most two branches"));
    }

    @Test
    @DisplayName("a character class that can produce nothing")
    void emptyClasses() {
      assertTrue(refuse("[]").contains("empty character class"));
      assertTrue(refuse("[z-a]").contains("invalid character range"));
    }

    @Test
    @DisplayName("a Unicode property class, which is not portable")
    void unicodeProperties() {
      assertTrue(refuse("\\p{L}").contains("Unicode property"));
      assertTrue(refuse("[\\p{L}]").contains("Unicode property"));
    }

    @Test
    @DisplayName("a multiline escape, because a row is one line")
    void multiline() {
      assertTrue(refuse("a\\n").contains("multiline"));
      assertTrue(refuse("a\\r").contains("multiline"));
    }

    @Test
    @DisplayName("an alphabet escape that names nothing")
    void namedAlphabets() {
      assertTrue(refuse("\\a{}").contains("non-empty name"));
      assertTrue(refuse("\\a{nosuch}").contains("unknown alphabet"));
      assertTrue(refuse("[\\a{nosuch}]").contains("unknown alphabet"));
    }

    @Test
    @DisplayName("a quantifier with nothing to repeat")
    void danglingQuantifier() {
      assertTrue(refuse("{2}").contains("has no target"));
      assertTrue(refuse("?abc").contains("has no target"));
    }

    @Test
    @DisplayName("a regex_max_length that is not a positive whole number")
    void badMaxLength() {
      assertThrows(RuntimeException.class, () -> RegexGen.parseMaxLength("0"));
      assertThrows(RuntimeException.class, () -> RegexGen.parseMaxLength("-4"));
      assertThrows(RuntimeException.class, () -> RegexGen.parseMaxLength("wide"));
      assertEquals(64, RegexGen.parseMaxLength("64"));
    }
  }
}
