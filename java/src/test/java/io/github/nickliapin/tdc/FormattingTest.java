package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.format.Mask;
import io.github.nickliapin.tdc.format.Transforms;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The formatting layer, against values captured from the reference. */
class FormattingTest {

  private static void mask(String expected, String pattern, String input) {
    assertEquals(expected, Mask.apply(pattern, input), pattern + " on " + input);
  }

  private static void filter(String expected, String kind, String arg, String value) {
    assertEquals(expected, Transforms.applyFilter(kind, arg, value), kind + ":" + arg);
  }

  @Test
  @DisplayName("bare slots consume the input left to right")
  void consumingSlots() {
    mask("555-123-4567", "xxx-xxx-xxxx", "5551234567");
    mask("one two", "w w", "one two three");
    mask("anything at all", "*", "anything at all");
  }

  @Test
  @DisplayName("an index reads the original input, so the same notation moves or copies")
  void indexedSlots() {
    // Nothing else claims word 0 or 1, so this reads as a move: the words swap.
    mask("Smith John", "w[1] w[0]", "John Smith");
    // The `*` picks up what the index left, so the index reads as a copy: J is printed twice.
    mask("J. ohn Smith", "x[0]. *", "John Smith");
    mask("John Smith", "w[0] *", "John Smith");
    mask("ab", "x[0]x[1]", "abcdef");
    mask("f", "x[-1]", "abcdef");
    mask("abc", "x[0..2]", "abcdef");
    // A backwards range walks backwards, which is how a value gets reversed.
    mask("cba", "x[2..0]", "abcdef");
    mask("two three", "w[1..2]", "one two three four");
  }

  @Test
  @DisplayName("an out-of-range index emits nothing instead of failing the run")
  void indexOutOfRange() {
    // The length of a value is not known until it is generated, so there is nothing to check a
    // mask against beforehand. Stopping a million-row run over one short value would be worse.
    mask("", "x[9]", "abc");
  }

  @Test
  @DisplayName("a bracket is index syntax only right after an x or a w")
  void bracketsElsewhereAreLiteral() {
    mask("[tel.] 555", "[tel.] xxx", "5551234");
    mask("ab[c", "xx\\[x", "abcdef");
  }

  @Test
  @DisplayName("a malformed index is named rather than treated as text")
  void malformedIndex() {
    assertThrows(IllegalArgumentException.class, () -> Mask.apply("x[1-3]", "abcdef"));
    assertThrows(IllegalArgumentException.class, () -> Mask.apply("w[a]", "one two"));
  }

  @Test
  @DisplayName("slice, replace, trim and group")
  void textFilters() {
    filter("abc", "slice", "0,3", "abcdefgh");
    filter("cdefgh", "slice", "2", "abcdefgh");
    filter("a b c", "replace", "-, ", "a-b-c");
    filter("hi", "trim", null, "  hi  ");
    // Grouped from the right, so the last group stays whole — 1 234 567, not 123 456 7.
    filter("1 234 567", "group", "3", "1234567");
    filter("1234-5678-9012-3456", "group", "4,-", "1234567890123456");
  }

  @Test
  @DisplayName("compact shortens a whole number and leaves anything else alone")
  void compactFilter() {
    filter("lfls", "compact", null, "1000000");
    filter("ff", "compact", "16", "255");
    filter("notanumber", "compact", null, "notanumber");
  }

  @Test
  @DisplayName("csv quotes unconditionally and sql doubles apostrophes")
  void escapingFilters() {
    filter("\"Knife set, 3 pcs\"", "csv", null, "Knife set, 3 pcs");
    filter("\"say \"\"hi\"\"\"", "csv", null, "say \"hi\"");
    filter("O''Brien", "sql", null, "O'Brien");
  }

  @Test
  @DisplayName("an unknown filter passes the value through")
  void unknownFilterIsLenient() {
    filter("x", "unknownfilter", null, "x");
  }

  @Test
  @DisplayName("capitalize and title touch only the first letter of a word")
  void caseTransforms() {
    assertEquals("JOHN MCDONALD", Transforms.applyCase("upper", "jOHN mcDONALD"));
    assertEquals("john mcdonald", Transforms.applyCase("lower", "jOHN mcDONALD"));
    assertEquals("JOHN mcDONALD", Transforms.applyCase("capitalize", "jOHN mcDONALD"));
    // "mcDONALD" becomes "McDONALD", not "Mcdonald" — an already-correct name is not flattened.
    assertEquals("JOHN McDONALD", Transforms.applyCase("title", "jOHN mcDONALD"));
  }

  @Test
  @DisplayName("an unknown name keeps its marker, so a typo is visible in the output")
  void unknownNamesStayVisible() {
    Map<String, String> row = Map.of("Gender", "Male");
    Interpolate.Lookup lookup = lookup(row);
    assertEquals("Male", Interpolate.apply("${{Gender}}", "${{%}}", lookup));
    // Substituting an empty string here would hide the typo inside data that still looks fine.
    assertEquals("${{Gendre}}", Interpolate.apply("${{Gendre}}", "${{%}}", lookup));
  }

  @Test
  @DisplayName("the inject marker is configurable")
  void customInjectMarker() {
    Interpolate.Lookup lookup = lookup(Map.of("Name", "Ann"));
    assertEquals("hi Ann", Interpolate.apply("hi <<Name>>", "<<%>>", lookup));
    assertEquals("hi ${{Name}}", Interpolate.apply("hi ${{Name}}", "<<%>>", lookup));
    // An inject with no % names nothing, so the text passes through untouched.
    assertEquals("hi ${{Name}}", Interpolate.apply("hi ${{Name}}", "nopercent", lookup));
  }

  @Test
  @DisplayName("filters chain left to right inside an interpolation")
  void filterChain() {
    Interpolate.Lookup lookup = lookup(Map.of("Phone", "5551234567", "Name", "o'brien"));
    assertEquals(
        "555-123-4567", Interpolate.apply("${{Phone|mask:xxx-xxx-xxxx}}", "${{%}}", lookup));
    // Only the first letter — capitalize is not a name formatter, and an apostrophe is not a
    // word boundary, so this is "O'brien" rather than "O'Brien".
    assertEquals("O'brien", Interpolate.apply("${{Name|capitalize}}", "${{%}}", lookup));
    assertEquals("O''BRIEN", Interpolate.apply("${{Name|upper|sql}}", "${{%}}", lookup));
  }

  @Test
  @DisplayName("mask= and case= run over a whole column, mask first")
  void attributesOnAGen() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="3" seed="fmt" local="en">
                    <sequence name="Phone">
                      <gen type="number" length="10" first_zero="false" mask="(xxx) xxx-xxxx"/>
                    </sequence>
                    <sequence name="Code">
                      <gen type="symbol" alphabet="latin.lower" length="4" case="upper"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Phone}} ${{Code}}</data></line></block>
                </tdc>
                """)
            .build();
    for (TDC.Row row : tdc.iterate()) {
      assertEquals(14, row.get("Phone").length(), row.get("Phone"));
      assertEquals(row.get("Code").toUpperCase(), row.get("Code"));
    }
  }

  private static Interpolate.Lookup lookup(Map<String, String> values) {
    return new Interpolate.Lookup() {
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
}
