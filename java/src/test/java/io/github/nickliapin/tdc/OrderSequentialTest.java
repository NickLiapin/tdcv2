package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code order="sequential"} against a file, and the refusal when the data runs out.
 *
 * <p>The looping and no-draw behaviour is pinned by the shared cases. These two cannot be: a
 * shared case carries no side files, and an error is not an output.
 */
class OrderSequentialTest {

  @Test
  @DisplayName("a file is replayed in its exact order, looping")
  void fileInOrder(@TempDir Path dir) throws IOException {
    // From typescript/test/processor/order-sequential.test.ts.
    Path file = dir.resolve("villages.txt");
    Files.writeString(file, "McMurdo\nVostok\nConcordia\n");

    TDC tdc =
        TDC.options()
            .configString(
                "<tdc><env mode=\"memory\" count=\"5\" seed=\"demo\" local=\"en\">"
                    + "<sequence name=\"V\"><gen type=\"file\" src=\"villages.txt\" order=\"sequential\"/></sequence>"
                    + "</env><block><line><data>${{V}}</data></line></block></tdc>")
            .baseDir(dir)
            .build();

    assertEquals(
        List.of("McMurdo", "Vostok", "Concordia", "McMurdo", "Vostok"),
        tdc.toString().lines().toList());
    // The rows agree with the text, since both read one run.
    assertEquals(
        List.of("McMurdo", "Vostok", "Concordia", "McMurdo", "Vostok"),
        tdc.toList().stream().map(r -> r.get("V")).toList());
  }

  @Test
  @DisplayName("cycle=\"false\" reports how far the data went")
  void refusesToLoopWhenTold() {
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class,
            () ->
                TDC.options()
                    .configString(
                        "<tdc><env mode=\"memory\" count=\"5\" seed=\"demo\" local=\"en\">"
                            + "<sequence name=\"M\"><gen type=\"text\" value=\"Jan,Feb,Mar\""
                            + " order=\"sequential\" cycle=\"false\"/></sequence>"
                            + "</env><block><line><data>${{M}}</data></line></block></tdc>")
                    .build()
                    .toString());
    // The reference's wording, and its arithmetic: three values, and the fourth row is where it
    // ran out.
    assertTrue(e.getMessage().contains("only 3 values, so row 4 has none"), e.getMessage());
  }
}
