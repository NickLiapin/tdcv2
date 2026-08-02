package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.sequence.Uniq;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Exact percentages and uniqueness at the same time, past the size of memory.
 *
 * <p>The streaming engine can give unique combinations, but only uniform ones: its mixed-radix
 * index spreads rows evenly over the combination space by construction. It can give exact
 * percentages too. It cannot give both, because the arrangement that satisfies one is not free to
 * satisfy the other. The in-memory engine does both by holding the whole table and repairing
 * collisions, which is precisely what stops working at scale.
 *
 * <p>So: build each column with its exact quota the seekable way, then ask whether the tuples
 * happen to be distinct — a question a sort on disk can answer with bounded memory. Usually they
 * are, because a run of a million rows over a space of billions collides by birthday odds, which
 * is to say rarely. Then nothing more is needed and the whole run stays O(1) in memory.
 *
 * <p>When there are collisions there are few of them, so they can be repaired in RAM: gather the
 * colliding rows plus enough neighbours to give them somewhere to move, learn which tuples
 * already exist inside that small value space, and rearrange the pool to avoid them. Only the
 * pool's rows move, and only among the pool's own values, so every column's totals come out
 * exactly as declared. A pool too tight to solve hands the config back to the in-memory engine
 * rather than shipping data that is nearly unique.
 */
final class ExactUniq {

  /** Separates a tuple's columns. Control characters cannot appear in a generated value. */
  private static final char JOIN = 1;

  /** Separates a key from its row index in a sortable record. NUL sorts below everything. */
  private static final char SEP = 0;

  /** Enough digits for any run: the index is padded so byte order is also numeric order. */
  private static final int INDEX_WIDTH = 16;

  /** The pool repair is quadratic; past this many collisions, the config is pathological. */
  private static final int MAX_REPAIR_ROWS = 20_000;

  /** The exact construction collided and the bounded repair could not place every row. */
  static final class RepairNeeded extends RuntimeException {

    private static final long serialVersionUID = 1L;

    RepairNeeded(int collisions, String label) {
      super(
          "Engine 3: uniq "
              + label
              + " is too tight for the bounded-memory repair ("
              + collisions
              + " row(s) couldn't be placed) — using the in-memory engine instead.");
    }
  }

  /** One uniq column: where it lands in the registry, its values, and their shares. */
  record Field(String id, List<String> values, double[] percents) {}

  /** A column of the finished arrangement: the value it gives a row. */
  interface Resolver {
    String valueAt(int row);
  }

  private ExactUniq() {}

  /**
   * Build the uniq columns with exact shares, and make sure the tuples really are distinct.
   *
   * @return one resolver per field, in the order they were given
   */
  static Map<String, Resolver> arrange(
      List<Field> fields, int count, String seed, String label, Path tmpDir) {
    List<List<Integer>> columnCounts = new ArrayList<>();
    List<int[]> counts = new ArrayList<>();
    for (Field field : fields) {
      int[] c =
          Hamilton.countsPerValue(
              count, field.percents(), Prng.create(seed + "|" + field.id() + "|pct"));
      counts.add(c);
      List<Integer> boxed = new ArrayList<>(c.length);
      for (int value : c) {
        boxed.add(value);
      }
      columnCounts.add(boxed);
    }

    int upper = Uniq.upperBound(columnCounts);
    if (count > upper) {
      throw new IllegalStateException(
          "uniq "
              + label
              + " is infeasible — its data supports at most "
              + upper
              + " distinct rows, but "
              + count
              + " were requested. Widen a column's values or lower count.");
    }

    List<Resolver> resolvers = new ArrayList<>();
    for (int j = 0; j < fields.size(); j++) {
      Field field = fields.get(j);
      int[] cumHi = cumulative(counts.get(j));
      int key = Permute.key(seed, field.id());
      List<String> values = field.values();
      resolvers.add(row -> values.get(runFor(cumHi, Permute.permute(row, count, key))));
    }

    // If any column uses each of its values at most once, the tuple is unique by that column
    // alone. Worth checking: it turns the whole verification pass into an inspection of a
    // handful of integers, and a serial-number column makes it true.
    for (int[] c : counts) {
      boolean injective = true;
      for (int value : c) {
        if (value > 1) {
          injective = false;
          break;
        }
      }
      if (injective) {
        return registryOf(fields, resolvers);
      }
    }
    return repair(fields, resolvers, count, label, tmpDir);
  }

  private static Map<String, Resolver> registryOf(List<Field> fields, List<Resolver> resolvers) {
    Map<String, Resolver> out = new LinkedHashMap<>();
    for (int j = 0; j < fields.size(); j++) {
      out.put(fields.get(j).id(), resolvers.get(j));
    }
    return out;
  }

