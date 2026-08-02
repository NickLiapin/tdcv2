package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code weight="column"} — the proportions come from the file, exactly.
 *
 * <p>From typescript/test/processor/weight-render.test.ts. It cannot be a shared case because
 * the weights live in a CSV alongside the config, and a shared case carries no side files.
 *
 * <p>The claim the feature makes is not "roughly proportional" but exact, which is what
 * separates it from every weighted-random sampler — so that is what these check.
 */
class WeightTest {

  private static Map<String, Integer> tally(Path dir, String file, int count) {
    TDC tdc =
        TDC.options()
            .configString(
                ("<tdc><env mode=\"memory\" count=\"%d\" seed=\"w\" local=\"en\">"
                        + "<sequence name=\"N\"><gen type=\"file\" src=\"%s\" column=\"name\" weight=\"count\"/></sequence>"
                        + "</env><block><line><data>${{N}}</data></line></block></tdc>")
                    .formatted(count, file))
            .baseDir(dir)
            .build();
    Map<String, Integer> seen = new HashMap<>();
    tdc.toString().lines().forEach(line -> seen.merge(line, 1, Integer::sum));
    return seen;
  }

  @Test
  @DisplayName("the file's counts are honoured to the row")
  void exactProportions(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("names.csv"), "name,count\nBob,20000\nJack,10000\n");
    Map<String, Integer> seen = tally(dir, "names.csv", 30_000);
    // Not "about 2:1" — exactly 20000 and 10000.
    assertEquals(20_000, seen.get("Bob"));
    assertEquals(10_000, seen.get("Jack"));
  }

  @Test
  @DisplayName("a rare value stays rare instead of disappearing")
  void longTailSurvives(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("tail.csv"), "name,count\nCommon,900\nMid,90\nRare,10\n");
    Map<String, Integer> seen = tally(dir, "tail.csv", 1000);
    // A sampler would drop "Rare" from a run this size about a third of the time.
    assertEquals(900, seen.get("Common"));
    assertEquals(90, seen.get("Mid"));
    assertEquals(10, seen.get("Rare"));
  }

  @Test
  @DisplayName("an unweighted read of the same file stays uniform")
  void weightingDoesNotLeak(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("names.csv"), "name,count\nBob,20000\nJack,10000\n");
    TDC tdc =
        TDC.options()
            .configString(
                "<tdc><env mode=\"memory\" count=\"3000\" seed=\"u\" local=\"en\">"
                    + "<sequence name=\"N\"><gen type=\"file\" src=\"names.csv\" column=\"name\"/></sequence>"
                    + "</env><block><line><data>${{N}}</data></line></block></tdc>")
            .baseDir(dir)
            .build();
    long bobs = tdc.toString().lines().filter("Bob"::equals).count();
    // Uniform over two values — nowhere near the 2:1 the weights would give.
    assertTrue(bobs > 1300 && bobs < 1700, "Bob appeared " + bobs + " times of 3000");
  }

  @Test
  @DisplayName("a blank weight is refused rather than read as zero")
  void blankWeightIsRefused(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("gap.csv"), "name,count\nBob,20\nJack,\n");
    IllegalArgumentException e =
        assertThrows(IllegalArgumentException.class, () -> tally(dir, "gap.csv", 10));
    // Number("") is 0 in JavaScript, which would silently delete Jack from the run. A product
    // vanishing from a catalogue because one export cell was blank is found far too late.
    assertTrue(e.getMessage().contains("write 0 to exclude it"), e.getMessage());
  }

  @Test
  @DisplayName("a zero weight excludes the value deliberately")
  void zeroWeightExcludes(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("zero.csv"), "name,count\nBob,10\nJack,0\n");
    Map<String, Integer> seen = tally(dir, "zero.csv", 50);
    assertEquals(50, seen.get("Bob"));
    assertEquals(null, seen.get("Jack"));
  }

  @Test
  @DisplayName("weighting the value column by itself is refused")
  void selfWeightIsRefused(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("self.csv"), "name,count\nBob,20\n");
    TDC.Options options =
        TDC.options()
            .configString(
                "<tdc><env mode=\"memory\" count=\"4\" seed=\"w\" local=\"en\">"
                    + "<sequence name=\"N\"><gen type=\"file\" src=\"self.csv\" column=\"name\" weight=\"name\"/></sequence>"
                    + "</env><block><line><data>${{N}}</data></line></block></tdc>")
            .baseDir(dir);
    IllegalArgumentException e =
        assertThrows(IllegalArgumentException.class, () -> options.build().toString());
    assertTrue(e.getMessage().contains("same column as the values"), e.getMessage());
  }
}
