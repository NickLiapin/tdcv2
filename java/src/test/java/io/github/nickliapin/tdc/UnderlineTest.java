package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.errors.DiagnosticRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * What the carets cover.
 *
 * <p>The position a diagnostic carries is pinned by the shared fixtures; how much of the line it
 * underlines is not, and it is the difference between being shown the mistake and being shown
 * where to start looking. These are the two shapes a position ever has, and the two that would be
 * easy to get wrong.
 */
class UnderlineTest {

  private static String carets(String source, int line, int column) {
    String text =
        DiagnosticRenderer.format(
            Diagnostic.error("TDC000", "x", "", line, column), source, "t.tdc", false);
    for (String l : text.split("\n")) {
      if (l.contains("^")) {
        return l.strip().replaceFirst("^\\|", "").strip();
      }
    }
    return "";
  }

  private static String carets(int n) {
    return "^".repeat(n);
  }

  @Test
  @DisplayName("a value is underlined to its closing quote")
  void value() {
    assertEquals(
        carets("notanumber".length()),
        carets("<gen type=\"number\" value=\"notanumber\"/>", 1, 26));
  }

  @Test
  @DisplayName("an element is underlined whole, children and all")
  void element() {
    // Not to the first ">": that would stop at the opening tag and leave the body — the part being
    // complained about — unmarked.
    assertEquals(
        carets("<data>${{Nope}}</data>".length()),
        carets("<block><line><data>${{Nope}}</data></line></block>", 1, 13));
  }

  @Test
  @DisplayName("a self-closing element stops at its own slash")
  void selfClosing() {
    assertEquals(
        carets("<gen type=\"file\" row=\"k\"/>".length()),
        carets("<sequence name=\"B\"><gen type=\"file\" row=\"k\"/></sequence>", 1, 19));
  }

  @Test
  @DisplayName("a greater-than inside a value does not end the tag")
  void quotedGreaterThan() {
    String source = "<data value=\"a>b\"/>";
    assertEquals(carets(source.length()), carets(source, 1, 0));
  }

  @Test
  @DisplayName("a comment is not a tag")
  void comment() {
    // "<!--" starts with "<" and is not an element; underlining it whole would point at the comment
    // rather than at the empty document being complained about.
    assertEquals("^", carets("<!-- nothing here -->", 1, 0));
  }

  @Test
  @DisplayName("a position past the end of the line still renders")
  void pastTheEnd() {
    assertEquals("^", carets("<tdc/>", 1, 99));
  }
}
