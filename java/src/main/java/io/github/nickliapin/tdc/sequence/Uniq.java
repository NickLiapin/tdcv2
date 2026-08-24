package io.github.nickliapin.tdc.sequence;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

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

  /**
   * Give a group of {@code g} rows {@code g} DISTINCT values, when the column still has that many
   * left.
   *
   * <p>Two rows in the same group agree on every column before this one, so they are distinct only
   * if they differ HERE. The proportional split does not know that: it hands out values in
   * proportion to remaining stock, which repeats a value inside a group as soon as one value
   * dominates. Every such repeat is a duplicate row, and duplicates are what the repair then spends
   * quadratic time undoing.
   *
   * <p>Taking the {@code g} largest stocks costs nothing in exactness — the column's multiset is
   * fixed either way, and this only chooses WHICH row gets which value.
   *
   * @return false when the column has fewer values left than the group has rows, and the
   *     proportional path below handles it instead.
   */
  /**
   * The remaining stock of one column, ordered the way the deal picks from it: largest stock
   * first, ties to the value that appeared first.
   *
   * <p>That is what {@link #dealDistinct} wants, and it used to get it by walking the WHOLE pool
   * and SORTING it — once per group. Measured in the reference on a 6,000,000-row {@code <uniq>}
   * whose repair pool held 179,133 rows over 30,000 values: 44 of the run's 85 seconds, growing
   * with the product of the two, while the partner scan everyone suspected cost 2.
   *
   * <p>A binary heap answers the same question by popping. Entries go stale as the deal spends
   * stock, so a pop compares the entry against the live count in {@code pool} and discards it if
   * the value has moved on — the ordinary lazy heap. What does NOT change is the answer: same
   * order, same ties, same values to the same rows, byte for byte. That is the whole constraint
   * here — which value a row draws IS the dataset, so a faster deal that deals differently is a
   * different product.
   */
  private static final class StockHeap {
    /** {@code {stock, appearance}} with the value beside it, ordered largest stock first. */
    private record Entry(String value, int stock, int at) {}

    private final Map<String, Integer> pool;
    private final Map<String, Integer> at = new HashMap<>();
    private final PriorityQueue<Entry> heap =
        new PriorityQueue<>(
            Comparator.comparingInt((Entry e) -> -e.stock()).thenComparingInt(Entry::at));
    private int live;

    StockHeap(Map<String, Integer> pool) {
      this.pool = pool;
      // `at` counts every entry, not only the live ones, so a tie is broken by first appearance
      // the same way in every implementation.
      int appearance = 0;
      for (Map.Entry<String, Integer> entry : pool.entrySet()) {
        this.at.put(entry.getKey(), appearance);
        if (entry.getValue() > 0) {
          heap.add(new Entry(entry.getKey(), entry.getValue(), appearance));
          live++;
        }
        appearance++;
      }
    }

    /** Values with stock left — the {@code live.size()} the sort used to count. */
    int liveCount() {
      return live;
    }

    /**
     * The next value the sort would have put first, or null if none is left.
     *
     * <p>It is NOT returned to the heap here. A group takes several values and they must be
     * distinct, so the caller spends each one and hands them all back once the group is dealt —
     * until then a spent value has no fresh entry to be drawn a second time.
     */
    String take() {
      while (!heap.isEmpty()) {
        Entry top = heap.poll();
        if (top.stock() > 0 && pool.getOrDefault(top.value(), 0) == top.stock()) {
          return top.value();
        }
      }
      return null;
    }

    /** One unit of {@code value} dealt to a row. */
    void spend(String value) {
      int stock = pool.getOrDefault(value, 0) - 1;
      pool.put(value, stock);
      if (stock == 0) {
        live--;
      }
    }

    /** Put {@code value} back in the running at whatever stock it has now. */
    void restore(String value) {
      int stock = pool.getOrDefault(value, 0);
      if (stock > 0) {
        heap.add(new Entry(value, stock, at.getOrDefault(value, 0)));
      }
    }
  }

  private static boolean dealDistinct(
      StockHeap stock, List<Integer> indexes, List<List<String>> rows) {
    int g = indexes.size();
    // Asked before anything is spent, so a group too large for what is left is refused without
    // having to be undone.
    if (stock.liveCount() < g) {
      return false;
    }

    // The `g` largest stocks, ties by first appearance — the same values the full sort put at
    // the front, taken without sorting the rest.
    List<String> taken = new ArrayList<>(g);
    for (int m = 0; m < g; m++) {
      String chosen = stock.take();
      if (chosen == null) {
        for (String value : taken) {
          stock.restore(value);
        }
        return false;
      }
      // Spent as it is taken: that is what keeps a value out of the rest of THIS group, which is
      // the whole point of dealing distinct ones.
      stock.spend(chosen);
      taken.add(chosen);
      rows.get(indexes.get(m)).add(chosen);
    }
    for (String value : taken) {
      stock.restore(value);
    }
    return true;
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

      StockHeap stock = new StockHeap(pool);

      Map<String, List<Integer>> groups = new LinkedHashMap<>();
      for (int j = 0; j < n; j++) {
        groups.computeIfAbsent(String.join(SEP, rows.get(j)), ignored -> new ArrayList<>()).add(j);
      }

      // Largest groups first: they are the ones most in need of diversity, and the pool is
      // finite, so serving them last would leave them whatever nobody else wanted.
      List<List<Integer>> bySize = new ArrayList<>(groups.values());
      bySize.sort(Comparator.comparingInt((List<Integer> g) -> g.size()).reversed());

      for (List<Integer> indexes : bySize) {
        if (dealDistinct(stock, indexes, rows)) {
          continue;
        }
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
        Set<String> spent = new LinkedHashSet<>();
        for (int j : indexes) {
          String v = di < deck.size() ? deck.get(di) : deck.isEmpty() ? "" : deck.get(deck.size() - 1);
          di++;
          stock.spend(v);
          spent.add(v);
          rows.get(j).add(v);
        }
        // Back in the running at their new stocks, once the group is dealt.
        for (String value : spent) {
          stock.restore(value);
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
