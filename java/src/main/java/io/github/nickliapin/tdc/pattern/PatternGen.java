package io.github.nickliapin.tdc.pattern;

import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.stats.Distribution;
import io.github.nickliapin.tdc.lib.Fixed;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@code <gen type="pattern" .../>} — data shaped like a drawing.
 *
 * <p>Three ways to read one:
 *
 * <ul>
 *   <li>{@code points="0,0 5,9 10,2"} — a single line, read as a trajectory. Deterministic: no
 *       draw is taken at all, so the column is the same under every seed.
 *   <li>{@code upper=} with an optional {@code lower=} — a band. Each row is a random value
 *       between the two lines, one draw apiece.
 *   <li>{@code mode="density"} — the same drawing read as a distribution instead.
 * </ul>
 *
 * <p>{@code spread="N"} widens a single line into a tunnel of ±N without drawing its edges by
 * hand, which is the usual way to turn a clean trend into something that looks measured.
 *
 * <p>Like the counters, a signal's value comes from the absolute row index rather than from the
 * row before it.
 */
public final class PatternGen {

  private static final Pattern NUMBER =
      Pattern.compile("-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?");

  private enum Kind {
    SIGNAL,
    CORRIDOR,
    DENSITY
  }

  private final Kind kind;
  private final Curve curve;
  private final Curve lower;
  private final Curve upper;
  private final Density density;
  private final double spread;
  private final int decimals;

  private PatternGen(
      Kind kind, Curve curve, Curve lower, Curve upper, Density density, double spread, int decimals) {
    this.kind = kind;
    this.curve = curve;
    this.lower = lower;
    this.upper = upper;
    this.density = density;
    this.spread = spread;
    this.decimals = decimals;
  }

  public static List<String> generate(
      Map<String, String> attrs, int count, java.nio.file.Path baseDir, Prng.Sfc32 prng) {
    PatternGen gen = of(attrs, baseDir);
    boolean draws = gen.draws();
    List<String> out = new ArrayList<>(count);
    // The drawing is stretched over the run: row i reads it at i/(count-1), and one row covers
    // 1/(count-1) of its width.
    double denom = count > 1 ? count - 1 : 1;
    for (int i = 0; i < count; i++) {
      double u = draws ? Distribution.openUnit(prng.next()) : 0;
      out.add(gen.valueAt(i / denom, u, 1 / denom));
    }
    return out;
  }

  static PatternGen of(Map<String, String> attrs) {
    return of(attrs, null);
  }

  public static PatternGen of(Map<String, String> attrs, java.nio.file.Path baseDir) {
    return of(attrs, baseDir, java.util.List.of());
  }

  public static PatternGen of(
      Map<String, String> attrs, java.nio.file.Path baseDir, java.util.List<java.nio.file.Path> roots) {
    double spread = spread(attrs);
    int decimals = decimals(attrs);
    double[] yRange = yRange(attrs.get("y_range"));
    Curve.Interp interp = interp(attrs.get("interp"));

    PatternGen gen;
    String upperRaw = attrs.get("upper");
    if (upperRaw != null && !upperRaw.isBlank()) {
      List<double[]> upperPts = points(upperRaw);
      String lowerRaw = attrs.get("lower");
      List<double[]> lowerPts =
          lowerRaw != null && !lowerRaw.isBlank() ? points(lowerRaw) : null;
      gen = corridor(upperPts, lowerPts, yRange, decimals, interp, spread);
    } else {
      String pointsRaw = attrs.get("points");
      if (pointsRaw == null || pointsRaw.isBlank()) {
        String src = attrs.get("src");
        if (src == null || src.isBlank()) {
          throw new IllegalArgumentException(
              "pattern: needs \"points\"/\"src\", or \"upper\"[/\"lower\"]");
        }
        gen = fromFile(src.trim(), baseDir, roots, attrs, yRange, decimals, interp, spread);
      } else {
        Curve c = Curve.of(points(pointsRaw), yRange, decimals, null, interp);
        gen = new PatternGen(Kind.SIGNAL, c, null, null, null, spread, decimals);
      }
    }

    if (!"density".equals(mode(attrs.get("mode")))) {
      return gen;
    }
    if (spread > 0) {
      throw new IllegalArgumentException(
          "pattern: \"spread\" has no meaning with mode=\"density\" — the drawing itself sets the scatter");
    }
    // A band contributes its top edge: the outline is the distribution, whatever its floor does.
    Curve source = gen.kind == Kind.CORRIDOR ? gen.upper : gen.curve;
    return new PatternGen(Kind.DENSITY, null, null, null, Density.of(source), 0, decimals);
  }