  /**
   * Verify, and repair what the construction left colliding.
   *
   * <p>The repair moves a small pool of rows and nothing else. That is what keeps the percentages
   * exact: a value only ever changes hands between two rows of the pool, so every column ends the
   * pass with the multiset it started with.
   */
  private static Map<String, Resolver> repair(
      List<Field> fields, List<Resolver> resolvers, int count, String label, Path tmpDir) {
    // Keep the first row of every colliding group; the rest have to move.
    List<Integer> excess = new ArrayList<>();
    Iterator<List<Integer>> groups = duplicateGroups(resolvers, count, tmpDir);
    while (groups.hasNext()) {
      List<Integer> group = groups.next();
      for (int m = 1; m < group.size(); m++) {
        excess.add(group.get(m));
      }
    }
    if (excess.isEmpty()) {
      return registryOf(fields, resolvers);
    }
    if (excess.size() > MAX_REPAIR_ROWS) {
      throw new RepairNeeded(excess.size(), label);
    }

    // The colliding rows on their own often lack the variety to move — a lone duplicate can only
    // re-form the tuple it already has. So the pool takes in donor rows sampled across the run,
    // which gives the arrangement room without letting any value leave the pool.
    int donorTarget = Math.min(count - excess.size(), 8 * excess.size() + 24);
    Set<Integer> inPool = new HashSet<>(excess);
    List<Integer> pool = new ArrayList<>(excess);
    if (donorTarget > 0) {
      int stride = Math.max(1, count / donorTarget);
      for (int i = 0; i < count && pool.size() - excess.size() < donorTarget; i += stride) {
        if (inPool.add(i)) {
          pool.add(i);
        }
      }
    }
    java.util.Collections.sort(pool);

    int k = resolvers.size();
    List<List<String>> poolColumns = new ArrayList<>();
    List<Set<String>> poolSpace = new ArrayList<>();
    for (int j = 0; j < k; j++) {
      List<String> column = new ArrayList<>(pool.size());
      for (int row : pool) {
        column.add(resolvers.get(j).valueAt(row));
      }
      poolColumns.add(column);
      poolSpace.add(new HashSet<>(column));
    }

    // The only tuples a rearranged pool row could collide with are the ones already present
    // whose every value lies inside the pool's own value space. One pass finds them.
    Set<String> forbidden = new HashSet<>();
    for (int i = 0; i < count; i++) {
      if (inPool.contains(i)) {
        continue;
      }
      StringBuilder key = new StringBuilder();
      boolean inSpace = true;
      for (int j = 0; j < k; j++) {
        String value = resolvers.get(j).valueAt(i);
        if (!poolSpace.get(j).contains(value)) {
          inSpace = false;
          break;
        }
        if (j > 0) {
          key.append(JOIN);
        }
        key.append(value);
      }
      if (inSpace) {
        forbidden.add(key.toString());
      }
    }

    List<List<String>> arranged = arrangeAvoiding(poolColumns, forbidden, pool.size());
    if (arranged == null) {
      throw new RepairNeeded(excess.size(), label);
    }

    Map<Integer, List<String>> override = new HashMap<>();
    for (int m = 0; m < pool.size(); m++) {
      List<String> tuple = new ArrayList<>(k);
      for (List<String> column : arranged) {
        tuple.add(column.get(m));
      }
      override.put(pool.get(m), tuple);
    }

    Map<String, Resolver> out = new LinkedHashMap<>();
    for (int j = 0; j < k; j++) {
      int column = j;
      Resolver base = resolvers.get(j);
      out.put(
          fields.get(j).id(),
          row -> {
            List<String> replaced = override.get(row);
            return replaced == null ? base.valueAt(row) : replaced.get(column);
          });
    }
    return out;
  }

  /**
   * The groups of rows whose tuples are identical, in bounded memory.
   *
   * <p>Sorting is what makes this affordable: equal keys end up adjacent, so the scan holds one
   * group rather than a set of every tuple seen. The row index is padded to a fixed width and
   * appended after a NUL, which makes plain byte order the same as ordering by key and then by
   * row — no record has to be parsed to be compared.
   */
  private static Iterator<List<Integer>> duplicateGroups(
      List<Resolver> resolvers, int count, Path tmpDir) {
    Iterator<String> records =
        new Iterator<>() {
          private int row;

          @Override
          public boolean hasNext() {
            return row < count;
          }

          @Override
          public String next() {
            if (row >= count) {
              throw new NoSuchElementException();
            }
            int i = row++;
            StringBuilder key = new StringBuilder();
            for (int j = 0; j < resolvers.size(); j++) {
              if (j > 0) {
                key.append(JOIN);
              }
              key.append(resolvers.get(j).valueAt(i));
            }
            key.append(SEP);
            String index = String.valueOf(i);
            key.append("0".repeat(INDEX_WIDTH - index.length())).append(index);
            return key.toString();
          }
        };

    Iterator<String> sorted = ExternalSort.sort(records, 0, tmpDir);
    return new Iterator<>() {
      private String currentKey;
      private List<Integer> group = new ArrayList<>();
      private List<Integer> ready;

      @Override
      public boolean hasNext() {
        while (ready == null && sorted.hasNext()) {
          String record = sorted.next();
          int split = record.lastIndexOf(SEP);
          String key = record.substring(0, split);
          int index = Integer.parseInt(record.substring(split + 1).replaceFirst("^0+(?=\\d)", ""));
          if (!key.equals(currentKey)) {
            if (group.size() >= 2) {
              ready = group;
            }
            group = new ArrayList<>();
            currentKey = key;
          }
          group.add(index);
        }
        if (ready == null && !sorted.hasNext() && group.size() >= 2) {
          ready = group;
          group = new ArrayList<>();
        }
        return ready != null;
      }

      @Override
      public List<Integer> next() {
        if (!hasNext()) {
          throw new NoSuchElementException();
        }
        List<Integer> out = ready;
        ready = null;
        return out;
      }
    };
  }

