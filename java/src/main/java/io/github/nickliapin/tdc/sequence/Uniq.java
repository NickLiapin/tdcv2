package io.github.nickliapin.tdc.sequence;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code uniq="true"} — make every row's tuple different from every other row's.
 *
 * <p>The one invariant everything here is built around: values are only ever <b>rearranged</b>,
 * never replaced. Each column keeps exactly the multiset of values it was drawn with, so a
 * declared {@code percent=} share survives unchanged. Uniqueness and an exact distribution are
 * not in tension — they coexist because the arrangement is a permutation.
 *
 * <p>Three pieces:
 *
 * <ul>
 *   <li>{@link #upperBound} — a proven ceiling. Asking for more than this is impossible, so it
 *       is a safe reject before any work.
 *   <li>{@link #capacity} — a simulation over the quota numbers alone, giving a safe floor. It
 *       certifies a huge config in milliseconds without assembling a single row.
 *   <li>{@link #arrange} — the constructive builder: proportional fill, then swap repair.
 * </ul>
 *
 * <p>Pure: no DSL, no randomness, no input beyond the columns. The rearrangement is a function
 * of the values drawn, which is what lets it be checked against a brute-force answer.
 */
public final class Uniq {

  /**
   * The separator that keys a tuple.
   *
   * <p>NUL, because it is the one character a generated value cannot contain. With a space
   * or a comma, {@code ["a b", "c"]} and {@code ["a", "b c"]} would key alike, and two
   * genuinely different rows would count as one duplicate — the exact mistake this file
   * exists to avoid.
   *
   * <p>Written as an escape rather than as the byte itself, so the source file stays text
   * to every tool that reads it.
   */
  private static final String SEP = "\0";

  /** Sweeps of swap repair before the arrangement is accepted as it stands. */
  private static final int MAX_SWEEPS = 8;

  public record Arrangement(List<List<String>> columns, int distinct) {}

  private Uniq() {}

  /** Counts of each distinct value in a column, in first-seen order. */
  public static List<Integer> valueCounts(List<String> column) {
    Map<String, Integer> counts = new LinkedHashMap<>();
    for (String v : column) {
      counts.merge(v, 1, Integer::sum);
    }
    return new ArrayList<>(counts.values());
  }

  /**
   * A proven upper bound on the distinct tuples these value-counts can produce.
   *
   * <p>It never undercounts, which is the property that matters: a config asking for more than
   * this is definitely impossible and can be refused immediately, with no risk of refusing one
   * that would have worked.
   */
  public static int upperBound(List<List<Integer>> columnCounts) {
    int need = 1;
    for (List<Integer> counts : byDeviation(columnCounts)) {
      int sum = 0;
      for (int c : counts) {
        sum += Math.min(c, need);
      }
      need = sum;
    }
    return need;
  }

  /**
   * A safe lower bound, simulated over the counts alone.
   *
   * <p>The builder always does at least this well, so reaching {@code need} here certifies the
   * config without touching any data — which is what makes a billion-row config answerable in
   * milliseconds.
   */
  public static int capacity(List<List<Integer>> columnCounts, int need) {
    List<List<Integer>> sorted = byDeviation(columnCounts);
    if (sorted.isEmpty()) {
      return 0;
    }
    List<Integer> profile = new ArrayList<>(sorted.get(0));
    for (int k = 1; k < sorted.size(); k++) {
      List<Integer> pool = new ArrayList<>(sorted.get(k));
      List<Integer> next = new ArrayList<>();
      List<Integer> groups = new ArrayList<>(profile);
      groups.sort(Comparator.reverseOrder());
      for (int groupSize : groups) {
        List<int[]> live = new ArrayList<>();
        for (int i = 0; i < pool.size(); i++) {
          if (pool.get(i) > 0) {
            live.add(new int[] {i, pool.get(i)});
          }
        }
        int[] split = proportionalSplit(groupSize, live);
        for (int x = 0; x < live.size(); x++) {
          if (split[x] > 0) {
            next.add(split[x]);
            pool.set(live.get(x)[0], pool.get(live.get(x)[0]) - split[x]);
          }
        }
      }
      profile = next;
      // The count only grows with each further column, so reaching the target certifies it.
      if (profile.size() >= need) {
        return profile.size();
      }
    }
    return profile.size();
  }

  /** Rearrange the columns so as many rows as possible carry a distinct tuple. */
  public static Arrangement arrange(List<List<String>> columns) {
    int k = columns.size();
    if (k == 0) {
      return new Arrangement(List.of(), 0);
    }
    int n = columns.get(0).size();
    if (n == 0) {
      List<List<String>> empty = new ArrayList<>();
      for (int i = 0; i < k; i++) {
        empty.add(new ArrayList<>());
      }
      return new Arrangement(empty, 0);
    }

    // Balanced columns first. A column whose values are evenly spread offers the most freedom,
    // so spending it early leaves the lopsided ones an easier job.
    List<Integer> order = new ArrayList<>();
    for (int i = 0; i < k; i++) {
      order.add(i);
    }
    List<Double> deviations = new ArrayList<>();
    for (List<String> column : columns) {
      deviations.add(stddev(valueCounts(column)));
    }
    order.sort(
        Comparator.<Integer, Double>comparing(deviations::get).thenComparing(Comparator.naturalOrder()));

    List<List<String>> sortedColumns = new ArrayList<>();
    for (int i : order) {
      sortedColumns.add(columns.get(i));
    }

    List<List<String>> rows = buildRows(sortedColumns);
    repairRows(rows);

    List<List<String>> out = new ArrayList<>();
    for (int i = 0; i < k; i++) {
      out.add(new ArrayList<>());
    }
    for (int sortedK = 0; sortedK < order.size(); sortedK++) {
      List<String> column = new ArrayList<>(rows.size());
      for (List<String> row : rows) {
        column.add(row.get(sortedK));
      }
      out.set(order.get(sortedK), column);
    }

    Map<String, Integer> seen = new HashMap<>();
    for (List<String> row : rows) {
      seen.merge(String.join(SEP, row), 1, Integer::sum);
    }
    return new Arrangement(out, seen.size());
  }

  /** Assemble rows column by column, spreading each column's values across the groups so far. */
  private static List<List<String>> buildRows(List<List<String>> columns) {
    List<String> first = columns.get(0);
    int n = first.size();
    List<List<String>> rows = new ArrayList<>(n);
    for (String v : first) {
      List<String> row = new ArrayList<>();
      row.add(v);
      rows.add(row);
    }

    for (int k = 1; k < columns.size(); k++) {
      Map<String, Integer> pool = new LinkedHashMap<>();
      for (String v : columns.get(k)) {
        pool.merge(v, 1, Integer::sum);
      }

      Map<String, List<Integer>> groups = new LinkedHashMap<>();
      for (int j = 0; j < n; j++) {
        groups.computeIfAbsent(String.join(SEP, rows.get(j)), ignored -> new ArrayList<>()).add(j);
      }

      // Largest groups first: they are the ones most in need of diversity, and the pool is
      // finite, so serving them last would leave them whatever nobody else wanted.
      List<List<Integer>> bySize = new ArrayList<>(groups.values());
      bySize.sort(Comparator.comparingInt((List<Integer> g) -> g.size()).reversed());

      for (List<Integer> indexes : bySize) {
        List<String> liveKeys = new ArrayList<>();
        List<int[]> live = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : pool.entrySet()) {
          if (entry.getValue() > 0) {
            liveKeys.add(entry.getKey());
            live.add(new int[] {live.size(), entry.getValue()});
          }
        }
        int[] split = proportionalSplit(indexes.size(), live);

        List<String> deck = new ArrayList<>();
        for (int x = 0; x < liveKeys.size(); x++) {
          for (int t = 0; t < split[x]; t++) {
            deck.add(liveKeys.get(x));
          }
        }
        deck.sort(Comparator.naturalOrder());

        int di = 0;
        for (int j : indexes) {
          String v = di < deck.size() ? deck.get(di) : deck.isEmpty() ? "" : deck.get(deck.size() - 1);
          di++;
          pool.merge(v, -1, Integer::sum);
          rows.get(j).add(v);
        }
      }
    }
    return rows;
  }

  /**
   * Swap repair: while a row duplicates another, trade one of its cells with another row's cell
   * in the same column whenever that strictly reduces the number of duplicates.
   *
   * <p>Swapping within a column is what preserves the multiset — the values move between rows
   * but the column still holds exactly what it held.
   */
  private static void repairRows(List<List<String>> rows) {
    int n = rows.size();
    int k = n > 0 ? rows.get(0).size() : 0;

    for (int sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      boolean improved = false;
      Map<String, Integer> counts = new HashMap<>();
      for (List<String> r : rows) {
        counts.merge(String.join(SEP, r), 1, Integer::sum);
      }

      for (int i = 0; i < n; i++) {
        List<String> ri = rows.get(i);
        String oldI = String.join(SEP, ri);
        if (counts.getOrDefault(oldI, 0) <= 1) {
          continue;
        }
        boolean done = false;
        for (int col = 0; col < k && !done; col++) {
          for (int j = 0; j < n && !done; j++) {
            List<String> rj = rows.get(j);
            if (j == i || ri.get(col).equals(rj.get(col))) {
              continue;
            }
            String oldJ = String.join(SEP, rj);
            List<String> ni = new ArrayList<>(ri);
            List<String> nj = new ArrayList<>(rj);
            ni.set(col, rj.get(col));
            nj.set(col, ri.get(col));
            String newI = String.join(SEP, ni);
            String newJ = String.join(SEP, nj);

            int before = 1 + (counts.getOrDefault(oldJ, 0) > 1 ? 1 : 0);
            // Only four tallies can change, so they are adjusted rather than recounted. The
            // obvious version copies the whole map inside the innermost loop, which makes a
            // sweep cubic in the row count and never finishes on a real dataset.
            int after =
                (trialCount(counts, newI, newI, newJ, oldI, oldJ) > 1 ? 1 : 0)
                    + (trialCount(counts, newJ, newI, newJ, oldI, oldJ) > 1 ? 1 : 0);

            if (after < before) {
              rows.set(i, ni);
              rows.set(j, nj);
              counts.merge(oldI, -1, Integer::sum);
              counts.merge(oldJ, -1, Integer::sum);
              counts.merge(newI, 1, Integer::sum);
              counts.merge(newJ, 1, Integer::sum);
              improved = true;
              done = true;
            }
          }
        }
      }
      if (!improved) {
        break;
      }
    }
  }

  private static int trialCount(
      Map<String, Integer> counts, String key, String newI, String newJ, String oldI, String oldJ) {
    return counts.getOrDefault(key, 0)
        + (key.equals(newI) ? 1 : 0)
        + (key.equals(newJ) ? 1 : 0)
        - (key.equals(oldI) ? 1 : 0)
        - (key.equals(oldJ) ? 1 : 0);
  }

  /** Largest-remainder split of {@code total} over parts of {@code {index, cap}}. */
  private static int[] proportionalSplit(int total, List<int[]> parts) {
    int[] out = new int[parts.size()];
    if (parts.isEmpty()) {
      return out;
    }
    double sumWeight = 0;
    for (int[] part : parts) {
      sumWeight += part[1];
    }

    double[] remainders = new double[parts.size()];
    int assigned = 0;
    for (int i = 0; i < parts.size(); i++) {
      double exact = sumWeight == 0 ? 0 : total * parts.get(i)[1] / sumWeight;
      out[i] = Math.min(parts.get(i)[1], (int) Math.floor(exact));
      remainders[i] = exact - Math.floor(exact);
      assigned += out[i];
    }

    List<Integer> order = new ArrayList<>();
    for (int i = 0; i < parts.size(); i++) {
      order.add(i);
    }
    final int finalAssigned = assigned;
    order.sort(
        (a, b) -> {
          int cmp = Double.compare(remainders[b], remainders[a]);
          return cmp != 0 ? cmp : Integer.compare(a, b);
        });
    for (int i : order) {
      if (assigned >= total) {
        break;
      }
      if (out[i] < parts.get(i)[1]) {
        out[i]++;
        assigned++;
      }
    }

    // Whatever the clamping left over, round-robin into the parts that still have room.
    for (int i = 0; assigned < total; i = (i + 1) % out.length) {
      if (out[i] < parts.get(i)[1]) {
        out[i]++;
        assigned++;
      } else {
        boolean anyRoom = false;
        for (int x = 0; x < out.length; x++) {
          if (out[x] < parts.get(x)[1]) {
            anyRoom = true;
            break;
          }
        }
        if (!anyRoom) {
          break;
        }
      }
    }
    return out;
  }

  /** Column-count vectors ordered by how evenly spread they are, most balanced first. */
  private static List<List<Integer>> byDeviation(List<List<Integer>> items) {
    List<Integer> order = new ArrayList<>();
    for (int i = 0; i < items.size(); i++) {
      order.add(i);
    }
    List<Double> deviations = new ArrayList<>();
    for (List<Integer> counts : items) {
      deviations.add(stddev(counts));
    }
    order.sort(
        Comparator.<Integer, Double>comparing(deviations::get).thenComparing(Comparator.naturalOrder()));
    List<List<Integer>> out = new ArrayList<>();
    for (int i : order) {
      out.add(items.get(i));
    }
    return out;
  }

  private static double stddev(List<Integer> nums) {
    int n = nums.size();
    if (n < 2) {
      return 0;
    }
    double mean = 0;
    for (int v : nums) {
      mean += v;
    }
    mean /= n;
    double variance = 0;
    for (int v : nums) {
      variance += (v - mean) * (v - mean);
    }
    return Math.sqrt(variance / (n - 1));
  }
}