  /**
   * A drawing on disk: a picture, or a vector file.
   *
   * <p>Both are measured the same way — highest and lowest ink at each position — so one stroke
   * gives an exact curve and two strokes, or a closed outline, give a band. A file may switch
   * between the two along its own length, and a sketch usually does.
   */
  private static PatternGen fromFile(
      String src,
      java.nio.file.Path baseDir,
      java.util.List<java.nio.file.Path> roots,
      Map<String, String> attrs,
      double[] yRange,
      int decimals,
      Curve.Interp interp,
      double spread) {
    // The same resolution a file source gets, so a drawing may live in a data folder too.
    java.nio.file.Path path =
        io.github.nickliapin.tdc.generators.FileGen.resolve(src, baseDir, roots);
    byte[] bytes;
    try {
      bytes = java.nio.file.Files.readAllBytes(path);
    } catch (java.io.IOException e) {
      throw new java.io.UncheckedIOException("pattern: cannot read \"" + src + "\"", e);
    }

    if (Png.isPng(bytes)) {
      Png.Image image = Png.decode(bytes);
      SvgPath.Envelope traced = Png.trace(image, inkThreshold(attrs));
      // The frame is the value scale: the picture's own height is what 0..max means.
      return fromEnvelope(
          traced, yRange, decimals, interp, spread, new double[] {0, image.height() - 1});
    }

    SvgPath.Envelope envelope =
        SvgPath.envelope(new String(bytes, java.nio.charset.StandardCharsets.UTF_8), 600);
    return fromEnvelope(envelope, yRange, decimals, interp, spread, null);
  }

  /** A traced envelope becomes a plain line when its two edges coincide, and a band otherwise. */
  private static PatternGen fromEnvelope(
      SvgPath.Envelope envelope,
      double[] yRange,
      int decimals,
      Curve.Interp interp,
      double spread,
      double[] normExtent) {
    List<double[]> top = envelope.top();
    List<double[]> bottom = envelope.bottom();

    boolean banded = false;
    int n = Math.min(top.size(), bottom.size());
    for (int i = 0; i < n; i++) {
      if (Math.abs(top.get(i)[1] - bottom.get(i)[1]) > 1e-9) {
        banded = true;
        break;
      }
    }
    if (!banded) {
      return new PatternGen(
          Kind.SIGNAL, Curve.of(top, yRange, decimals, normExtent, interp), null, null, null,
          spread, decimals);
    }

    double lo = Double.POSITIVE_INFINITY;
    double hi = Double.NEGATIVE_INFINITY;
    for (double[] p : top) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
    for (double[] p : bottom) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
    double[] extent = normExtent != null ? normExtent : new double[] {lo, hi};
    return new PatternGen(
        Kind.CORRIDOR, null,
        Curve.of(bottom, yRange, decimals, extent, interp),
        Curve.of(top, yRange, decimals, extent, interp),
        null, spread, decimals);
  }

