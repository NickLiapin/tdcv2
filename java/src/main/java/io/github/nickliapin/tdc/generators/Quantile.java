package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.lib.Fixed;
import io.github.nickliapin.tdc.prng.Permute;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * A file read as a QUANTILE FUNCTION rather than as a bag of values.
 *
 * <p>{@code <gen type="file" src="amounts.txt" read="quantile"/>} — the file is one measurement
 * per line, the engine sorts it once, and a row lands anywhere on that sorted ruler, interpolating
 * between two neighbours when it falls between them.
 *
 * <p>Why this exists beside {@code weight=}: a weighted read honours declared shares exactly and
 * is the right answer for a countable value, but it can only ever emit values that were written in
 * the file. Stretch a thousand-line sample to a million rows and a thousand distinct values come
 * back with nothing between them — a comb, and for a MEASURED quantity that comb is structure the
 * real data never had.
 *
 * <p>Why it fits the engine: one uniform per row, and the answer depends on that row alone. So it
 * streams, it parallelises, and it needs no totals up front — unlike {@code weight=}, which is
 * in-memory precisely because an exact quota has to see the whole file first.
 */
public final class Quantile {

  private Quantile() {}

  /**
   * A source read as a quantile function.
   *
   * @param sorted the sample, ascending; duplicates are kept — they are what makes an atom
   * @param decimals the most decimal places any line used, so the answer is written like the source
   */
  public record Source(double[] sorted, int decimals) {}

  /**
   * Parse and sort the file's values.
   *
   * <p>A line that is not a number is refused rather than skipped: dropping it would change the
   * very shape the file was chosen for, and silently. The message names the line, because in a file
   * of ten thousand numbers "one of them is not a number" is not an answer anyone can act on.
   */
  public static Source read(List<String> values, String src) {
    if (values.isEmpty()) {
      throw new IllegalArgumentException(
          "file generator: read=\"quantile\" needs values, and \"" + src + "\" has none");
    }
    double[] sorted = new double[values.size()];
    int decimals = 0;
    for (int i = 0; i < values.size(); i++) {
      String text = values.get(i).trim();
      double parsed;
      try {
        parsed = text.isEmpty() ? Double.NaN : Double.parseDouble(text);
      } catch (NumberFormatException e) {
        throw notANumber(i, src, values.get(i));
      }
      if (Double.isNaN(parsed) || Double.isInfinite(parsed)) {
        throw notANumber(i, src, values.get(i));
      }
      sorted[i] = parsed;
      decimals = Math.max(decimals, decimalsOf(text));
    }
    Arrays.sort(sorted);
    return new Source(sorted, decimals);
  }

  private static IllegalArgumentException notANumber(int index, String src, String raw) {
    return new IllegalArgumentException(
        "file generator: read=\"quantile\" reads the file as measurements, and line "
            + (index + 1)
            + " of \""
            + src
            + "\" is \""
            + raw
            + "\", which is not a number. Every value has to be one, because the sorted sample IS"
            + " the distribution.");
  }

  /** How many digits this text wrote after the point — {@code 12.50} is two, {@code 12} is none. */
  private static int decimalsOf(String text) {
    int dot = text.indexOf('.');
    // An exponent would make the count meaningless, so such a value asks for nothing.
    if (dot < 0 || text.indexOf('e') >= 0 || text.indexOf('E') >= 0) {
      return 0;
    }
    return text.length() - dot - 1;
  }

  /**
   * The value at probability {@code u}, interpolating between neighbours.
   *
   * <p>Each observation sits at {@code (i + 0.5) / n} — the MIDDLE of the slice of probability it
   * owns — rather than at {@code i / (n - 1)}, which is where the ENDS of the sample would be. That
   * is not a detail of taste: the end convention gives the smallest and largest observations
   * exactly half the weight they should have, because there is nothing on the far side of them to
   * ramp from. Measured on the reference before it was fixed, over a hundred distinct values that
   * each owe 1.000%: first 0.505%, middle 1.010%, last 0.505%.
   *
   * <p>It is also the convention the ROW axis already uses, where row {@code i} reads
   * {@code (slot + 0.5) / count}. One rule on both axes.
   */
  public static double at(double[] sorted, double u) {
    int n = sorted.length;
    if (n == 1) {
      return sorted[0];
    }
    double p = Math.min(n - 1, Math.max(0.0, (u * n) - 0.5));
    int lo = (int) Math.floor(p);
    double low = sorted[lo];
    if (lo + 1 >= n) {
      return sorted[n - 1];
    }
    // A repeated value makes low == high, and the interpolation returns it unchanged — that is how
    // an atom keeps its plateau while everything around it stays continuous.
    return low + ((p - lo) * (sorted[lo + 1] - low));
  }

  /** The finished cell: written like the source unless the config said otherwise. */
  public static String render(double value, int decimals) {
    return Fixed.toFixed(value, decimals);
  }

  /**
   * The EXACT sweep: every row takes its own point on the ruler, no dice at all.
   *
   * <p>Row {@code i} is sent to slot {@code permute(i, count, key)} and reads probability
   * {@code (slot + 0.5) / count}. Over the whole run the slots are the numbers {@code 0 … count-1}
   * exactly once each, so the generated column reproduces the sample's distribution with no
   * sampling noise whatever.
   *
   * <p>The permutation is what keeps it usable: without it the column would come out sorted. It is
   * the same seekable, seeded permutation {@code uniq} and the exact {@code percent=} quota already
   * use, so a row still costs nothing to compute on its own.
   */
  public static String exactAt(Source source, int decimals, int count, int key, int position) {
    int slot = Permute.permute(position, count, key);
    return render(at(source.sorted(), (slot + 0.5) / count), decimals);
  }

  /** {@code read="quantile"}: the file is a distribution, not a bag of values. */
  public static boolean isQuantile(Map<String, String> attrs) {
    return "quantile".equals(attrs.getOrDefault("read", "").trim());
  }

  /** {@code sample="exact"}: cover the distribution evenly rather than draw from it. */
  public static boolean isExactSample(Map<String, String> attrs) {
    return "exact".equals(attrs.getOrDefault("sample", "").trim());
  }

  /**
   * {@code decimals=} when the config declared one, otherwise the source's own precision.
   *
   * <p>Interpolating between 31 and 40 gives 35.4, which is right for money and wrong for a count
   * of orders. Rather than guess, the answer is printed with the same number of decimal places as
   * the SOURCE.
   */
  public static int decimalsFor(Map<String, String> attrs, Source source) {
    String raw = attrs.getOrDefault("decimals", "").trim();
    if (raw.isEmpty()) {
      return source.decimals();
    }
    try {
      return Integer.parseInt(raw);
    } catch (NumberFormatException e) {
      return source.decimals();
    }
  }
}
