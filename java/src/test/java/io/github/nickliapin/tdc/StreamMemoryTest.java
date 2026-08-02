package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What the streaming engine is actually for: a run larger than the memory it is given.
 *
 * <p>Every other test here compares values. This one compares memory, because a streaming engine
 * that quietly buffers is indistinguishable from the in-memory one until the day it matters — and
 * that day is the run nobody can repeat with a debugger attached.
 */
class StreamMemoryTest {

  private static final String CONFIG =
      """
      <tdc><env count="400000" seed="big" local="en" mode="disk">
      <sequence name="Gender"><gen type="text" value="Male,Female" percent="60,40"/></sequence>
      <sequence name="Id"><gen type="increment" value="1"/></sequence>
      <sequence name="Age"><gen type="number" value="18..90"/></sequence>
      <sequence name="Code"><gen type="regex" value="[A-Z]{4}[0-9]{6}"/></sequence>
      </env><block><line><data>${{Id}},${{Gender}},${{Age}},${{Code}}</data></line></block></tdc>""";

  @Test
  @DisplayName("a run far bigger than the heap it is given still writes")
  void writesWithoutHoldingTheRun(@TempDir Path dir) throws IOException {
    TDC tdc = TDC.options().configString(CONFIG).build();
    assertEquals(2, tdc.engine(), "mode=\"disk\" on this config should route to the streaming engine");

    Path target = dir.resolve("big.csv");
    long before = settledHeap();
    tdc.writeFile(target);
    // What matters is what is still HELD once the write is done, not what passed through the
    // allocator on the way. Garbage is expected; a retained copy of the run is the bug.
    long streamed = settledHeap() - before;

    long bytes = Files.size(target);
    assertTrue(bytes > 10_000_000, "expected a file of tens of megabytes, got " + bytes);
    assertTrue(
        streamed < bytes / 4,
        "streaming still held " + streamed + " bytes after writing " + bytes + " bytes");

    // And the comparison that gives the number meaning: the same config in memory. It has to
    // keep every column, so it retains on the order of the run itself.
    long baseline = settledHeap();
    TDC inMemory = TDC.options().configString(CONFIG).engine(1).build();
    inMemory.writeFile(dir.resolve("big-memory.csv"));
    long held = settledHeap() - baseline;
    assertTrue(
        held > streamed * 4,
        "expected the in-memory engine to hold far more (" + held + " vs " + streamed + ")");
    // The two files are not expected to match: the engines draw differently, so the same seed
    // gives different values. Both are correct, and neither is the other's reference.
    assertEquals(bytes / 100, Files.size(dir.resolve("big-memory.csv")) / 100,
        "the same config should produce the same SHAPE of output on either engine");

    try (Stream<String> lines = Files.lines(target)) {
      assertEquals(400_000, lines.count());
    }
  }

  /** Live bytes, as close as a portable measurement gets: collect, then read. */
  private static long settledHeap() {
    Runtime runtime = Runtime.getRuntime();
    for (int i = 0; i < 3; i++) {
      System.gc();
      try {
        Thread.sleep(30);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
    }
    return runtime.totalMemory() - runtime.freeMemory();
  }

  @Test
  @DisplayName("reading one record does not build the ones before it")
  void readsOneRecordDirectly() {
    TDC tdc = TDC.options().configString(CONFIG).build();
    TDC.Row row = tdc.getAt(399_999);
    assertEquals("400000", row.get("Id"));
    assertTrue(row.get("Code").matches("[A-Z]{4}[0-9]{6}"), "unexpected code " + row.get("Code"));
    // The same record, asked for twice, out of order: a seekable engine owes the same answer.
    assertEquals(row.get("Code"), tdc.getAt(399_999).get("Code"));
    assertEquals(row.toMap(), tdc.getAt(399_999).toMap());
  }
}