  /** {@code ink_threshold} — how dark counts as a line, on an opaque background. */
  private static double inkThreshold(Map<String, String> attrs) {
    String raw = attrs.get("ink_threshold");
    if (raw == null || raw.isBlank()) {
      return 0.5;
    }
    try {
      double t = Double.parseDouble(raw.trim());
      if (!Double.isFinite(t) || t <= 0 || t >= 1) {
        throw new NumberFormatException();
      }
      return t;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "pattern: \"ink_threshold\" must be a number strictly between 0 and 1");
    }
  }

  /**
   * A corridor: two lines in one value space.
   *
   * <p>Both are normalized against their <em>shared</em> height extent, so the band between them
   * means something. Normalizing each against its own extent would stretch them to the same
   * height and collapse the corridor.
   */
  private static PatternGen corridor(
      List<double[]> upperPts,
      List<double[]> lowerPts,
      double[] yRange,
      int decimals,
      Curve.Interp interp,
      double spread) {
    List<Double> heights = new ArrayList<>();
    for (double[] p : upperPts) {
      heights.add(p[1]);
    }
    if (lowerPts != null) {
      for (double[] p : lowerPts) {
        heights.add(p[1]);
      }
    } else {
      // No lower line means a flat floor at zero, which belongs in the shared extent.
      heights.add(0.0);
    }
    double lo = heights.stream().mapToDouble(Double::doubleValue).min().orElse(0);
    double hi = heights.stream().mapToDouble(Double::doubleValue).max().orElse(0);
    double[] extent = {lo, hi};

    Curve upper = Curve.of(upperPts, yRange, decimals, extent, interp);
    Curve lower;
    if (lowerPts != null) {
      lower = Curve.of(lowerPts, yRange, decimals, extent, interp);
    } else {
      double x0 = upperPts.get(0)[0];
      double xN = upperPts.get(upperPts.size() - 1)[0];
      lower = Curve.of(List.of(new double[] {x0, lo}, new double[] {xN, lo}), yRange, decimals, extent, interp);
    }
    return new PatternGen(Kind.CORRIDOR, null, lower, upper, null, spread, decimals);
  }

  /** Whether a row costs a draw: a band, a spread, or a density. A bare line costs none. */
  public boolean draws() {
    return kind != Kind.SIGNAL || spread > 0;
  }

  public String valueAt(double t, double u, double dt) {
    if (kind == Kind.DENSITY) {
      // Position in the run means nothing here — the drawing is a distribution, so the row's
      // own draw picks the value and the order comes out random.
      return format(density.valueAt(u), density.decimals());
    }
    if (kind == Kind.SIGNAL) {
      double v = curve.valueAt(t, dt);
      return format(spread > 0 ? v + (2 * u - 1) * spread : v, decimals);
    }
    double a = lower.valueAt(t, dt);
    double b = upper.valueAt(t, dt);
    double lo = Math.min(a, b) - spread;
    double hi = Math.max(a, b) + spread;
    return format(lo + u * (hi - lo), decimals);
  }

  // ── attributes ───────────────────────────────────────────────────────────────────────────

  /** Every number in the text, in pairs. Whatever separates them is decoration. */
  static List<double[]> points(String raw) {
    Matcher m = NUMBER.matcher(raw);
    List<Double> nums = new ArrayList<>();
    while (m.find()) {
      nums.add(Double.parseDouble(m.group()));
    }
    if (nums.isEmpty() || nums.size() % 2 != 0) {
      throw new IllegalArgumentException(
          "pattern: points must be an even list of \"x,y\" coordinates (got "
              + nums.size()
              + " numbers)");
    }
    List<double[]> points = new ArrayList<>(nums.size() / 2);
    for (int i = 0; i < nums.size(); i += 2) {
      points.add(new double[] {nums.get(i), nums.get(i + 1)});
    }
    return points;
  }

  static double[] yRange(String raw) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    String[] parts = raw.split("\\.\\.", -1);
    if (parts.length != 2) {
      throw new IllegalArgumentException(
          "pattern: y_range \"" + raw + "\" must be \"min..max\" with two numbers");
    }
    try {
      double a = Double.parseDouble(parts[0].trim());
      double b = Double.parseDouble(parts[1].trim());
      if (!Double.isFinite(a) || !Double.isFinite(b)) {
        throw new NumberFormatException();
      }
      return new double[] {a, b};
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "pattern: y_range \"" + raw + "\" must be \"min..max\" with two numbers");
    }
  }

  public static Curve.Interp interp(String raw) {
    if (raw == null || raw.isBlank()) {
      return Curve.Interp.LINEAR;
    }
    return switch (raw.trim().toLowerCase()) {
      case "linear" -> Curve.Interp.LINEAR;
      case "smooth" -> Curve.Interp.SMOOTH;
      case "step" -> Curve.Interp.STEP;
      default -> throw new IllegalArgumentException(
          "pattern: \"interp\" must be \"linear\", \"smooth\" or \"step\"");
    };
  }

  public static String mode(String raw) {
    if (raw == null || raw.isBlank()) {
      return "signal";
    }
    String v = raw.trim().toLowerCase();
    if (!"signal".equals(v) && !"density".equals(v)) {
      throw new IllegalArgumentException(
          "pattern: \"mode\" must be \"signal\" (a trajectory) or \"density\" (a distribution)");
    }
    return v;
  }

  public static double spread(Map<String, String> attrs) {
    String raw = attrs.get("spread");
    if (raw == null || raw.isBlank()) {
      return 0;
    }
    try {
      double s = Double.parseDouble(raw.trim());
      if (!Double.isFinite(s) || s < 0) {
        throw new NumberFormatException();
      }
      return s;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException("pattern: \"spread\" must be a non-negative number");
    }
  }

  public static int decimals(Map<String, String> attrs) {
    String raw = attrs.get("decimals");
    if (raw == null || raw.isBlank()) {
      return 0;
    }
    try {
      int d = Integer.parseInt(raw.trim());
      if (d < 0) {
        throw new NumberFormatException();
      }
      return d;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException("pattern: \"decimals\" must be a non-negative integer");
    }
  }

  private static String format(double v, int decimals) {
    return Fixed.toFixed(v, decimals);
  }
}
