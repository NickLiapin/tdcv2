package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Seekable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * How the in-memory engine derives a column the way the streaming engine does.
 *
 * <p>The two engines were built on different ideas of randomness. Engine 1 threaded one PRNG
 * through every sequence in declaration order, so a column's values depended on how many draws the
 * columns before it had made; engines 2 and 3 derive each cell from {@code (seed, streamId, row)}
 * and are independent of one another. Two architectures, and no seed could ever make them agree.
 *
 * <p>This is engine 1 adopting the second scheme — the port of the reference's {@code
 * sequence/per-row.ts}, with the same names so the two can be read side by side. A column's
 * identity travels beside it as a {@link Stream}; absent, everything falls back to the sequential
 * PRNG, which is what an inline generator or a nested pack body wants.
 */
final class PerRow {

  /**
   * Generators whose value for a row depends on nothing but that row.
   *
   * <p>A generator is off this list when its column is a PLAN rather than a series of draws. {@code
   * text} is the clearest case: even an UNWEIGHTED list is spread evenly over the column and
   * permuted, never picked independently per row, so {@link #exactTextLayout} handles it instead.
   * The rest are conditional and checked in {@link #perRowBuildable}.
   */
  static final Set<String> PER_ROW_TYPES =
      Set.of("number", "regex", "symbol", "date", "template", "file", "advanced_regex");

  /**
   * Types the streaming engine builds INLINE — it reads the row's position rather than deriving a
   * value from the row — and whose {@code anomaly=}/{@code missing=} draws it therefore takes from
   * dedicated {@code #anom} and {@code #miss} streams instead of from the generator's own.
   */
  static final Set<String> INLINE_ANOMALY_TYPES =
      Set.of("text", "increment", "decrement", "timeseries", "pattern");

  private PerRow() {}

  /**
   * What a column's exact layout gave each row.
   *
   * <p>Kept so a child that filters on this column can be ordered the way the streaming engine
   * orders it: a child's position inside its parent's subset is its RANK in the parent's layout,
   * not its ordinal among the matching rows, and the two are different orders.
   */
  record ExactLayout(List<String> values, int[] counts, int[] cumHi, Map<Integer, Integer> slotByRow) {}

  /**
   * The column a build belongs to: the seed it derives from, its name on the wire, and — when it
   * does not cover every row — the ABSOLUTE row each drawn position belongs to.
   */
  record Stream(String seed, String id, List<Integer> rows, boolean oneRow) {

    /** A stream over a whole column — the ordinary case. */
    Stream(String seed, String id, List<Integer> rows) {
      this(seed, id, rows, false);
    }

    /** The same stream under a different name, keeping the row list. */
    Stream named(String other) {
      return new Stream(seed, other, rows, oneRow);
    }

    /**
     * The same stream, marked as ONE ROW of a bigger build — a pack generator's body, built for
     * a single row of the column that names it.
     */
    Stream forOneRow() {
      return new Stream(seed, id, rows, true);
    }

    /**
     * The absolute row a drawn position belongs to.
     *
     * <p>Index-dependent generators — counters, timeseries, a pattern stretched over the run — read
     * the POSITION for their value, and the streaming engine does the same. Their random draws are
     * keyed by the row instead, which is why the two numbers have to be told apart.
     */
    int rowAt(int position) {
      if (rows == null) {
        return position;
      }
      return position < rows.size() ? rows.get(position) : position;
    }
  }

  /** The absolute rows a mask lets through, in row order. */
  static List<Integer> rowsOf(boolean[] mask) {
    List<Integer> rows = new ArrayList<>();
    for (int i = 0; i < mask.length; i++) {
      if (mask[i]) {
        rows.add(i);
      }
    }
    return rows;
  }

  /**
   * Can this generator be built row by row?
   *
   * <p>A one-row build is refused, and only that: {@code oneRow} says we are ALREADY inside one,
   * not that this column happens to hold a single row. The test used to be {@code count <= 1},
   * which refused a genuine one-row column too — a run of {@code count="1"}, or a {@code <mix>}
   * case whose quota came to a single row. Those fell back to the threaded PRNG while the
   * streaming engines drew from the seekable stream, so one config produced two different
   * datasets depending on which engine ran it.
   *
   * <p>{@code weighted} and {@code wholeColumn} are decided by the caller, which is the only place
   * that can reach the pack registry without this class depending on it.
   */
  static boolean perRowBuildable(
      Config.Gen gen, int count, boolean weighted, boolean wholeColumn, boolean oneRow) {
    // `sample="exact"` on a quantile read is a PLAN too: every row takes its own point on the
    // sorted sample, and which point follows from a scatter over the whole column. Built a row at
    // a time it would see a count of one and hand every row the median.
    if ("exact".equals(gen.attrs().getOrDefault("sample", "").trim())) {
      return false;
    }
    if (count == 0 || oneRow || !PER_ROW_TYPES.contains(gen.type())) {
      return false;
    }
    Map<String, String> attrs = gen.attrs();

    // order="sequential" reads the position, never the randomness.
    if ("sequential".equals(attrs.get("order"))) {
      return false;
    }
    // A weighted file column and a pack that declares shares are both exact quotas over the whole
    // column: the streaming engine lays them out the way it lays out weighted text.
    if (attrs.containsKey("weight") || weighted || wholeColumn) {
      return false;
    }
    // `row=` links several columns to ONE row of a file. That choice belongs to the row as a
    // whole, not to any single column reading from it.
    String row = attrs.get("row");
    if (row != null && !row.trim().isEmpty()) {
      return false;
    }
    // `percent=` on ANY type, not just text: a number can apportion its LENGTH groups the same
    // exact way (length="2,10-12" percent="85,15").
    if (attrs.containsKey("percent")) {
      return false;
    }
    // `repeat=` apportions the LENGTHS exactly across the column. That plan is separate, and
    // taking this path would skip it.
    return !attrs.containsKey("repeat");
  }

