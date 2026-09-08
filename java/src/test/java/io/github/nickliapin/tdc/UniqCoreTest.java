package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.sequence.Uniq;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The three numbers behind {@code uniq="true"}, and the sandwich they have to form.
 *
 * <p>{@code capacity} is a safe LOWER bound worked out from the quota numbers alone, without
 * touching data - it is what lets a billion-row config be certified in milliseconds.
 * {@code upperBound} is a proven ceiling. What the arranger actually builds must sit between
 * them, always: capacity &lt;= built &lt;= upperBound.
 *
 * <p>Break the left half and a config is refused that would have fitted. Break the right half
 * and the run promises uniqueness it cannot deliver, which reaches the file as duplicate rows
 * in a column the config said were unique. Neither is visible in a rendering fixture, and
 * before this file neither function was called by any test in this port.
 *
 * <p>The reference holds this as a property test over random cases; so does this.
 */
class UniqCoreTest {

  /** The reference example: five/five, six/four, seven/three, eight/two. */
  private static final List<List<String>> REFERENCE =
      List.of(
          chars("aaaaabbbbb"),
          chars("ccccccdddd"),
          chars("fffffffeee"),
          chars("hhhhhhhhgg"));

  private static List<String> chars(String s) {
    List<String> out = new ArrayList<>(s.length());
    for (char c : s.toCharArray()) {
      out.add(String.valueOf(c));
    }
    return out;
  }

  private static List<List<Integer>> countsOf(List<List<String>> columns) {
    List<List<Integer>> out = new ArrayList<>();
    for (List<String> column : columns) {
      out.add(Uniq.valueCounts(column));
    }
    return out;
  }

  /** How many distinct tuples the arrangement actually produced, counted from the data. */
  private static int distinctTuples(List<List<String>> columns) {
    int rows = columns.get(0).size();
    Set<String> seen = new HashSet<>();
    for (int j = 0; j < rows; j++) {
      StringBuilder key = new StringBuilder();
      for (List<String> column : columns) {
        key.append(column.get(j)).append(' ');
      }
      seen.add(key.toString());
    }
    return seen.size();
  }

  private static String multiset(List<String> column) {
    List<String> copy = new ArrayList<>(column);
    Collections.sort(copy);
    return String.join(",", copy);
  }

  /** Small random columns: few values, few rows, so every shape turns up often. */
  private static List<List<String>> randomColumns(Random rnd) {
    int rows = 4 + rnd.nextInt(9);
    int cols = 2 + rnd.nextInt(3);
    List<List<String>> out = new ArrayList<>();
    for (int k = 0; k < cols; k++) {
      int distinct = 1 + rnd.nextInt(4);
      List<String> column = new ArrayList<>(rows);
      for (int j = 0; j < rows; j++) {
        column.add(k + "-" + rnd.nextInt(distinct));
      }
      out.add(column);
    }
    return out;
  }

  @Test
  @DisplayName("the reference example: the arranger reaches nine, and the bounds hold")
  void referenceExample() {
    List<List<Integer>> counts = countsOf(REFERENCE);
    Uniq.Arrangement arranged = Uniq.arrange(REFERENCE);
    assertEquals(9, arranged.distinct(), "the builder should reach the true maximum");
    assertEquals(9, Uniq.upperBound(counts), "the proven ceiling is tight on this shape");
    int capacity = Uniq.capacity(counts, Integer.MAX_VALUE);
    assertTrue(capacity > 0, "a data-free floor of zero certifies nothing");
    assertTrue(
        capacity <= arranged.distinct(),
        "the floor must never promise more than the builder delivers: " + capacity);
  }

  @Test
  @DisplayName("capacity never over-promises and the builder never exceeds the ceiling")
  void theSandwichHolds() {
    Random rnd = new Random(20260908L);
    for (int t = 0; t < 600; t++) {
      List<List<String>> columns = randomColumns(rnd);
      List<List<Integer>> counts = countsOf(columns);
      int capacity = Uniq.capacity(counts, Integer.MAX_VALUE);
      int built = Uniq.arrange(columns).distinct();
      int ceiling = Uniq.upperBound(counts);
      assertTrue(
          capacity <= built,
          "capacity " + capacity + " promised more than the " + built + " built");
      assertTrue(
          built <= ceiling,
          "the builder claimed " + built + " above the proven ceiling " + ceiling);
    }
  }

  @Test
  @DisplayName("the arrangement keeps every column's multiset, so declared shares survive")
  void multisetsArePreserved() {
    Random rnd = new Random(20260908L);
    for (int t = 0; t < 300; t++) {
      List<List<String>> columns = randomColumns(rnd);
      Uniq.Arrangement arranged = Uniq.arrange(columns);
      assertEquals(columns.size(), arranged.columns().size());
      for (int k = 0; k < columns.size(); k++) {
        assertEquals(
            multiset(columns.get(k)),
            multiset(arranged.columns().get(k)),
            "uniq rearranges values, it never replaces them");
      }
    }
  }

  @Test
  @DisplayName("the distinct count it reports is the one the data actually has")
  void reportedCountIsTheRealOne() {
    Random rnd = new Random(20260908L);
    for (int t = 0; t < 300; t++) {
      Uniq.Arrangement arranged = Uniq.arrange(randomColumns(rnd));
      assertEquals(
          distinctTuples(arranged.columns()),
          arranged.distinct(),
          "a reported count above the real one is a promise of uniqueness that is not kept");
    }
  }

  @Test
  @DisplayName("capacity certifies a plentiful shape from the numbers alone, and stops early")
  void certifiesWithoutData() {
    // 50 values, two copies each, in two columns: all 100 tuples are reachable.
    List<Integer> fifty = new ArrayList<>();
    for (int i = 0; i < 50; i++) {
      fifty.add(2);
    }
    assertTrue(Uniq.capacity(List.of(fifty, fifty), 100) >= 100);
    // One value in each column means exactly one possible tuple, however many rows there are.
    assertEquals(1, Uniq.capacity(List.of(List.of(100), List.of(100)), Integer.MAX_VALUE));
  }

  @Test
  @DisplayName("a single column is already unique in as many ways as it has values")
  void singleColumn() {
    List<List<String>> one = List.of(chars("aabbcc"));
    assertEquals(3, Uniq.arrange(one).distinct());
    assertEquals(3, Uniq.upperBound(countsOf(one)));
  }

  @Test
  @DisplayName("nothing to arrange: no columns, and columns with no rows")
  void emptyShapes() {
    assertEquals(0, Uniq.arrange(List.of()).distinct());
    Uniq.Arrangement noRows = Uniq.arrange(List.of(List.of(), List.of()));
    assertEquals(2, noRows.columns().size());
    assertEquals(0, noRows.distinct());
    assertEquals(0, Uniq.capacity(List.of(), 5));
  }
}
