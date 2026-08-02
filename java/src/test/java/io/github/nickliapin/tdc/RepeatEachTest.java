package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.errors.TdcDiagnosticException;
import io.github.nickliapin.tdc.generators.Repeat;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** {@code repeat=} on a generator and {@code each=} on a line — one record holding a list. */
class RepeatEachTest {

  @Test
  @DisplayName("each walks a list into one line per element, matching the reference exactly")
  void eachMatchesTheReference() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="4" seed="each-demo" local="en">
                  <sequence name="Id"><gen type="increment" value="1"/></sequence>
                  <sequence name="Tags"><gen type="text" value="a,b,c" repeat="0..3" separator=";"/></sequence>
                </env><block>
                  <line><data>customer ${{Id}} tags=${{Tags}}</data></line>
                  <line each="Tags"><data>  item ${{_item_id}} pos=${{_item}} of ${{Id}}: ${{Tags}}</data></line>
                </block></tdc>
                """)
            .build();

    // Captured from the reference under mode="memory" — the engine this port implements. The
    // reference's default routing may send a config to a streaming engine instead, which
    // computes each row from its index and so consumes the generator differently; comparing
    // against that would be comparing two different algorithms.
    //
    // This one baseline pins the length quota, the element values and the key arithmetic.
    assertEquals(
        """
        customer 1 tags=b
          item 1 pos=1 of 1: b
        customer 2 tags=a;a
          item 4 pos=1 of 2: a
          item 5 pos=2 of 2: a
        customer 3 tags=
        customer 4 tags=b;b;c
          item 10 pos=1 of 4: b
          item 11 pos=2 of 4: b
          item 12 pos=3 of 4: c
        """,
        tdc.toString());
  }

  @Test
  @DisplayName("an empty list emits no line at all")
  void emptyListEmitsNothing() {
    // Record 2 above has no tags and contributes no item line. Splitting an empty cell would
    // invent a phantom element and emit an order row for a customer who placed none.
    String out =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="4" seed="each-demo" local="en">
                  <sequence name="Tags"><gen type="text" value="a,b,c" repeat="0..3" separator=";"/></sequence>
                </env><block>
                  <line each="Tags"><data>${{Tags}}</data></line>
                </block></tdc>
                """)
            .build()
            .toString();
    assertEquals(6, out.lines().count(), out);
  }

  @Test
  @DisplayName("keys stay distinct when two lists write into the same child table")
  void lanesKeepKeysApart() {
    String out =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="5" seed="lanes" local="en">
                  <sequence name="A"><gen type="text" value="x" repeat="2"/></sequence>
                  <sequence name="B"><gen type="text" value="y" repeat="2"/></sequence>
                </env><block>
                  <line each="A"><data>${{_item_id}}</data></line>
                  <line each="B"><data>${{_item_id}}</data></line>
                </block></tdc>
                """)
            .build()
            .toString();
    long total = out.lines().count();
    long distinct = out.lines().distinct().count();
    assertEquals(total, distinct, "two lists produced colliding keys:\n" + out);
  }

  @Test
  @DisplayName("a fixed repeat always produces that many values")
  void fixedRepeat() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="6" seed="fixed" local="en">
                  <sequence name="V"><gen type="number" value="1..9" repeat="3"/></sequence>
                </env><block><line><data>${{V}}</data></line></block></tdc>
                """)
            .build();
    for (TDC.Row row : tdc.iterate()) {
      assertEquals(3, row.get("V").split(",", -1).length, row.get("V"));
    }
  }

  @Test
  @DisplayName("each on a sequence that holds one value is refused, not quietly walked")
  void eachOnANonList() {
    // The renderer would happily split a plain value by the default separator and emit one
    // line, which looks like it worked. The reference refuses the config instead, and so does
    // this — an each= that walks nothing is a mistake worth naming.
    TdcDiagnosticException e =
        assertThrows(
            TdcDiagnosticException.class,
            () ->
                TDC.options()
                    .configString(
                        """
                        <tdc><env mode="memory" count="3" seed="notalist" local="en">
                          <sequence name="Plain"><gen type="text" value="one"/></sequence>
                        </env><block><line each="Plain"><data>${{Plain}}</data></line></block></tdc>
                        """)
                    .build());
    assertTrue(
        e.diagnostics().stream().anyMatch(d -> "TDC207".equals(d.code())), e.getMessage());
  }

  @Test
  @DisplayName("repeat bounds are checked")
  void repeatValidation() {
    assertThrows(IllegalArgumentException.class, () -> Repeat.parse(Map.of("repeat", "3..1")));
    assertThrows(IllegalArgumentException.class, () -> Repeat.parse(Map.of("repeat", "-1")));
    assertThrows(IllegalArgumentException.class, () -> Repeat.parse(Map.of("repeat", "100")));
    assertThrows(IllegalArgumentException.class, () -> Repeat.parse(Map.of("repeat", "two")));
    assertTrue(Repeat.parse(Map.of()) == null, "no repeat attribute means no list");
  }
}
