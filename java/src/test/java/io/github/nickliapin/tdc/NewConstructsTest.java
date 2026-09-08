package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The three constructs this engine learned last: a per-row assertion, a walked list with a
 * repeat, and a {@code <data>} inside a {@code <case>} that reads its row.
 *
 * <p>The shared fixtures pin what each of them PRODUCES, because that is expressible as output.
 * What only lives here is the half a rendering fixture cannot hold: which row a refusal names,
 * and the equality between two configs — a claim only checked when both are run and compared.
 */
class NewConstructsTest {

  /** 2026-04-23T12:00:00Z, the fixed instant every implementation shares. */
  private static final long NOW = 1777032000000L;

  private static List<String> rows(String env, int count, String line, String mode) {
    String config =
        "<tdc><env count=\"" + count + "\" seed=\"s\" local=\"en\" mode=\"" + mode + "\">"
            + env
            + "</env><block><line><data>"
            + line
            + "</data></line></block></tdc>";
    String out = TDC.options().configString(config).now(NOW).build().toString();
    return List.of(out.replaceAll("\n$", "").split("\n"));
  }

  private static String refusal(String env, int count, String line, String mode) {
    RuntimeException thrown =
        assertThrows(RuntimeException.class, () -> rows(env, count, line, mode));
    return thrown.getMessage() == null ? "" : thrown.getMessage();
  }

  private static final String AMOUNT =
      "<sequence name=\"Amount\"><gen type=\"number\" value=\"1..100\"/></sequence>";
  private static final String FEE =
      "<sequence name=\"Fee\"><gen type=\"number\" value=\"-3..20\"/></sequence>";
  private static final String CITY =
      "<sequence name=\"City\"><gen type=\"text\" value=\"Alpha,Beta,Gamma\"/></sequence>";

  @Nested
  @DisplayName("<assert each> — every row checked")
  class PerRowAssertions {

    @Test
    @DisplayName("says nothing when every row holds up the claim")
    void holds() {
      rows(AMOUNT + "<assert each=\"Amount > 0\" says=\"positive\"/>", 200, "${{Amount}}", "memory");
    }

    @Test
    @DisplayName("accepts the very config the whole-run form refuses")
    void theSignpostPointsSomewhere() {
      // The `that=` refusal names `each=` as the answer, so the two must not both reject it.
      assertTrue(
          refusal(AMOUNT + "<assert that=\"Amount > 0\" says=\"positive\"/>", 20, "${{Amount}}",
                  "memory")
              .contains("is not the same on every row"));
      rows(AMOUNT + "<assert each=\"Amount > 0\" says=\"positive\"/>", 20, "${{Amount}}", "memory");
    }

    @Test
    @DisplayName("names the FIRST failing row, and the value that broke it")
    void namesTheFirstRow() {
      String message =
          refusal(FEE + "<assert each=\"Fee >= 0\" says=\"a fee is never negative\"/>", 20,
                  "${{Fee}}", "memory");
      assertTrue(message.contains("assert failed on row 3: a fee is never negative"), message);
      assertTrue(message.contains("Fee >= 0   with Fee = -1"), message);
    }

    @Test
    @DisplayName("the streaming engine stops on the same row")
    void sameRowStreaming() {
      // The row loop is shared, and this is the proof. An engine that checked after writing
      // would name a different row.
      assertTrue(
          refusal(FEE + "<assert each=\"Fee >= 0\" says=\"never negative\"/>", 20, "${{Fee}}",
                  "disk")
              .contains("assert failed on row 3"));
    }

    @Test
    @DisplayName("checks every per-row assertion, not only the first")
    void everyAssertion() {
      String env =
          AMOUNT
              + "<assert each=\"Amount > 0\" says=\"positive\"/>"
              + "<assert each=\"Amount > 1000\" says=\"over a thousand\"/>";
      assertTrue(refusal(env, 5, "${{Amount}}", "memory").contains("over a thousand"));
    }
  }

  @Nested
  @DisplayName("a walked list with a fixed repeat")
  class WalkedRepeat {

    private String walked(String value, String extra) {
      return "<sequence name=\"V\"><gen type=\"text\" value=\""
          + value
          + "\" order=\"sequential\""
          + extra
          + "/></sequence>";
    }

    @Test
    @DisplayName("a repeat matching the list gives every row the whole list")
    void wholeList() {
      assertEquals(
          List.of(
              "created,paid,shipped,delivered",
              "created,paid,shipped,delivered",
              "created,paid,shipped,delivered"),
          rows(walked("created,paid,shipped,delivered", " repeat=\"4\""), 3, "${{V}}", "memory"));
    }

