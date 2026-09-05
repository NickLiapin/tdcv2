package io.github.nickliapin.tdc.stats;

import io.github.nickliapin.tdc.prng.Prng;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="timeseries" .../>} — a value that depends on when it happened.
 *
 * <p>The layered model every real series is built from:
 *
 * <pre>{@code value(i) = base + trend·i + Σ amplitude·cos(2π·(i − peak)/period) + noise·e(i)}</pre>
 *
 * <p>A trend, one or more seasonal waves, and noise, with the row index as the clock. Sales,
 * sensor readings and traffic look like this. A uniform draw over the same range does not, and
 * anything that plots the column will show the difference immediately.
 *
 * <p>Like the counters, the value comes from the absolute row index rather than from the row
 * before it, so any row can be computed on its own.
 */
public final class Timeseries {

  /**
   * How many past rows the correlated noise remembers.
   *
   * <p>The textbook AR(1) is written {@code e(t) = φ·e(t−1) + z(t)} — a recurrence, which a
   * seekable engine cannot evaluate: row 900,000 would have to replay 900,000 rows. Written out,
   * that recurrence is a weighted sum of the past innovations, {@code Σ φ^k·z(t−k)}, and the
   * weights fall off geometrically — so this generator defines the noise as that sum over a FIXED
   * window and evaluates it directly. Both engines then run the same arithmetic in the same order
   * and cannot drift apart, and any row is computable on its own.
   */
  public static final int NOISE_WINDOW = 63;

  /** One seasonal wave: how long it is, how far it swings, and where it peaks. */
  public record Wave(
      double period,
      double amplitude,
      /**
       * Which row the wave peaks on, or null for the classic sine.
       *
       * <p>A plain {@code sin(2π·i/period)} crosses zero at row 0 and peaks a QUARTER PERIOD
       * later, so a year of daily rows peaks in early April — the one season nobody means by
       * "warmer in summer". {@code peak_at} names the ROW rather than a shift, because the row
       * is what the author knows: 182 of 365 is the first of July.
       */
      Double peakAt) {}

  public record Spec(
      double base,
      double trend,
      /**
       * The seasonal waves, in the order written. Empty means no seasonality.
       *
       * <p>A list rather than one wave because real series carry more than one season at a time:
       * shop takings rise on Saturdays AND in December, and a model given only the weekly wave
       * has nothing to find in the yearly one. The waves simply sum.
       */
      List<Wave> waves,
      /** Standard deviation of the noise; zero means no noise, and no draws. */
      double noiseSd,
      /**
       * How strongly one row's noise carries into the next, in (−1, 1).
       *
       * <p>Zero is the independent (white) noise this generator has always produced. Real
       * measurement error is rarely independent: a sensor reading high today tends to read high
       * tomorrow, and a model tested only against white noise has never met the case it will
       * actually fail on.
       */
      double noiseCorrelation,
      int decimals) {

    public boolean hasNoise() {
      return noiseSd != 0;
    }
  }

  /** Where the window's innovations come from: the innovation of row {@code row − k}. */
  @FunctionalInterface
  public interface Past {
    double at(int k);
  }

  /** How a row's own innovation is drawn — a hash on the streaming side, the prng on the other. */
  @FunctionalInterface
  public interface Draw {
    double at(int row);
  }

  private Timeseries() {}

