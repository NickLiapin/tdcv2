package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The fingerprint repair against the text repair — same table, or no deal.
 *
 * <p>Engine 3 changes the CARRIER when a run is large: 13-byte hashes routed into piles, each pile
 * sorted as raw bytes, groups sharing a hash treated as candidates. Which rows collide and where
 * they move must not change with the carrier. These cases run the same columns through both paths
 * and compare every row.
 *
 * <p>None of this had a test in this port, and it could not have had one: the carrier switches at
 * a MILLION rows, and no suite renders a million rows. So {@code repair} takes the pile count
 * instead of working it out — the same knob the reference has always had — and these run at a few
 * thousand.
 *
 * <p>The one place the two may legitimately differ is a real 64-bit hash collision, whose odds at
 * these sizes are nil; byte equality is asserted outright.
 */
class ExactUniqFingerprintTest {

  /** A column that cycles through {@code values}, holding each for {@code stride} rows. */
  private static ExactUniq.Resolver column(List<String> values, int stride) {
    return row -> values.get((row / stride) % values.size());
  }

  private static List<String> many(int n, String prefix) {
    List<String> out = new ArrayList<>(n);
    for (int i = 0; i < n; i++) {
      out.add(prefix + i);
    }
    return out;
  }

  /** Every row's tuple, as text, in row order. */
  private static List<String> rowsOf(
      Map<String, ExactUniq.Resolver> built, List<String> ids, int count) {
    List<String> out = new ArrayList<>(count);
    for (int row = 0; row < count; row++) {
      StringBuilder line = new StringBuilder();
      for (int k = 0; k < ids.size(); k++) {
        if (k > 0) {
          line.append('|');
        }
        line.append(built.get(ids.get(k)).valueAt(row));
      }
      out.add(line.toString());
    }
    return out;
  }

  private static int duplicateCount(List<ExactUniq.Resolver> resolvers, int count) {
    Set<String> seen = new HashSet<>();
    int duplicates = 0;
    for (int row = 0; row < count; row++) {
      StringBuilder key = new StringBuilder();
      for (ExactUniq.Resolver resolver : resolvers) {
        key.append(resolver.valueAt(row)).append(ExactUniq.JOIN);
      }
      if (!seen.add(key.toString())) {
        duplicates++;
      }
    }
    return duplicates;
  }

  private record Case(String name, int count, List<String> ids, List<ExactUniq.Resolver> columns) {}

  private static final List<Case> CASES =
      List.of(
          new Case(
              "a wide column and a narrow one, hundreds of collisions",
              3000,
              List.of("A", "B"),
              List.of(column(many(200, "a"), 1), column(many(25, "b"), 11))),
          new Case(
              "three columns, collisions in quantity",
              2000,
              List.of("A", "B", "C"),
              List.of(
                  column(many(50, "a"), 1),
                  column(many(20, "b"), 13),
                  column(many(6, "c"), 29))),
          new Case(
              "two columns drawing from one list",
              1500,
              List.of("A", "B"),
              List.of(column(many(60, "v"), 1), column(many(60, "v"), 11))));

  @Test
  @DisplayName("fingerprints find and fix exactly what text finds and fixes, at several pile counts")
  void theCarrierDoesNotChangeTheAnswer() {
    for (Case c : CASES) {
      String label = "\"" + String.join(" × ", c.ids()) + "\"";
      assertTrue(
          duplicateCount(c.columns(), c.count()) > 0,
          c.name() + ": nothing to repair, so the case proves nothing");

      List<String> text =
          rowsOf(
              ExactUniq.repair(c.ids(), c.columns(), c.count(), label, null, null, null),
              c.ids(),
              c.count());
      assertEquals(
          c.count(), new LinkedHashSet<>(text).size(), c.name() + ": the text repair left a duplicate");

      for (int buckets : new int[] {2, 8, 32}) {
        List<String> printed =
            rowsOf(
                ExactUniq.repair(
                    c.ids(), c.columns(), c.count(), label, null, null, null, null, buckets),
                c.ids(),
                c.count());
        assertEquals(text, printed, c.name() + ": " + buckets + " piles produced a different table");
      }
    }
  }

  @Test
  @DisplayName("a hash collision between DIFFERENT tuples never becomes a duplicate")
  void verificationEarnsItsPlace() {
    // Pinned directly, because at these sizes a real 64-bit collision does not happen — turn
    // verification off entirely and every comparison above still passes. Only a FORGED candidate
    // group can fail this: rows whose tuples differ, handed over as if their hashes had matched.
    List<ExactUniq.Resolver> resolvers =
        List.of(
            row -> "a" + row, // all distinct
            row -> row == 1 || row == 2 ? "same" : "b" + row);
    assertEquals(List.of(), ExactUniq.verifyCandidates(resolvers, List.of(List.of(5L, 6L))));
    // Rows 1 and 2 share ONLY the second column; the tuples still differ through the first.
    assertEquals(List.of(), ExactUniq.verifyCandidates(resolvers, List.of(List.of(1L, 2L, 9L))));

    // And a genuine repeat inside a mixed group survives, lowest row spared.
    List<ExactUniq.Resolver> twin =
        List.of(
            row -> row == 3 || row == 7 ? "x" : "a" + row,
            row -> row == 3 || row == 7 ? "y" : "b" + row);
    assertEquals(List.of(7), ExactUniq.verifyCandidates(twin, List.of(List.of(3L, 7L, 12L))));
  }

  @Test
  @DisplayName("a run with nothing to repair passes through untouched")
  void nothingToDo() {
    List<ExactUniq.Resolver> columns = List.of(column(many(400, "a"), 1), column(many(400, "b"), 1));
    List<String> ids = List.of("A", "B");
    Map<String, ExactUniq.Resolver> built =
        ExactUniq.repair(ids, columns, 400, "\"A × B\"", null, null, null, null, 8);
    List<String> rows = rowsOf(built, ids, 400);
    assertEquals(400, new LinkedHashSet<>(rows).size());
    // Untouched means untouched: every row still holds what it drew.
    for (int row = 0; row < 400; row++) {
      assertEquals(
          columns.get(0).valueAt(row) + "|" + columns.get(1).valueAt(row),
          rows.get(row),
          "row " + row + " moved although nothing needed repairing");
    }
  }
}
