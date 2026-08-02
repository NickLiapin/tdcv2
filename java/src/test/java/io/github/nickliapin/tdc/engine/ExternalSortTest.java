package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The sort the exact engine leans on, driven past the point where it has to use the disk.
 *
 * <p>A chunk size of a few records forces the merge path on an input a test can check by hand.
 * The default chunk holds a million, so an ordinary suite would only ever exercise the in-memory
 * shortcut and the merge would go untested until a real run needed it.
 */
class ExternalSortTest {

  @Test
  @DisplayName("many runs merged from disk come out in order")
  void mergesRunsFromDisk(@TempDir Path dir) {
    List<String> input = new ArrayList<>();
    // Deliberately adversarial order: descending, so no run is accidentally already sorted.
    for (int i = 999; i >= 0; i--) {
      input.add(String.format("%04d", i));
    }
    List<String> out = drain(ExternalSort.sort(input.iterator(), 7, dir));

    assertEquals(1000, out.size());
    for (int i = 0; i < 1000; i++) {
      assertEquals(String.format("%04d", i), out.get(i));
    }
    assertTrue(isEmptyOrGone(dir), "the temp runs should be gone once the merge finishes");
  }

  @Test
  @DisplayName("an input that fits never touches the disk")
  void staysInMemoryWhenItFits(@TempDir Path dir) {
    List<String> out = drain(ExternalSort.sort(List.of("c", "a", "b").iterator(), 100, dir));
    assertEquals(List.of("a", "b", "c"), out);
    assertTrue(isEmptyOrGone(dir), "nothing should have been written for three records");
  }

  @Test
  @DisplayName("equal records stay together, which is the whole point of sorting them")
  void keepsDuplicatesAdjacent(@TempDir Path dir) {
    List<String> input = new ArrayList<>();
    for (int i = 0; i < 60; i++) {
      input.add("key-" + (i % 5));
    }
    List<String> out = drain(ExternalSort.sort(input.iterator(), 4, dir));
    assertEquals(60, out.size());
    for (int i = 1; i < out.size(); i++) {
      assertTrue(out.get(i - 1).compareTo(out.get(i)) <= 0, "out of order at " + i);
    }
    // Twelve of each, in five unbroken blocks — what makes a single-pass duplicate scan possible.
    for (int block = 0; block < 5; block++) {
      for (int k = 0; k < 12; k++) {
        assertEquals("key-" + block, out.get(block * 12 + k));
      }
    }
  }

  private static List<String> drain(Iterator<String> it) {
    List<String> out = new ArrayList<>();
    while (it.hasNext()) {
      out.add(it.next());
    }
    return out;
  }

  private static boolean isEmptyOrGone(Path dir) {
    try (java.util.stream.Stream<Path> entries = java.nio.file.Files.list(dir)) {
      return entries.findAny().isEmpty();
    } catch (java.io.IOException e) {
      return true;
    }
  }
}
