package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.parser.PairedData;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@code <data pair="…">} — the pass that lets a body hold a literal {@code </data>}.
 *
 * <p>Two properties carry the whole design and neither is visible in the output of a valid
 * config, which is why the shared fixtures say almost nothing about them:
 *
 * <ul>
 *   <li>the rewritten source is exactly as LONG as the original, so a diagnostic reported
 *       afterwards still points into the file the user wrote;
 *   <li>{@code restore} is the exact inverse, so the text a generator sees is the text that
 *       was written.
 * </ul>
 *
 * <p>A port that shortened the source instead would pass every rendering fixture and put every
 * later error message on the wrong column.
 */
class PairedDataTest {

  @Test
  @DisplayName("a body with no paired tag is passed through untouched")
  void plainBodyUntouched() {
    String source = "<tdc><block><line><data>hello</data></line></block></tdc>";
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertEquals(source, out.source());
    assertTrue(out.problems().isEmpty());
  }

  /** A paired body: the close carries the same {@code pair} the open declared. */
  private static String paired(String name, String body) {
    return "<tdc><block><line><data pair=\"" + name + "\">" + body
        + "</data pair=\"" + name + "\"></line></block></tdc>";
  }

  @Test
  @DisplayName("the rewrite is the same length as the source, so positions stay honest")
  void lengthIsPreserved() {
    String source = paired("x", "a </data> inside");
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertEquals(source.length(), out.source().length(),
        "a shorter rewrite would move every later diagnostic");
    assertTrue(out.problems().isEmpty(), out.problems().toString());
  }

  @Test
  @DisplayName("restore gives the body back exactly as it was written")
  void restoreGivesTheBodyBack() {
    String source = paired("x", "a </data> inside");
    PairedData.Rewrite out = PairedData.preprocess(source);
    // The lexer is handed a source where the literal close is stood in for by a sentinel of
    // exactly the same length; a generator must be handed the text that was written.
    assertTrue(out.source().contains("\0/data\0"), "the literal close is stood in for");
    assertFalse(out.source().contains("a </data> inside"), "the lexer must not see a real close");
    assertTrue(PairedData.restore(out.source()).contains("a </data> inside"),
        "restore puts the literal close back");
  }

  @Test
  @DisplayName("neither pass changes the length, which is what keeps positions honest")
  void neitherPassChangesLength() {
    // The closing tag's leftover characters become SPACES rather than disappearing — that is
    // the whole trick, and it is why a diagnostic reported after this pass still points into
    // the file the user wrote rather than into the one this produced.
    String source = paired("x", "a </data> inside");
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertEquals(source.length(), out.source().length());
    assertEquals(source.length(), PairedData.restore(out.source()).length());
  }

  @Test
  @DisplayName("restore leaves text that was never rewritten alone")
  void restoreIsHarmlessOnPlainText() {
    assertEquals("plain text", PairedData.restore("plain text"));
    assertEquals("", PairedData.restore(""));
  }

  @Test
  @DisplayName("a pair that never closes is reported at a position a reader can act on")
  void unclosedPair() {
    String source = "<tdc><block><line><data pair=\"x\">never closed</line></block></tdc>";
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertFalse(out.problems().isEmpty(), "an unclosed pair should be reported");
    PairedData.Problem first = out.problems().get(0);
    assertTrue(first.line() >= 1, "a line is 1-based");
    assertTrue(first.column() >= 0, "a column is 0-based");
    assertFalse(first.message().isBlank());
  }

  @Test
  @DisplayName("a close whose pair does not match the open is reported, not silently accepted")
  void mismatchedPair() {
    String source =
        "<tdc><block><line><data pair=\"x\">body</data pair=\"y\"></line></block></tdc>";
    // The close names a pair nobody opened, which is a typo the reader has to be told about.
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertFalse(out.problems().isEmpty(), "a mismatched pair should be reported");
    assertEquals(source.length(), out.source().length());
  }

  @Test
  @DisplayName("several paired bodies in one document are each handled")
  void severalBodies() {
    String source =
        "<tdc><block><line>"
            + "<data pair=\"a\">one </data> x</data pair=\"a\">"
            + "<data pair=\"b\">two </data> y</data pair=\"b\">"
            + "</line></block></tdc>";
    PairedData.Rewrite out = PairedData.preprocess(source);
    assertEquals(source.length(), out.source().length());
    assertTrue(out.problems().isEmpty(), out.problems().toString());
    String restored = PairedData.restore(out.source());
    assertTrue(restored.contains("one </data> x"), restored);
    assertTrue(restored.contains("two </data> y"), restored);
  }
}
