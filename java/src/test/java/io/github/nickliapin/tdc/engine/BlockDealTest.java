package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The block dealer, on its own.
 *
 * <p>A {@code <switch>} inside a {@code <uniq>} cuts the rows into blocks by its subject, and each
 * block is arranged separately. The free columns are dealt across those blocks first, or one block
 * ends up holding four {@code a}s while the next holds none and the group runs out of distinct rows
 * far below its real ceiling.
 *
 * <p>The arrangements below were measured against the reference implementation rather than derived
 * by hand: a deal that is merely valid is a different product for everyone holding a seed.
 */
class BlockDealTest {

  private record Shape(List<String> column, List<Integer> sizes, List<List<String>> want) {}

  private static List<Shape> shapes() {
    return List.of(
        new Shape(
            List.of("a", "a", "b", "b"),
            List.of(2, 2),
            List.of(List.of("a", "b"), List.of("a", "b"))),
        new Shape(
            List.of("a", "a", "a", "b"),
            List.of(2, 2),
            List.of(List.of("a", "a"), List.of("a", "b"))),
        new Shape(
            List.of("x", "x", "x", "y"),
            List.of(1, 3),
            List.of(List.of("x"), List.of("x", "x", "y"))),
        new Shape(List.of("a", "b", "a", "b"), List.of(4), List.of(List.of("a", "a", "b", "b"))),
        new Shape(
            List.of("p", "q", "r", "p", "q", "r", "p", "q", "r", "p", "q", "r"),
            List.of(5, 4, 3),
            List.of(
                List.of("p", "p", "q", "q", "r"),
                List.of("p", "q", "r", "r"),
                List.of("p", "q", "r"))),
        new Shape(List.of(), List.of(0), List.of(List.of())),
        new Shape(
            List.of("z", "z", "z"), List.of(0, 3), List.of(List.of(), List.of("z", "z", "z"))));
  }

  @Test
  @DisplayName("the deal is the arrangement the reference makes")
  void theDealIsTheArrangementTheReferenceMakes() {
    for (Shape shape : shapes()) {
      assertEquals(
          shape.want(),
          MemoryEngine.dealAcrossBlocks(shape.column(), shape.sizes()),
          shape.column() + " over blocks " + shape.sizes());
    }
  }

  @Test
  @DisplayName("every block gets exactly the rows it has")
  void everyBlockGetsExactlyTheRowsItHas() {
    for (Shape shape : shapes()) {
      List<Integer> lengths =
          MemoryEngine.dealAcrossBlocks(shape.column(), shape.sizes()).stream()
              .map(List::size)
              .collect(Collectors.toList());
      assertEquals(shape.sizes(), lengths, shape.column().toString());
    }
  }

  @Test
  @DisplayName("nothing is lost and nothing is invented")
  void nothingIsLostAndNothingIsInvented() {
    for (Shape shape : shapes()) {
      List<String> dealt = new ArrayList<>();
      MemoryEngine.dealAcrossBlocks(shape.column(), shape.sizes()).forEach(dealt::addAll);
      List<String> want = new ArrayList<>(shape.column());
      Collections.sort(dealt);
      Collections.sort(want);
      assertEquals(want, dealt, shape.column() + " over blocks " + shape.sizes());
    }
  }

  /**
   * One {@code y} against three {@code x}s over two blocks: {@code y} is owed a quarter of a row in
   * one and three quarters in the other, and gets a whole one. A value that rounds to nothing
   * everywhere would otherwise be dropped.
   */
  @Test
  @DisplayName("a value short of a whole share still lands somewhere")
  void aValueShortOfAWholeShareStillLandsSomewhere() {
    assertEquals(
        List.of(List.of("x", "x"), List.of("x", "y")),
        MemoryEngine.dealAcrossBlocks(Arrays.asList("x", "x", "x", "y"), List.of(2, 2)));
  }

  /**
   * Both values are owed half a row in each block; {@code a}'s claim on block 0 is walked first
   * (equal remainders, value order), takes the block's one free slot, and {@code b}'s unit goes
   * to block 1. Assigning per VALUE was tried twice and starved a block both times.
   */
  @Test
  @DisplayName("leftover units are handed out globally, strongest claim first")
  void leftoverUnitsAreHandedOutGloballyStrongestClaimFirst() {
    assertEquals(
        List.of(List.of("a"), List.of("a", "b", "b")),
        MemoryEngine.dealAcrossBlocks(Arrays.asList("a", "a", "b", "b"), List.of(1, 3)));
  }

  /**
   * Five values × 5 over blocks [13, 12] — the shape an ODD count cuts. A per-value deal dumped
   * the fifth value [1, 4] and "count 25" was refused saying "at most 24"; the global walk
   * lands every value [3, 2] or [2, 3].
   */
  @Test
  @DisplayName("unequal blocks do not starve the last value")
  void unequalBlocksDoNotStarveTheLastValue() {
    List<String> column = new ArrayList<>();
    for (int i = 0; i < 25; i++) {
      column.add("v" + (i % 5));
    }
    List<List<String>> dealt = MemoryEngine.dealAcrossBlocks(column, List.of(13, 12));
    for (int v = 0; v < 5; v++) {
      String value = "v" + v;
      long a = dealt.get(0).stream().filter(value::equals).count();
      long b = dealt.get(1).stream().filter(value::equals).count();
      assertEquals(5, a + b, value);
      assertEquals(1, Math.abs(a - b), value);
    }
  }
}