  /**
   * Rearrange the pool's columns so its tuples are distinct and none is already taken.
   *
   * <p>Each column is permuted within itself, never added to or taken from, so the pool's totals
   * survive the pass. What changes is which values meet each other.
   */
  private static List<List<String>> arrangeAvoiding(
      List<List<String>> columns, Set<String> forbidden, int size) {
    int k = columns.size();
    if (size == 0 || k == 0) {
      return new ArrayList<>(columns);
    }

    List<List<String>> arranged = Uniq.arrange(columns).columns();
    List<List<String>> rows = new ArrayList<>(size);
    for (int i = 0; i < size; i++) {
      List<String> row = new ArrayList<>(k);
      for (List<String> column : arranged) {
        row.add(column.get(i));
      }
      rows.add(row);
    }

    for (int sweep = 0; sweep < 32; sweep++) {
      Map<String, Integer> tally = new HashMap<>();
      for (List<String> row : rows) {
        tally.merge(keyOf(row), 1, Integer::sum);
      }
      boolean improved = false;

      for (int i = 0; i < size; i++) {
        List<String> ri = rows.get(i);
        String keyI = keyOf(ri);
        if (tally.getOrDefault(keyI, 0) <= 1 && !forbidden.contains(keyI)) {
          continue;
        }
        boolean done = false;
        for (int col = 0; col < k && !done; col++) {
          for (int j = 0; j < size && !done; j++) {
            List<String> rj = rows.get(j);
            if (j == i || ri.get(col).equals(rj.get(col))) {
              continue;
            }
            List<String> ni = new ArrayList<>(ri);
            List<String> nj = new ArrayList<>(rj);
            ni.set(col, rj.get(col));
            nj.set(col, ri.get(col));
            String keyJ = keyOf(rj);
            String newI = keyOf(ni);
            String newJ = keyOf(nj);

            // Row i is known bad — that is why a partner is being looked for at all.
            int before = 1 + (isBad(tally, forbidden, keyJ) ? 1 : 0);
            // A swap moves two rows, so only four tallies can change. Computing the delta beats
            // copying the whole table inside the innermost loop, which is what makes a large
            // pool finish rather than hang.
            int after =
                (isBadAfter(tally, forbidden, newI, keyI, keyJ, newI, newJ) ? 1 : 0)
                    + (isBadAfter(tally, forbidden, newJ, keyI, keyJ, newI, newJ) ? 1 : 0);
            if (after < before) {
              rows.set(i, ni);
              rows.set(j, nj);
              tally.merge(keyI, -1, Integer::sum);
              tally.merge(keyJ, -1, Integer::sum);
              tally.merge(newI, 1, Integer::sum);
              tally.merge(newJ, 1, Integer::sum);
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

    Map<String, Integer> finalTally = new HashMap<>();
    for (List<String> row : rows) {
      finalTally.merge(keyOf(row), 1, Integer::sum);
    }
    for (List<String> row : rows) {
      if (isBad(finalTally, forbidden, keyOf(row))) {
        return null;
      }
    }

    List<List<String>> out = new ArrayList<>(k);
    for (int j = 0; j < k; j++) {
      List<String> column = new ArrayList<>(size);
      for (List<String> row : rows) {
        column.add(row.get(j));
      }
      out.add(column);
    }
    return out;
  }

  private static boolean isBad(Map<String, Integer> tally, Set<String> forbidden, String key) {
    return tally.getOrDefault(key, 0) > 1 || forbidden.contains(key);
  }

  /** The verdict on {@code key} as it would stand after the two rows swapped. */
  private static boolean isBadAfter(
      Map<String, Integer> tally,
      Set<String> forbidden,
      String key,
      String oldI,
      String oldJ,
      String newI,
      String newJ) {
    int after =
        tally.getOrDefault(key, 0)
            + (key.equals(newI) ? 1 : 0)
            + (key.equals(newJ) ? 1 : 0)
            - (key.equals(oldI) ? 1 : 0)
            - (key.equals(oldJ) ? 1 : 0);
    return after > 1 || forbidden.contains(key);
  }

  private static String keyOf(List<String> row) {
    return String.join(String.valueOf(JOIN), row);
  }

  private static int[] cumulative(int[] counts) {
    int[] out = new int[counts.length];
    int acc = 0;
    for (int i = 0; i < counts.length; i++) {
      acc += counts[i];
      out[i] = acc;
    }
    return out;
  }

  private static int runFor(int[] cumHi, int slot) {
    int lo = 0;
    int hi = cumHi.length - 1;
    while (lo < hi) {
      int mid = (lo + hi) >>> 1;
      if (slot < cumHi[mid]) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }
}
