package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
 * What the exact engine exists for: declared shares and uniqueness, at the same time, at size.
 *
 * <p>The streaming engine gives one or the other — its unique combinations are uniform by
 * construction. The in-memory engine gives both by holding the whole table. These check that the
 * third gives both without holding it, which is the only reason to have a third.
 */
class ExactDiskTest {

  /**
   * Ten weighted values against sixty, for a hundred records.
   *
   * <p>Six hundred combinations for a hundred rows: comfortable enough that the construction
   * usually lands clean, tight enough that a1's fifty copies need sixty partners to choose from.
   * The b list is built rather than written out — sixty literals would hide the shape.
   */
  private static String uniqConfig() {
    List<String> b = new ArrayList<>();
    for (int i = 1; i <= 60; i++) {
      b.add("b" + i);
    }
    return """
        <tdc><env count="100" seed="exact" local="en" engine="3">
        <sequence name="K" uniq="true">
        <gen name="a" type="text" value="a1,a2,a3,a4,a5,a6,a7,a8,a9,a10" \
        percent="50,20,10,5,5,4,3,1,1,1"/>
        <gen name="b" type="text" value="%s"/>
        </sequence></env><block><line><data>${{K.a}}|${{K.b}}</data></line></block></tdc>"""
        .formatted(String.join(",", b));
  }

  @Test
  @DisplayName("uniqueness and exact shares hold together, which no other engine manages lazily")
  void exactSharesAndUniqueness() {
    TDC tdc = TDC.options().configString(uniqConfig()).build();
    assertEquals(3, tdc.engine());

    Set<String> seen = new HashSet<>();
    Map<String, Integer> shares = new HashMap<>();
    for (TDC.Row row : tdc.iterate()) {
      String a = row.get("K.a");
      assertTrue(seen.add(a + "|" + row.get("K.b")), "a repeated pair at row " + row.index());
      shares.merge(a, 1, Integer::sum);
    }
    assertEquals(100, seen.size());

    // Exactly the declared shares, not approximately. Half the run is a1, and an engine that
    // answers 47 has quietly turned a stated proportion into a sample. Half the combination
    // space is asked for, so collisions are near-certain and the repair really does run —
    // preserving each column's multiset is what keeps these numbers whole.
    assertEquals(50, shares.get("a1"));
    assertEquals(20, shares.get("a2"));
    assertEquals(10, shares.get("a3"));
    assertEquals(5, shares.get("a4"));
    assertEquals(5, shares.get("a5"));
    assertEquals(4, shares.get("a6"));
    assertEquals(3, shares.get("a7"));
    assertEquals(1, shares.get("a8"));
    assertEquals(1, shares.get("a9"));
    assertEquals(1, shares.get("a10"));
  }

  @Test
  @DisplayName("a config the exact construction cannot do still renders, from memory")
  void fallsBackRatherThanFailing() {
    // A weighted advanced_regex needs the whole column, which the seekable path refuses. Engine 3
    // answers anyway — correctness first, memory profile second.
    String config =
        """
        <tdc><env count="20" seed="fallback" local="en" engine="3">
        <sequence name="V"><gen type="advanced_regex" value="(?%{70:A;30:B})-[0-9]{2}"/></sequence>
        </env><block><line><data>${{V}}</data></line></block></tdc>""";

    TDC tdc = TDC.options().configString(config).build();
    assertEquals(3, tdc.engine());
    int a = 0;
    for (TDC.Row row : tdc.iterate()) {
      assertTrue(row.get("V").matches("[AB]-[0-9]{2}"), "unexpected value " + row.get("V"));
      if (row.get("V").startsWith("A")) {
        a++;
      }
    }
    assertEquals(14, a, "the 70/30 split should still be exact — 14 of 20");
  }

  @Test
  @DisplayName("uniqueness is refused, not approximated, when the data cannot supply it")
  void refusesTheImpossible() {
    String config =
        """
        <tdc><env count="50" seed="tight" local="en" engine="3">
        <sequence name="K" uniq="true">
        <gen name="a" type="text" value="x,y"/>
        <gen name="b" type="text" value="p,q"/>
        </sequence></env><block><line><data>${{K.a}}${{K.b}}</data></line></block></tdc>""";

    // Four combinations, fifty rows asked for. There is no arrangement, and saying so beats
    // shipping fifty rows of which forty-six are duplicates.
    RuntimeException e =
        assertThrows(
            RuntimeException.class, () -> TDC.options().configString(config).build().toString());
    assertTrue(
        e.getMessage().contains("infeasible") || e.getMessage().contains("distinct"),
        "unhelpful message: " + e.getMessage());
  }
}