  public static List<String> generate(Map<String, String> attrs, int count, Prng.Sfc32 prng) {
    Spec spec = parse(attrs);
    boolean noisy = spec.hasNoise();
    // The window's draws, kept in a ring: walking forward, 63 of the 64 terms were drawn for the
    // row before. It is a cache and nothing else — the sum is the same terms in the same order.
    Ring ring = new Ring();
    Draw draw =
        row ->
            standardNormal(Distribution.openUnit(prng.next()), Distribution.openUnit(prng.next()));
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      // Two uniforms per row when there is noise, none at all when there is not — the draw
      // budget has to be exactly this, or a column declared after this one shifts.
      final int here = i;
      double z = noisy ? correlatedNoise(spec, here, k -> ring.read(here, k, draw)) : 0;
      out.add(format(valueAt(spec, i, z), spec.decimals()));
    }
    return out;
  }

  public static Spec parse(Map<String, String> attrs) {
    List<Double> periods = numberList(attrs, "period");
    List<Double> amplitudes = numberList(attrs, "amplitude");
    List<Double> peaks = numberList(attrs, "peak_at");
    for (double period : periods) {
      if (period < 0) {
        throw new IllegalArgumentException("timeseries: \"period\" must be >= 0");
      }
    }
    // The three lists describe the same waves position by position, so a length that disagrees is
    // not a wave anybody can draw. The validator says this first and better; this is the backstop
    // for callers who build a gen through the library without validating.
    if (amplitudes.size() > 1 && amplitudes.size() != periods.size()) {
      throw new IllegalArgumentException(
          "timeseries: \"amplitude\" must have as many entries as \"period\"");
    }
    if (!peaks.isEmpty() && peaks.size() != periods.size()) {
      throw new IllegalArgumentException(
          "timeseries: \"peak_at\" must have as many entries as \"period\"");
    }
    List<Wave> waves = new ArrayList<>(periods.size());
    for (int k = 0; k < periods.size(); k++) {
      // One amplitude for many periods is the shorthand for waves of equal height; the far more
      // common case is one of each, which reads the same.
      double amplitude =
          amplitudes.isEmpty() ? 0 : amplitudes.get(amplitudes.size() == 1 ? 0 : k);
      waves.add(new Wave(periods.get(k), amplitude, peaks.isEmpty() ? null : peaks.get(k)));
    }

    double noiseSd = number(attrs, "noise", 0);
    if (noiseSd < 0) {
      throw new IllegalArgumentException("timeseries: \"noise\" must be >= 0");
    }
    double noiseCorrelation = number(attrs, "noise_correlation", 0);
    if (!(Math.abs(noiseCorrelation) < 1)) {
      throw new IllegalArgumentException(
          "timeseries: \"noise_correlation\" must be between -1 and 1");
    }

    String decimalsRaw = attrs.get("decimals");
    int decimals;
    if (decimalsRaw == null || decimalsRaw.isBlank()) {
      decimals = 0;
    } else {
      try {
        decimals = Integer.parseInt(decimalsRaw.trim());
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException("timeseries: \"decimals\" must be a non-negative integer");
      }
      if (decimals < 0) {
        throw new IllegalArgumentException("timeseries: \"decimals\" must be a non-negative integer");
      }
    }

    return new Spec(
        number(attrs, "base", 0), number(attrs, "trend", 0), waves, noiseSd, noiseCorrelation,
        decimals);
  }

  /**
   * The correlated noise at row {@code i}, from the innovations of rows {@code i − k}.
   *
   * <p>{@code past} hands back the innovation of row {@code i − k}; the caller decides where it
   * comes from, which is what lets a sequential walk keep a ring of 64 and a random access pay for
   * 64 lookups. The ARITHMETIC is the same either way — the same terms, added in the same order —
   * so the two engines cannot disagree.
   *
   * <p>The sum is divided by the length of its own weight vector, so <b>every row has the same
   * spread</b>. Without that the first rows of a column would be visibly quieter than the rest —
   * the window has fewer terms to add there — and a series that settles down after sixty rows is
   * an artefact of the method, not of anything the config asked for.
   */
  public static double correlatedNoise(Spec spec, int i, Past past) {
    if (spec.noiseCorrelation() == 0) {
      return past.at(0);
    }
    int reach = Math.min(i, NOISE_WINDOW);
    double sum = 0;
    double squares = 0;
    double weight = 1;
    for (int k = 0; k <= reach; k++) {
      sum += weight * past.at(k);
      squares += weight * weight;
      weight *= spec.noiseCorrelation();
    }
    return sum / Math.sqrt(squares);
  }

  /**
   * The window's innovations, kept so a forward walk draws each row once.
   *
   * <p>A cache and nothing else: the arithmetic never changes, so an engine that seeks and an
   * engine that walks produce one series. {@code draw} is asked only for rows the walk has
   * reached, in order, which is what lets the in-memory engine hand it a SEQUENTIAL generator —
   * on that path there is no row to seek to, and the ring is the only reason the window can be
   * read at all.
   */
  public static final class Ring {
    private final double[] slots = new double[NOISE_WINDOW + 1];
    /** The highest row in the ring; rows {@code have - NOISE_WINDOW .. have} are live. */
    private long have = -1;

    public double read(int row, int k, Draw draw) {
      int size = NOISE_WINDOW + 1;
      if (row > have) {
        // Forward by one on a sequential walk; a first touch deep into the column fills the whole
        // window at once, which is what a seeking engine wants.
        for (long r = Math.max(0, Math.max(row - (long) NOISE_WINDOW, have + 1)); r <= row; r++) {
          slots[(int) (r % size)] = draw.at((int) r);
        }
        have = row;
      }
      long want = row - (long) k;
      if (want < 0) {
        return 0; // before row zero there is nothing to remember
      }
      // A jump backwards past the window re-draws, which costs one hash and cannot give a
      // different number.
      return want > have - size ? slots[(int) (want % size)] : draw.at((int) want);
    }
  }

  /** A standard normal deviate by Box–Muller, from two uniforms in (0,1). */
  public static double standardNormal(double u1, double u2) {
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  public static double valueAt(Spec spec, int i, double e) {
    double v = spec.base() + spec.trend() * i;
    for (Wave wave : spec.waves()) {
      if (wave.period() <= 0 || wave.amplitude() == 0) {
        continue;
      }
      // One formula for both. `cos` peaks where its argument is zero, so the wave peaks exactly
      // on `peak`. The DEFAULT peak is a quarter period in, which is where a plain
      // `sin(2π·i/period)` already peaked — so a config without `peak_at` produces the same
      // bytes it always did, without a second branch saying so.
      double peak = wave.peakAt() == null ? wave.period() / 4 : wave.peakAt();
      v += wave.amplitude() * Math.cos(2 * Math.PI * (i - peak) / wave.period());
    }
    if (spec.noiseSd() != 0) {
      v += spec.noiseSd() * e;
    }
    return v;
  }

  /** A comma-separated list of numbers, or an empty list when the attribute is absent. */
  private static List<Double> numberList(Map<String, String> attrs, String key) {
    String raw = attrs.get(key);
    if (raw == null || raw.isBlank()) {
      return List.of();
    }
    List<Double> out = new ArrayList<>();
    for (String piece : raw.split(",", -1)) {
      try {
        double n = Double.parseDouble(piece.trim());
        if (!Double.isFinite(n)) {
          throw new NumberFormatException();
        }
        out.add(n);
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(
            "timeseries: \"" + key + "\" must be a number (got \"" + raw + "\")");
      }
    }
    return out;
  }

  private static String format(double v, int decimals) {
    return io.github.nickliapin.tdc.lib.Fixed.toFixed(v, decimals);
  }

  private static double number(Map<String, String> attrs, String key, double fallback) {
    String raw = attrs.get(key);
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    try {
      double n = Double.parseDouble(raw.trim());
      if (!Double.isFinite(n)) {
        throw new NumberFormatException();
      }
      return n;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "timeseries: \"" + key + "\" must be a number (got \"" + raw + "\")");
    }
  }
}
