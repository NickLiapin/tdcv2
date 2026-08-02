package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The invariants behind {@code uniq} and {@code <distinct>}.
 *
 * <p>The shared cases already pin the exact output, which proves Java and TypeScript agree.
 * These prove the agreed answer is also <em>correct</em>: every tuple really is distinct, and
 * every column really does keep the values it was drawn with. Two implementations can agree on
 * a wrong answer, and only a property check notices.
 */
class UniqDistinctTest {

  private static List<String> lines(String config) {
    return TDC.options().configString(config).build().toString().lines().toList();
  }

  @Test
  @DisplayName("uniq makes every row's tuple distinct")
  void tuplesAreDistinct() {
    List<String> rows =
        lines(
            """
            <tdc><env mode="memory" count="20" seed="u" local="en">
              <sequence name="K" uniq="true">
                <gen name="a" type="text" value="a1,a2,a3,a4"/>
                <gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>
              </sequence>
            </env><block><line><data>${{K.a}}-${{K.b}}</data></line></block></tdc>
            """);
    assertEquals(20, rows.size());
    assertEquals(20, new HashSet<>(rows).size(), "duplicate tuples: " + rows);
  }

  @Test
  @DisplayName("uniq only rearranges, so a declared share survives it exactly")
  void sharesSurvive() {
    List<String> rows =
        lines(
            """
            <tdc><env mode="memory" count="8" seed="u-shares" local="en">
              <sequence name="K" uniq="true">
                <gen name="a" type="text" value="a1,a2" percent="25,75"/>
                <gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>
              </sequence>
            </env><block><line><data>${{K.a}}|${{K.b}}</data></line></block></tdc>
            """);
    assertEquals(8, new HashSet<>(rows).size(), "tuples are not distinct");

    Map<String, Integer> shares = new HashMap<>();
    for (String row : rows) {
      shares.merge(row.split("\\|")[0], 1, Integer::sum);
    }
    // 25% and 75% of 8 — exactly, not approximately. This is the property that makes uniq a
    // rearrangement rather than a redraw: a share and uniqueness do not trade against each other.
    assertEquals(2, shares.get("a1"));
    assertEquals(6, shares.get("a2"));
  }

  @Test
  @DisplayName("an impossible uniq is refused before any output, and says what it could reach")
  void impossibleUniqIsRefused() {
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class,
            () ->
                lines(
                    """
                    <tdc><env mode="memory" count="10" seed="tiny" local="en">
                      <sequence name="K" uniq="true">
                        <gen name="a" type="text" value="x,y"/>
                        <gen name="b" type="text" value="p,q"/>
                      </sequence>
                    </env><block><line><data>${{K.a}}${{K.b}}</data></line></block></tdc>
                    """));
    // Four combinations exist and ten were asked for. Emitting duplicates quietly would be the
    // worst outcome: the run would look successful and the data would fail downstream.
    //
    // The wording is the reference's, verbatim — including that it reports the redraw attempts,
    // because nothing here pins the proportions and it did try eight independent draws first.
    assertEquals(
        "uniq: sequence \"K\" cannot produce 10 unique combinations — 8 independent draws each"
            + " topped out around 4 distinct rows. Its fields do not hold enough distinct values"
            + " between them. Add more values to a field (more distinct names, wider ranges…) or"
            + " lower the count.",
        e.getMessage());
  }

  @Test
  @DisplayName("distinct fields never coincide within a row")
  void distinctHolds() {
    for (String row :
        lines(
            """
            <tdc><env mode="memory" count="40" seed="distinct-1" local="en">
              <sequence name="P"><distinct>
                <gen name="A" type="text" value="X,Y"/>
                <gen name="B" type="text" value="X,Y"/>
              </distinct></sequence>
            </env><block><line><data>${{P.A}}|${{P.B}}</data></line></block></tdc>
            """)) {
      String[] parts = row.split("\\|");
      assertNotEquals(parts[0], parts[1], "row " + row);
      assertTrue(Set.of("X", "Y").contains(parts[0]), row);
      assertTrue(Set.of("X", "Y").contains(parts[1]), row);
    }
  }

  @Test
  @DisplayName("a field outside the group is left alone")
  void outsidersAreUnconstrained() {
    List<String> rows =
        lines(
            """
            <tdc><env mode="memory" count="40" seed="distinct-mixed" local="en">
              <sequence name="P">
                <distinct>
                  <gen name="A" type="text" value="X,Y"/>
                  <gen name="B" type="text" value="X,Y"/>
                </distinct>
                <gen name="C" type="text" value="X,Y"/>
              </sequence>
            </env><block><line><data>${{P.A}}${{P.B}}${{P.C}}</data></line></block></tdc>
            """);
    boolean sawCMatchA = false;
    for (String row : rows) {
      assertNotEquals(row.charAt(0), row.charAt(1), "A and B coincided in " + row);
      if (row.charAt(2) == row.charAt(0)) {
        sawCMatchA = true;
      }
    }
    // C shares the list but is outside the group, so it is free to equal A — and over forty rows
    // it does. Constraining it too would be a quiet overreach.
    assertTrue(sawCMatchA, "C never equalled A, so it may be constrained by mistake");
  }

  @Test
  @DisplayName("a source too small for distinctness is reported, not looped on")
  void impossibleDistinctIsRefused() {
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class,
            () ->
                lines(
                    """
                    <tdc><env mode="memory" count="5" seed="distinct-fuse" local="en">
                      <sequence name="P"><distinct>
                        <gen name="A" type="text" value="ONLY"/>
                        <gen name="B" type="text" value="ONLY"/>
                      </distinct></sequence>
                    </env><block><line><data>${{P.A}}${{P.B}}</data></line></block></tdc>
                    """));
    assertTrue(e.getMessage().toLowerCase().contains("distinct"), e.getMessage());
  }

  @Test
  @DisplayName("both are deterministic")
  void deterministic() {
    String config =
        """
        <tdc><env mode="memory" count="30" seed="det" local="en">
          <sequence name="K" uniq="true">
            <gen name="a" type="text" value="a,b,c,d,e"/>
            <gen name="b" type="text" value="1,2,3,4,5,6,7,8"/>
          </sequence>
        </env><block><line><data>${{K.a}}${{K.b}}</data></line></block></tdc>
        """;
    assertEquals(new ArrayList<>(lines(config)), new ArrayList<>(lines(config)));
  }
}