  /**
   * A list of values laid out exactly, the way the streaming engine lays it out.
   *
   * <p>{@link Hamilton#countsPerValue} turns the shares into a whole number of slots per value;
   * {@link Permute#permute} scatters those slots over the rows with a key derived from the column's
   * name. Row i gets the value whose slot range contains {@code permute(i)}. Both halves are keyed
   * by {@code (seed, streamId)}, so the in-memory and the streaming engine land on the same
   * arrangement.
   *
   * <p>The layout is recorded in {@code layouts} for any child that filters on this column.
   */
  static List<String> exactTextLayout(
      List<String> values,
      double[] percents,
      int count,
      Stream stream,
      Map<String, ExactLayout> layouts) {
    int[] counts =
        Hamilton.countsPerValue(count, percents, Prng.create(stream.seed() + "|" + stream.id() + "|pct"));
    int key = Permute.key(stream.seed(), stream.id());

    int[] cumHi = new int[counts.length];
    int acc = 0;
    for (int i = 0; i < counts.length; i++) {
      acc += counts[i];
      cumHi[i] = acc;
    }

    List<String> out = new ArrayList<>(count);
    Map<Integer, Integer> slotByRow = new HashMap<>();
    for (int i = 0; i < count; i++) {
      int slot = Permute.permute(i, count, key);
      slotByRow.put(stream.rowAt(i), slot);

      // Binary search rather than a linear scan: a wide column (many values) would otherwise make
      // the render O(count x values).
      int lo = 0;
      int hi = cumHi.length - 1;
      while (lo < hi) {
        int mid = (lo + hi) / 2;
        if (slot < cumHi[mid]) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      out.add(lo < values.size() ? values.get(lo) : "");
    }

    if (layouts != null) {
      layouts.put(stream.id(), new ExactLayout(List.copyOf(values), counts, cumHi, slotByRow));
    }
    return out;
  }

  /**
   * The rows a sequence builds, in the order it builds them.
   *
   * <p>For an unparented column that is simply every row. For a child it is the rows the parent
   * selected, ordered by their RANK inside the parent's exact layout — which is not their row
   * order. The streaming engine hands a child that rank as its position, so a parented column would
   * otherwise arrange its own quota over a differently ordered subset and land every value on the
   * wrong row.
   *
   * <p>Falls back to row order when the parent kept no layout — a bare {@code parent="Name"} with
   * no value, or a parent the streaming engine would refuse as a parent anyway.
   */
  static List<Integer> orderedRows(String parent, boolean[] mask, Map<String, ExactLayout> layouts) {
    List<Integer> applicable = rowsOf(mask);
    if (parent == null) {
      return applicable;
    }
    int dot = parent.indexOf('.');
    if (dot < 0) {
      return applicable;
    }
    ExactLayout plan = layouts.get(parent.substring(0, dot));
    if (plan == null) {
      return applicable;
    }
    int vi = plan.values().indexOf(parent.substring(dot + 1));
    if (vi < 0) {
      return applicable;
    }

    int low = plan.cumHi()[vi] - plan.counts()[vi];
    Integer[] ordered = new Integer[applicable.size()];
    for (int row : applicable) {
      Integer slot = plan.slotByRow().get(row);
      if (slot == null) {
        return applicable;
      }
      int rank = slot - low;
      if (rank < 0 || rank >= ordered.length) {
        return applicable;
      }
      ordered[rank] = row;
    }
    for (Integer row : ordered) {
      if (row == null) {
        return applicable;
      }
    }
    return new ArrayList<>(Arrays.asList(ordered));
  }

  /** The uniform of {@code row} on one of the column's own purpose streams ({@code #anom}, {@code #miss}). */
  static double purposeDraw(Stream stream, String purpose, int row) {
    return Seekable.uniforms(stream.seed(), stream.id() + purpose, row, 1)[0];
  }

  /** The generator a single row draws from. */
  static Prng.Sfc32 rowGenerator(Stream stream, int row) {
    return Seekable.generator(stream.seed(), stream.id(), row);
  }

  /** The shares a {@code percent=} mask expands to, or equal shares when there is no mask. */
  static double[] sharesOf(String percent, int valueCount) {
    if (percent != null && !percent.isEmpty()) {
      try {
        return PercentMask.expand(percent, valueCount);
      } catch (RuntimeException ignored) {
        // A malformed mask is the run's problem, reported where it is parsed for real. Here it
        // only decides an arrangement, and equal shares are the honest fallback.
      }
    }
    double[] equal = new double[valueCount];
    Arrays.fill(equal, 100.0 / valueCount);
    return equal;
  }
}