    @Test
    @DisplayName("the walk carries ON across rows rather than restarting")
    void carriesOn() {
      // The part a single row cannot show: restarting would print `a,b` three times.
      assertEquals(
          List.of("a,b", "c,a", "b,c"),
          rows(walked("a,b,c", " repeat=\"2\""), 3, "${{V}}", "memory"));
    }

    @Test
    @DisplayName("repeat=\"1\" is exactly the plain walk")
    void repeatOneIsThePlainWalk() {
      List<String> one = rows(walked("a,b,c", " repeat=\"1\""), 6, "${{V}}", "memory");
      assertEquals(rows(walked("a,b,c", ""), 6, "${{V}}", "memory"), one);
      assertEquals(List.of("a", "b", "c", "a", "b", "c"), one);
    }

    @Test
    @DisplayName("both engines walk the same way")
    void bothEngines() {
      assertEquals(
          rows(walked("a,b,c", " repeat=\"2\""), 8, "${{V}}", "memory"),
          rows(walked("a,b,c", " repeat=\"2\""), 8, "${{V}}", "disk"));
    }

    @Test
    @DisplayName("running out under cycle=\"false\" names the element as well as the row")
    void runsOutLoudly() {
      // The message names a position in the WALK, not a row number that is really an element
      // index — that would send a reader to the wrong attribute.
      String message =
          refusal(walked("a,b,c,d,e", " repeat=\"2\" cycle=\"false\""), 5, "${{V}}", "memory");
      assertTrue(message.contains("row 3 runs out at element 2"), message);
    }
  }

  @Nested
  @DisplayName("${{Name}} inside a <case>")
  class CaseInterpolation {

    @Test
    @DisplayName("pairs each row with its OWN value")
    void pairsWithItsOwnRow() {
      // A case is built for the SUBSET of rows that chose it, so an implementation reading a
      // position rather than an absolute row pairs the wrong values and still looks plausible.
      String env =
          CITY
              + "<mix name=\"S\" percent=\"50\">"
              + "<case><data>${{City}}/north</data></case>"
              + "<case><data>${{City}}/south</data></case></mix>";
      for (String row : rows(env, 12, "${{City}}|${{S}}", "memory")) {
        String[] halves = row.split("\\|");
        assertTrue(halves[1].startsWith(halves[0] + "/"), row);
      }
    }

    @Test
    @DisplayName("applies the filters a <line> may use")
    void filters() {
      String env =
          CITY
              + "<mix name=\"S\" percent=\"0\">"
              + "<case><data>${{City}} plain</data></case>"
              + "<case><data>${{City|upper}} loud</data></case></mix>";
      for (String row : rows(env, 4, "${{S}}", "memory")) {
        assertTrue(row.endsWith(" loud"), row);
        String head = row.split(" ")[0];
        assertEquals(head.toUpperCase(java.util.Locale.ROOT), head, row);
      }
    }

    @Test
    @DisplayName("a column empty on this row renders empty, not marked")
    void emptyIsNotMissing() {
      // A declared column with no value here is not the same thing as a name nobody declared.
      String env =
          "<sequence name=\"K\"><gen type=\"text\" value=\"a,b\" percent=\"50,50\"/></sequence>"
              + "<sequence name=\"Only\" parent=\"K.a\"><gen type=\"text\" value=\"X\"/></sequence>"
              + "<mix name=\"S\" percent=\"100\"><case><data>[${{Only}}]</data></case>"
              + "<case><data>never</data></case></mix>";
      List<String> out = rows(env, 6, "${{S}}", "memory");
      assertTrue(out.stream().allMatch(r -> r.equals("[X]") || r.equals("[]")), out.toString());
      assertTrue(out.contains("[]"), out.toString());
    }

    @Test
    @DisplayName("both engines read a case body the same way")
    void bothEngines() {
      String env =
          CITY
              + "<mix name=\"S\" percent=\"60\">"
              + "<case><data>${{City}} North</data></case>"
              + "<case><data>${{City|upper}} South</data></case></mix>";
      assertEquals(rows(env, 12, "${{S}}", "memory"), rows(env, 12, "${{S}}", "disk"));
    }

    @Test
    @DisplayName("plain text is left alone")
    void plainText() {
      String env =
          "<mix name=\"S\" percent=\"100\"><case><data>just text</data></case>"
              + "<case><data>never</data></case></mix>";
      assertEquals(List.of("just text", "just text"), rows(env, 2, "${{S}}", "memory"));
    }
  }
}
