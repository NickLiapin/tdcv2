package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.sequence.Uniq;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
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
import java.util.function.IntFunction;

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
  static final char JOIN = 1;

  /** Separates a key from its row index in a sortable record. NUL sorts below everything. */
  private static final char SEP = 0;

  /** Enough digits for any run: the index is padded so byte order is also numeric order. */
  private static final int INDEX_WIDTH = 16;

  /** The pool repair is quadratic; past this many collisions, the config is pathological. */
  /** Anything that can answer "is this tuple taken?" — an exact set, or the disk ledger. */
  public interface Membership {
    boolean has(String key);
  }

  /** The small-run answer: every in-space tuple, held exactly. */
  private record ExactMembership(Set<String> keys) implements Membership {
    @Override
    public boolean has(String key) {
      return keys.contains(key);
    }
  }

  /**
   * How many colliding rows the bounded repair takes on, for a run of {@code count}.
   *
   * <p>A flat cap was written when the repair was quadratic in its pool. It is not any more, and
   * collisions grow as the SQUARE of the run — so a flat cap doomed every sufficiently large run.
   * A thousandth of the rows keeps the repair pool in tens of megabytes at any size, and the floor
   * keeps small runs as permissive as they were.
   */
  private static int maxRepairRowsFor(int count) {
    return Math.max(20_000, count / 1000);
  }

  /**
   * Rows past which the in-memory engine is NOT a fallback. Past this it cannot hold the table at
   * all, so falling back is not failing fast — it is failing after a long materialisation with
   * nothing written.
   */
  public static final int IN_MEMORY_FALLBACK_MAX_ROWS = 20_000_000;

  /**
   * The exact construction collided and the bounded repair could not place every row.
   *
   * <p>Two audiences, one sentence. A caller that CHOSE a bounded-memory engine for the user
   * catches this and falls back to the in-memory engine, which has the whole table to work with. A
   * caller the user forced into stream mode lets it through instead: holding the whole table is
   * the one thing that user asked not to happen, so the text says what to change rather than
   * claiming a fallback that did not occur.
   */
  static final class RepairNeeded extends RuntimeException {

    private static final long serialVersionUID = 1L;

    RepairNeeded(int collisions, String label) {
      this(collisions, label, false);
    }

    /**
     * {@code atLeast} says the count is a floor, not a total.
     *
     * <p>The scan that finds repeats stops as soon as it is past the cap, because nothing it
     * could find afterwards changes the answer. What it gives up is the exact figure, and a
     * number that is quietly 20,001 where the truth is 1,618,803 is worse than no number: it
     * invites someone to widen a column by a little.
     */
    RepairNeeded(int collisions, String label, boolean atLeast) {
      super(
          "uniq "
              + label
              + " is too tight to repair without holding the whole table ("
              + (atLeast ? "more than " + collisions + " rows" : collisions + " row(s)")
              + " couldn't be placed) — run without mode=\"stream\" so the in-memory "
              + "engine can arrange it.");
    }
  }

  /** One uniq column: where it lands in the registry, its values, and their shares. */
  record Field(String id, List<String> values, double[] percents) {}

  /**
   * How an arrangement travels between the thread that works it out and the ones that do not.
   *
   * <p>Deciding which rows a uniq group moves where is a pass over every row to find the
   * collisions and a second to learn which tuples are taken — the expensive half of a uniq run,
   * and the same answer every time for a given config and seed. {@code onComputed} hands the
   * result out; {@code preset} hands it back in, and a worker holding one skips the analysis
   * entirely. That is what lets several threads render different row ranges of one uniq config
   * instead of each repeating the whole hunt.
   *
   * <p>The result is small — only the rows that actually moved — so it crosses a thread boundary
   * for nothing.
   */
  record Plan(
      Map<Integer, List<String>> preset,
      java.util.function.Consumer<Map<Integer, List<String>>> onComputed) {}

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
      List<Field> fields, int count, String seed, String label, Path tmpDir, Progress onProgress) {
    return arrange(fields, count, seed, label, tmpDir, onProgress, null);
  }

  /** The same, with an arrangement handed in or handed out — see {@link Plan}. */
  static Map<String, Resolver> arrange(
      List<Field> fields,
      int count,
      String seed,
      String label,
      Path tmpDir,
      Progress onProgress,
      Plan plan) {
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
        // Nothing moves, and a worker waiting to be told must hear that rather than wait.
        if (plan != null && plan.onComputed() != null) {
          plan.onComputed().accept(new HashMap<>());
        }
        return registryOf(idsOf(fields), resolvers);
      }
    }
    return repair(idsOf(fields), resolvers, count, label, tmpDir, null, onProgress, plan);
  }

  private static Map<String, Resolver> registryOf(List<String> ids, List<Resolver> resolvers) {
    Map<String, Resolver> out = new LinkedHashMap<>();
    for (int j = 0; j < ids.size(); j++) {
      out.put(ids.get(j), resolvers.get(j));
    }
    return out;
  }

  private static List<String> idsOf(List<Field> fields) {
    List<String> ids = new ArrayList<>(fields.size());
    for (Field field : fields) {
      ids.add(field.id());
    }
    return ids;
  }

  /**
   * Verify, and repair what the construction left colliding.
   *
   * <p>The repair moves a small pool of rows and nothing else. That is what keeps the percentages
   * exact: a value only ever changes hands between two rows of the pool, so every column ends the
   * pass with the multiset it started with.
   *
   * <p>{@code blockOf} names which rows may trade values with each other. A {@code <switch>}
   * member draws from a different list depending on another column, so a male row's first name is
   * not a value a female row is allowed to hold; without this the repair would keep the tuple
   * unique and stop the record making sense. {@code null} means one block holding everything,
   * which is the ordinary case.
   */
  static Map<String, Resolver> repair(
      List<String> ids,
      List<Resolver> resolvers,
      int count,
      String label,
      Path tmpDir,
      IntFunction<String> blockOf,
      Progress onProgress) {
    return repair(ids, resolvers, count, label, tmpDir, blockOf, onProgress, null);
  }

  /** The same, with an arrangement handed in or handed out — see {@link Plan}. */
  static Map<String, Resolver> repair(
      List<String> ids,
      List<Resolver> resolvers,
      int count,
      String label,
      Path tmpDir,
      IntFunction<String> blockOf,
      Progress onProgress,
      Plan plan) {
    // Told rather than worked out: the whole point of a plan. Nothing below this line runs.
    if (plan != null && plan.preset() != null) {
      return applyOverride(ids, resolvers, plan.preset());
    }

    // How the duplicates are hunted: by fingerprint on a large run, by tuple text on a small one.
    // The carrier is all that differs — the rows found are the same either way, because a matching
    // fingerprint is verified against the true tuples before it is believed.
    RepairReport report = new RepairReport(onProgress);
    FingerprintScan scan = fingerprintScan(resolvers, count, tmpDir, onProgress, report);

    List<Integer> excess = new ArrayList<>();
    if (scan != null) {
      excess.addAll(scan.excess());
    } else {
      // Keep the first row of every colliding group; the rest have to move.
      Iterator<List<Integer>> groups = duplicateGroups(resolvers, count, tmpDir);
      while (groups.hasNext()) {
        List<Integer> group = groups.next();
        for (int m = 1; m < group.size(); m++) {
          excess.add(group.get(m));
        }
      }
    }
    if (excess.isEmpty()) {
      if (scan != null) {
        scan.drop();
      }
      if (plan != null && plan.onComputed() != null) {
        plan.onComputed().accept(new HashMap<>());
      }
      return registryOf(ids, resolvers);
    }
    int cap = maxRepairRowsFor(count);
    if (excess.size() > cap) {
      if (scan != null) {
        scan.drop();
      }
      // The fingerprint path stops counting once it is past the cap, so its figure is a floor.
      // Said as a floor; everywhere else it is exact.
      boolean partial = scan != null && scan.partial();
      throw new RepairNeeded(partial ? cap : excess.size(), label, partial);
    }

    // The colliding rows on their own often lack the variety to move — a lone duplicate can only
    // re-form the tuple it already has. So the pool takes in donor rows sampled across the run,
    // which gives the arrangement room without letting any value leave the pool.
    java.util.Collections.sort(excess);
    int donorTarget = Math.min(count - excess.size(), 8 * excess.size() + 24);
    Set<Integer> inPool = new HashSet<>(excess);
    List<Integer> pool = new ArrayList<>(excess);
    if (donorTarget > 0 && blockOf == null) {
      int stride = Math.max(1, count / donorTarget);
      for (int i = 0; i < count && pool.size() - excess.size() < donorTarget; i += stride) {
        if (inPool.add(i)) {
          pool.add(i);
        }
      }
    } else if (donorTarget > 0) {
      // Donors have to come from the row's OWN block, or they arrive holding values it is not
      // allowed to take. Wanted per block, in proportion to how many of its rows have to move.
      Map<String, Integer> wanted = new LinkedHashMap<>();
      for (int row : excess) {
        wanted.merge(blockOf.apply(row), 8, Integer::sum);
      }
      for (Map.Entry<String, Integer> entry : wanted.entrySet()) {
        entry.setValue(entry.getValue() + 24);
      }
      int stride = Math.max(1, count / Math.max(1, donorTarget));
      for (int i = 0; i < count; i += stride) {
        if (inPool.contains(i)) {
          continue;
        }
        String block = blockOf.apply(i);
        Integer left = wanted.get(block);
        if (left == null || left <= 0) {
          continue;
        }
        wanted.put(block, left - 1);
        inPool.add(i);
        pool.add(i);
      }
    }
    java.util.Collections.sort(pool);

    int k = resolvers.size();
    report.step(pool.size());
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

    // "Is this tuple taken?" — answered one of two ways.
    //
    // Large run: no structure at all. The sorted fingerprint piles on disk ARE the ledger, and a
    // query is a binary search. Small run: derive every row's tuple once more and hold the ones
    // inside the pool's value space in an exact set, exactly as before.
    Membership forbidden;
    Fingerprint.Ledger ledger = null;
    if (scan != null) {
      ledger = new Fingerprint.Ledger(scan.sortedPaths(), inPool);
      forbidden = ledger;
    } else {
      Set<String> exact = new HashSet<>();
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
          exact.add(key.toString());
        }
      }
      forbidden = new ExactMembership(exact);
    }

    // The pool is arranged one block at a time: a value only ever lands on a row that was allowed
    // to hold it. One block, keyed by the empty string, is the ordinary case.
    Map<String, List<Integer>> blocks = new LinkedHashMap<>();
    for (int m = 0; m < pool.size(); m++) {
      String block = blockOf == null ? "" : blockOf.apply(pool.get(m));
      blocks.computeIfAbsent(block, unused -> new ArrayList<>()).add(m);
    }

    Map<Integer, List<String>> override = new HashMap<>();
    try {
      for (List<Integer> positions : blocks.values()) {
        List<List<String>> columns = new ArrayList<>(k);
        for (List<String> column : poolColumns) {
          List<String> slice = new ArrayList<>(positions.size());
          for (int m : positions) {
            slice.add(column.get(m));
          }
          columns.add(slice);
        }
        List<List<String>> arranged =
            arrangeAvoiding(columns, forbidden, positions.size(), report);
        if (arranged == null) {
          throw new RepairNeeded(excess.size(), label);
        }
        for (int at = 0; at < positions.size(); at++) {
          List<String> tuple = new ArrayList<>(k);
          for (List<String> column : arranged) {
            tuple.add(column.get(at));
          }
          override.put(pool.get(positions.get(at)), tuple);
        }
      }
    } finally {
      if (ledger != null) {
        ledger.close();
      }
      if (scan != null) {
        scan.drop();
      }
    }

    report.finish();
    if (plan != null && plan.onComputed() != null) {
      plan.onComputed().accept(override);
    }
    return applyOverride(ids, resolvers, override);
  }

  /**
   * Columns that answer from the override where there is one and from the original resolver
   * everywhere else — which is all a repaired uniq column IS.
   */
  private static Map<String, Resolver> applyOverride(
      List<String> ids, List<Resolver> resolvers, Map<Integer, List<String>> override) {
    Map<String, Resolver> out = new LinkedHashMap<>();
    for (int j = 0; j < ids.size(); j++) {
      int column = j;
      Resolver base = resolvers.get(j);
      out.put(
          ids.get(j),
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
  /** What the fingerprint hunt produced: the sorted piles, their home, and the verified rows. */
  /** {@code partial} is true when the verify stopped at the cap, so {@code excess} is a floor. */
  private record FingerprintScan(
      List<Path> sortedPaths, Path directory, List<Integer> excess, boolean partial) {
    void drop() {
      for (Path path : sortedPaths) {
        try {
          Files.deleteIfExists(path);
        } catch (IOException ignored) {
          // A leftover pile in a temp directory is not worth failing a run over.
        }
      }
      try {
        Files.deleteIfExists(directory);
      } catch (IOException ignored) {
        // Same.
      }
    }
  }

  /**
   * Hunt duplicates by fingerprint, or return null to leave the text path in charge.
   *
   * <p>Every row's tuple is hashed into a 13-byte record routed straight to its pile; each pile is
   * sorted as raw bytes; groups sharing a hash are CANDIDATES. Verification then recomputes the
   * true tuples for those few rows, so a 64-bit collision costs one recomputation and never a
   * false duplicate — the rows returned are exactly the ones the text sort would name.
   */
  private static FingerprintScan fingerprintScan(
      List<Resolver> resolvers, int count, Path tmpDir, Progress onProgress, RepairReport report) {
    int buckets = Fingerprint.bucketCountFor(count, Runtime.getRuntime().availableProcessors());
    if (buckets < 2) {
      return null;
    }
    Path directory;
    try {
      directory =
          tmpDir == null
              ? Files.createTempDirectory("tdc-fp-")
              : Files.createTempDirectory(tmpDir, "tdc-fp-");
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }

    List<java.util.function.IntFunction<String>> asFunctions = new ArrayList<>();
    for (Resolver resolver : resolvers) {
      asFunctions.add(resolver::valueAt);
    }
    List<Path> rawPaths =
        Fingerprint.writePiles(
            asFunctions, 0, count, directory, "raw", buckets, String.valueOf(JOIN), onProgress);

    List<Path> sortedPaths = new ArrayList<>();
    List<List<Long>> candidates = new ArrayList<>();
    for (int b = 0; b < buckets; b++) {
      if (onProgress != null) {
        onProgress.report("uniq-sort", b, buckets);
      }
      Path out = directory.resolve("sorted-" + b);
      Fingerprint.sortFiles(List.of(rawPaths.get(b)), out, directory);
      try {
        Files.deleteIfExists(rawPaths.get(b));
      } catch (IOException ignored) {
        // The sorted copy is what matters; a stale raw pile costs a temp file.
      }
      sortedPaths.add(out);
      candidates.addAll(Fingerprint.candidateGroups(out));
    }
    // Past the cap the caller refuses whatever the exact figure is, so the verify is told where
    // the answer stops mattering.
    int stopAfter = maxRepairRowsFor(count);
    List<Integer> excess = verify(resolvers, candidates, report, stopAfter);
    return new FingerprintScan(sortedPaths, directory, excess, excess.size() > stopAfter);
  }

  /**
   * One rising scale for the whole {@code uniq-repair} phase.
   *
   * <p>The repair is several steps with different units: candidate groups to check here, pool rows
   * to prepare there, then a deal repeated per sweep. Reported straight, each step would restart
   * the counter at zero, and a bar drawn from the phase would jump backwards every time one ended
   * — which reads as a bug, not as progress.
   *
   * <p>So the steps are added up. Each declares its size, the phase's total grows to hold it, and
   * {@code done} only ever rises. The total is not known in advance and is not meant to be: it is
   * what has been taken on so far.
   */
  // Package-private, not private: the rising scale is a promise to whoever draws a bar from
  // this channel, and a promise is worth a test of its own.
  static final class RepairReport {
    private final Progress onProgress;
    private long base;
    private long size;

    RepairReport(Progress onProgress) {
      this.onProgress = onProgress;
    }

    private void emit(long done) {
      if (onProgress != null) {
        onProgress.report("uniq-repair", fits(done), fits(base + size));
      }
    }

    /**
     * The channel carries {@code int}s and the scale is a SUM, so it could in principle outgrow
     * one where a row count never does. Held at the ceiling rather than wrapped: a bar that stops
     * at full is wrong by a little, a bar that goes negative is wrong by everything.
     */
    private static int fits(long value) {
      return value > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) value;
    }

    /** Take on a step of {@code size} units. Ends the previous one. */
    void step(long next) {
      base += size;
      size = next;
      emit(base);
    }

    /** {@code done} units into the current step. */
    void at(long done) {
      emit(base + done);
    }

    /** Close the phase full, so a watcher sees it end rather than stall. */
    void finish() {
      emit(base + size);
    }
  }

  /** Keep only the rows whose tuples GENUINELY repeat, lowest row of each group spared. */
  private static List<Integer> verify(
      List<Resolver> resolvers, List<List<Long>> candidates, RepairReport report, int stopAfter) {
    List<Integer> excess = new ArrayList<>();
    report.step(candidates.size());
    // Reported, because this is where a large run goes quiet: every candidate group costs a
    // tuple recomputed per row to tell a real duplicate from a hash collision, and there can be
    // a hundred thousand of them — tens of seconds between the last sort and the first row.
    int reportEvery = Math.max(1, candidates.size() / 200);
    int done = 0;
    for (List<Long> group : candidates) {
      if (done % reportEvery == 0) {
        report.at(done);
      }
      done++;
      Map<String, List<Integer>> byKey = new HashMap<>();
      for (long row : group) {
        StringBuilder key = new StringBuilder();
        for (int r = 0; r < resolvers.size(); r++) {
          if (r > 0) {
            key.append(JOIN);
          }
          key.append(resolvers.get(r).valueAt((int) row));
        }
        byKey.computeIfAbsent(key.toString(), ignored -> new ArrayList<>()).add((int) row);
      }
      for (List<Integer> rows : byKey.values()) {
        if (rows.size() < 2) {
          continue; // a hash collision, not a duplicate
        }
        java.util.Collections.sort(rows);
        excess.addAll(rows.subList(1, rows.size()));
      }
      // Past the cap the run falls back to the in-memory engine whatever the exact figure is,
      // and finding it out costs a tuple recomputed per row for every remaining group. On a
      // config that misses the cap by two orders of magnitude — 1,618,803 rows against 20,000 —
      // the reference measured 6.79 s to finish counting against 0.08 s to stop here.
      if (excess.size() > stopAfter) {
        break;
      }
    }
    java.util.Collections.sort(excess);
    return excess;
  }

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
      List<List<String>> columns, Membership forbidden, int size, RepairReport report) {
    int k = columns.size();
    if (size == 0 || k == 0) {
      return new ArrayList<>(columns);
    }

    // Said BEFORE the first deal: Uniq.arrange below is itself seconds of work on a large pool,
    // and a watcher that only heard from the sweep loop would sit on a stale "uniq-sort"
    // throughout it. The phase NAME is the part that answers "what is it doing".
    report.step(size);
    List<List<String>> arranged = Uniq.arrange(columns).columns();
    List<List<String>> rows = new ArrayList<>(size);
    for (int i = 0; i < size; i++) {
      List<String> row = new ArrayList<>(k);
      for (List<String> column : arranged) {
        row.add(column.get(i));
      }
      rows.add(row);
    }

    int reportEvery = Math.max(1, size / 200);
    for (int sweep = 0; sweep < 32; sweep++) {
      // Each sweep is another `size` units taken on, so the scale grows with the work instead of
      // the counter restarting inside the phase.
      if (sweep > 0) {
        report.step(size);
      }
      Map<String, Integer> tally = new HashMap<>();
      for (List<String> row : rows) {
        tally.merge(keyOf(row), 1, Integer::sum);
      }
      boolean improved = false;

      for (int i = 0; i < size; i++) {
        if (i % reportEvery == 0) {
          report.at(i);
        }
        List<String> ri = rows.get(i);
        String keyI = keyOf(ri);
        if (tally.getOrDefault(keyI, 0) <= 1 && !forbidden.has(keyI)) {
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

  private static boolean isBad(Map<String, Integer> tally, Membership forbidden, String key) {
    return tally.getOrDefault(key, 0) > 1 || forbidden.has(key);
  }

  /** The verdict on {@code key} as it would stand after the two rows swapped. */
  private static boolean isBadAfter(
      Map<String, Integer> tally,
      Membership forbidden,
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
    return after > 1 || forbidden.has(key);
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
