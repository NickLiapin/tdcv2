package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.expr.Evaluate;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The {@code if=} expression language.
 *
 * <p>Most of these check behaviour that is easy to get subtly wrong in a port and impossible to
 * notice afterwards: an expression that binds differently changes which rows appear, and the
 * output still looks like perfectly good data.
 */
class ExpressionTest {

  private static Evaluate.Scope scope(Map<String, String> values) {
    return new Evaluate.Scope() {
      @Override
      public boolean has(String name) {
        return values.containsKey(name);
      }

      @Override
      public String value(String name) {
        return values.getOrDefault(name, "");
      }
    };
  }

  private static boolean eval(String expr, Map<String, String> values) {
    return Evaluate.asCondition(expr, scope(values));
  }

  private static boolean eval(String expr) {
    return eval(expr, Map.of());
  }

  @Test
  @DisplayName("the string \"false\" is false, which is what makes if=\"!_last\" work")
  void falseStringIsFalsy() {
    assertFalse(eval("_last", Map.of("_last", "false")));
    assertTrue(eval("!_last", Map.of("_last", "false")));
    assertTrue(eval("_last", Map.of("_last", "true")));
    // Everything else non-empty is true, including the word "no" — this is not a yes/no parser.
    assertTrue(eval("Flag", Map.of("Flag", "no")));
    assertFalse(eval("Flag", Map.of("Flag", "")));
  }

  @Test
  @DisplayName("an unknown name is its own value, so Gender == Male needs no quotes")
  void bareWordsAreLiterals() {
    assertTrue(eval("Gender == Male", Map.of("Gender", "Male")));
    assertFalse(eval("Gender == Male", Map.of("Gender", "Female")));
    assertTrue(eval("Gender != Male", Map.of("Gender", "Female")));
    assertTrue(eval("Gender == 'Male'", Map.of("Gender", "Male")));
  }

  @Test
  @DisplayName("a number compares equal to the numeric string of the same value")
  void looseEqualityAcrossTypes() {
    // _count arrives as text; the config writes a number. Both readings have to agree.
    assertTrue(eval("_count == 5", Map.of("_count", "5")));
    assertFalse(eval("_count == 5", Map.of("_count", "6")));
    assertTrue(eval("_count == 05", Map.of("_count", "5")));
    // A non-numeric string never equals a number rather than becoming NaN and comparing false
    // by accident.
    assertFalse(eval("Name == 5", Map.of("Name", "five")));
  }

  @Test
  @DisplayName("comparisons read both sides as numbers")
  void numericComparison() {
    assertTrue(eval("Age >= 18", Map.of("Age", "18")));
    assertFalse(eval("Age >= 18", Map.of("Age", "17")));
    assertTrue(eval("Age > 17 && Age < 19", Map.of("Age", "18")));
    assertTrue(eval("-5 < 0"));
  }

  @Test
  @DisplayName("&& binds tighter than ||, and parentheses override both")
  void precedence() {
    // false && false || true — with the wrong precedence this reads false && (false || true).
    assertTrue(eval("A == x && B == y || C == z", Map.of("A", "n", "B", "n", "C", "z")));
    assertFalse(eval("A == x && (B == y || C == z)", Map.of("A", "n", "B", "n", "C", "z")));
    // Comparison binds tighter than logic: this is (Age > 10) && (Age < 20).
    assertTrue(eval("Age > 10 && Age < 20", Map.of("Age", "15")));
    // Arithmetic binds tighter than comparison: 2 + 3 * 4 is 14, not 20.
    assertTrue(eval("2 + 3 * 4 == 14"));
  }

  @Test
  @DisplayName("A.B tests A's value when A.B is not itself a sequence")
  void dottedValueTest() {
    assertTrue(eval("Gender.Male", Map.of("Gender", "Male")));
    assertFalse(eval("Gender.Male", Map.of("Gender", "Female")));
    // A real compound field wins over the value test.
    assertTrue(eval("Person.Name == Ann", Map.of("Person.Name", "Ann", "Person", "x")));
  }

  @Test
  @DisplayName("! applies to the whole comparison to its right, not just the first name")
  void negation() {
    assertTrue(eval("!(Age >= 18)", Map.of("Age", "17")));
    assertFalse(eval("!Flag", Map.of("Flag", "yes")));
  }

  @Test
  @DisplayName("negating a name that is not a sequence is false, because the name is a word")
  void negatingAnUnknownName() {
    // Surprising, and checked against the reference rather than assumed: `Missing` is not a
    // column here, so it is the literal word "Missing" — a non-empty string, therefore true,
    // therefore `!Missing` is false. A typo in a column name reads as a constant, not as a
    // blank, which is exactly why `if=` conditions on a misspelled column never fire.
    assertFalse(eval("!Missing"));
    assertTrue(eval("Missing"));
  }

  @Test
  @DisplayName("a malformed expression is reported rather than quietly read as false")
  void malformedExpressionsThrow() {
    assertThrows(IllegalArgumentException.class, () -> eval("Age >="));
    assertThrows(IllegalArgumentException.class, () -> eval("(Age > 1"));
    assertThrows(IllegalArgumentException.class, () -> eval("Age > 1)"));
  }

  @Test
  @DisplayName("arithmetic on values works, and + joins text when neither side is a number")
  void arithmetic() {
    assertTrue(eval("Price * 2 == 10", Map.of("Price", "5")));
    assertTrue(eval("Total - Paid == 5", Map.of("Total", "15", "Paid", "10")));
    assertTrue(eval("A + B == xy", Map.of("A", "x", "B", "y")));
  }

  @Test
  @DisplayName("a column with no value on this row reads as empty, not as missing")
  void absentValueOnARow() {
    // A child column outside its parent's rows: the condition is false, and nothing throws.
    assertFalse(eval("FemaleName", Map.of("FemaleName", "")));
    assertEquals(true, eval("!FemaleName", Map.of("FemaleName", "")));
  }
}
