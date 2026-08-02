package io.github.nickliapin.tdc.pattern;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a curve out of an SVG file.
 *
 * <p>Somebody draws the shape they want in whatever editor they already have, saves it, and
 * points a config at the file. That is a far shorter path than writing the coordinates out by
 * hand, and it is the reason the pattern generator accepts drawings at all.
 *
 * <p>Not an XML parser: a scan over the tags, tracking the transform stack. Only element names,
 * a handful of attributes and the nesting of {@code <g>} matter here, and every editor's output
 * differs in ways a strict parser would reject for reasons that have nothing to do with the
 * shape.
 *
 * <p>Every path command is flattened to points, including the arcs and the smooth-curve
 * shorthands. Skipping any of them would silently drop part of a drawing, which is worse than
 * refusing the file: the run would succeed and the data would be the wrong shape.
 */
public final class SvgPath {

  /** A 2×3 affine matrix, in SVG's own order. */
  record Matrix(double a, double b, double c, double d, double e, double f) {}

  private static final Matrix IDENTITY = new Matrix(1, 0, 0, 1, 0, 0);

  private static final Pattern TAG =
      Pattern.compile("<\\/?([A-Za-z][\\w:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)\\/?>");
  private static final Pattern TRANSFORM =
      Pattern.compile("(matrix|translate|scale|rotate|skewX|skewY)\\s*\\(([^)]*)\\)");
  private static final Pattern NUMBER = Pattern.compile("-?\\d*\\.?\\d+(?:[eE][+-]?\\d+)?");
  private static final Pattern TOKEN =
      Pattern.compile("[MmLlHhVvCcSsQqTtAaZz]|-?\\d*\\.?\\d+(?:[eE][+-]?\\d+)?");

  /** One curve found in the document, already in user space. */
  private record Curve(List<double[]> points, double width) {}

  private SvgPath() {}

  /**
   * The single widest curve in the drawing, as graph points.
   *
   * <p>Widest, because a drawing usually carries decoration — axes, a frame, a legend — and the
   * line somebody meant is the one that spans the picture.
   */
  public static List<double[]> graphPoints(String svg) {
    List<Curve> curves = collect(svg);
    if (curves.isEmpty()) {
      throw new IllegalArgumentException(
          "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from");
    }
    Curve best = curves.get(0);
    for (Curve c : curves) {
      if (c.width() > best.width()) {
        best = c;
      }
    }
    if (best.points().size() < 2 || best.width() <= 0) {
      throw new IllegalArgumentException(
          "pattern: the SVG curve has no horizontal extent to stretch over the cards");
    }
    return flip(best.points());
  }

  /** The top and bottom edges of everything drawn — a band. */
  public record Envelope(List<double[]> top, List<double[]> bottom) {}

  /**
   * Measure the drawing's highest and lowest point at each position.
   *
   * <p>Measured <b>at the drawn vertices</b> rather than on a uniform grid. A grid would replace
   * the drawing with a dense straight-line resampling and leave {@code interp="smooth"} nothing
   * to round off; between two consecutive vertices every shape is a straight segment anyway, so
   * the vertices carry the whole shape.
   */
  public static Envelope envelope(String svg, int samples) {
    List<Curve> curves = collect(svg);
    if (curves.isEmpty()) {
      throw new IllegalArgumentException(
          "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from");
    }
    List<List<double[]>> shapes = new ArrayList<>();
    for (Curve c : curves) {
      shapes.add(flip(c.points()));
    }

    double xMin = Double.POSITIVE_INFINITY;
    double xMax = Double.NEGATIVE_INFINITY;
    for (List<double[]> s : shapes) {
      for (double[] p : s) {
        xMin = Math.min(xMin, p[0]);
        xMax = Math.max(xMax, p[0]);
      }
    }
    if (!(xMax > xMin)) {
      throw new IllegalArgumentException(
          "pattern: the SVG curve has no horizontal extent to stretch over the cards");
    }

    Set<Double> seen = new LinkedHashSet<>();
    for (List<double[]> s : shapes) {
      for (double[] p : s) {
        seen.add(p[0]);
      }
    }
    List<Double> axis = new ArrayList<>(seen);
    axis.sort(null);
    if (axis.size() > samples) {
      // An absurdly dense input — a huge flattened path — keeps an even subset instead.
      double step = (double) axis.size() / samples;
      Set<Double> thinned = new LinkedHashSet<>();
      for (int i = 0; i < samples; i++) {
        thinned.add(axis.get((int) Math.floor(i * step)));
      }
      thinned.add(xMax);
      axis = new ArrayList<>(thinned);
      axis.sort(null);
    }

    List<double[]> top = new ArrayList<>();
    List<double[]> bottom = new ArrayList<>();
    for (double x : axis) {
      double lo = Double.POSITIVE_INFINITY;
      double hi = Double.NEGATIVE_INFINITY;
      for (List<double[]> s : shapes) {
        for (int k = 1; k < s.size(); k++) {
          double[] a = s.get(k - 1);
          double[] b = s.get(k);
          if (x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) {
            continue;
          }
          double dx = b[0] - a[0];
          // A vertical segment covers a whole span of values at this x.
          double[] ys = dx == 0 ? new double[] {a[1], b[1]} : new double[] {a[1] + (x - a[0]) / dx * (b[1] - a[1])};
          for (double y : ys) {
            lo = Math.min(lo, y);
            hi = Math.max(hi, y);
          }
        }
      }
      if (lo == Double.POSITIVE_INFINITY) {
        continue;
      }
      top.add(new double[] {x, hi});
      bottom.add(new double[] {x, lo});
    }
    if (top.size() < 2) {
      throw new IllegalArgumentException(
          "pattern: the SVG has too little geometry to read a curve from");
    }
    return new Envelope(top, bottom);
  }

  /** SVG grows downward and a graph grows upward, so the vertical axis flips once. */
  private static List<double[]> flip(List<double[]> points) {
    List<double[]> out = new ArrayList<>(points.size());
    for (double[] p : points) {
      out.add(new double[] {p[0], p[1] == 0 ? 0 : -p[1]});
    }
    return out;
  }

  // ── scanning ─────────────────────────────────────────────────────────────────────────────

  private static List<Curve> collect(String svg) {
    List<Curve> found = new ArrayList<>();
    List<Matrix> stack = new ArrayList<>();
    stack.add(IDENTITY);

    Matcher m = TAG.matcher(svg);
    while (m.find()) {
      String whole = m.group();
      String name = m.group(1).toLowerCase();
      boolean closing = whole.startsWith("</");
      boolean selfClosing = whole.endsWith("/>");
      Matrix top = stack.get(stack.size() - 1);

      if (closing) {
        if (("g".equals(name) || "svg".equals(name)) && stack.size() > 1) {
          stack.remove(stack.size() - 1);
        }
        continue;
      }

      String transform = attribute(whole, "transform");
      Matrix local = transform == null ? top : multiply(top, parseTransform(transform));

      if ("g".equals(name) || "svg".equals(name)) {
        if (!selfClosing) {
          stack.add(local);
        }
        continue;
      }

      List<double[]> raw = null;
      if ("path".equals(name)) {
        String d = attribute(whole, "d");
        if (d != null) {
          raw = flattenPath(d);
        }
      } else if ("polyline".equals(name) || "polygon".equals(name)) {
        String points = attribute(whole, "points");
        if (points != null) {
          raw = readPoints(points);
        }
      } else if ("line".equals(name)) {
        Double x1 = number(attribute(whole, "x1"));
        Double y1 = number(attribute(whole, "y1"));
        Double x2 = number(attribute(whole, "x2"));
        Double y2 = number(attribute(whole, "y2"));
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          raw = List.of(new double[] {x1, y1}, new double[] {x2, y2});
        }
      }
      if (raw == null || raw.size() < 2) {
        continue;
      }

      List<double[]> points = new ArrayList<>(raw.size());
      for (double[] p : raw) {
        points.add(apply(local, p));
      }
      double min = points.get(0)[0];
      double max = min;
      for (double[] p : points) {
        min = Math.min(min, p[0]);
        max = Math.max(max, p[0]);
      }
      found.add(new Curve(points, max - min));
    }
    return found;
  }

  private static String attribute(String tag, String name) {
    Matcher m = Pattern.compile("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", Pattern.CASE_INSENSITIVE).matcher(tag);
    if (m.find()) {
      return m.group(1);
    }
    m = Pattern.compile("\\b" + name + "\\s*=\\s*'([^']*)'", Pattern.CASE_INSENSITIVE).matcher(tag);
    return m.find() ? m.group(1) : null;
  }

  private static Double number(String raw) {
    if (raw == null) {
      return null;
    }
    try {
      double v = Double.parseDouble(raw.trim());
      return Double.isFinite(v) ? v : null;
    } catch (NumberFormatException e) {
      return null;
    }
  }

  private static List<double[]> readPoints(String raw) {
    List<Double> nums = new ArrayList<>();
    Matcher m = NUMBER.matcher(raw);
    while (m.find()) {
      nums.add(Double.parseDouble(m.group()));
    }
    List<double[]> out = new ArrayList<>();
    for (int k = 0; k + 1 < nums.size(); k += 2) {
      out.add(new double[] {nums.get(k), nums.get(k + 1)});
    }
    return out;
  }

  // ── transforms ───────────────────────────────────────────────────────────────────────────

  static Matrix multiply(Matrix m, Matrix n) {
    return new Matrix(
        m.a() * n.a() + m.c() * n.b(),
        m.b() * n.a() + m.d() * n.b(),
        m.a() * n.c() + m.c() * n.d(),
        m.b() * n.c() + m.d() * n.d(),
        m.a() * n.e() + m.c() * n.f() + m.e(),
        m.b() * n.e() + m.d() * n.f() + m.f());
  }

  static double[] apply(Matrix m, double[] p) {
    return new double[] {m.a() * p[0] + m.c() * p[1] + m.e(), m.b() * p[0] + m.d() * p[1] + m.f()};
  }

  static Matrix parseTransform(String raw) {
    Matrix m = IDENTITY;
    Matcher hit = TRANSFORM.matcher(raw);
    while (hit.find()) {
      List<Double> args = new ArrayList<>();
      for (String piece : hit.group(2).split("[\\s,]+")) {
        if (!piece.isEmpty()) {
          try {
            args.add(Double.parseDouble(piece));
          } catch (NumberFormatException ignored) {
            // A transform nobody can read contributes nothing rather than failing the file.
          }
        }
      }
      m = multiply(m, primitive(hit.group(1), args));
    }
    return m;
  }

  private static Matrix primitive(String name, List<Double> a) {
    return switch (name) {
      case "matrix" -> new Matrix(at(a, 0, 1), at(a, 1, 0), at(a, 2, 0), at(a, 3, 1), at(a, 4, 0), at(a, 5, 0));
      case "translate" -> new Matrix(1, 0, 0, 1, at(a, 0, 0), at(a, 1, 0));
      case "scale" -> {
        double sx = at(a, 0, 1);
        yield new Matrix(sx, 0, 0, at(a, 1, sx), 0, 0);
      }
      case "rotate" -> {
        double rad = Math.toRadians(at(a, 0, 0));
        Matrix rot = new Matrix(Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0);
        if (a.size() < 3) {
          yield rot;
        }
        double cx = at(a, 1, 0);
        double cy = at(a, 2, 0);
        yield multiply(multiply(new Matrix(1, 0, 0, 1, cx, cy), rot), new Matrix(1, 0, 0, 1, -cx, -cy));
      }
      case "skewX" -> new Matrix(1, 0, Math.tan(Math.toRadians(at(a, 0, 0))), 1, 0, 0);
      case "skewY" -> new Matrix(1, Math.tan(Math.toRadians(at(a, 0, 0))), 0, 1, 0, 0);
      default -> IDENTITY;
    };
  }

  private static double at(List<Double> a, int i, double fallback) {
    return i < a.size() ? a.get(i) : fallback;
  }

  // ── path data ────────────────────────────────────────────────────────────────────────────

  /** Every command of a {@code d=} attribute, flattened to points. */
  static List<double[]> flattenPath(String d) {
    List<String> tk = new ArrayList<>();
    Matcher m = TOKEN.matcher(d);
    while (m.find()) {
      tk.add(m.group());
    }

    List<double[]> pts = new ArrayList<>();
    int[] i = {0};
    double[] cur = {0, 0};
    double[] start = {0, 0};
    double[] prevCubic = null;
    double[] prevQuad = null;
    String cmd = "";

    while (i[0] < tk.size()) {
      String tok = tk.get(i[0]);
      if (!tok.matches(".*[A-Za-z].*")) {
        // A bare number repeats the previous command; after an M that means L, per the spec.
        if ("M".equals(cmd)) {
          cmd = "L";
        } else if ("m".equals(cmd)) {
          cmd = "l";
        }
      } else {
        cmd = tk.get(i[0]++);
      }
      boolean rel = cmd.equals(cmd.toLowerCase());
      double bx = rel ? cur[0] : 0;
      double by = rel ? cur[1] : 0;

      switch (cmd.toUpperCase()) {
        case "M" -> {
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          start = p;
          cur = p;
          pts.add(p);
          prevCubic = null;
          prevQuad = null;
        }
        case "L" -> {
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          cur = p;
          pts.add(p);
          prevCubic = null;
          prevQuad = null;
        }
        case "H" -> {
          double[] p = {bx + num(tk, i), cur[1]};
          cur = p;
          pts.add(p);
          prevCubic = null;
          prevQuad = null;
        }
        case "V" -> {
          double[] p = {cur[0], by + num(tk, i)};
          cur = p;
          pts.add(p);
          prevCubic = null;
          prevQuad = null;
        }
        case "C" -> {
          double[] c1 = {bx + num(tk, i), by + num(tk, i)};
          double[] c2 = {bx + num(tk, i), by + num(tk, i)};
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          pts.addAll(cubic(cur, c1, c2, p));
          cur = p;
          prevCubic = c2;
          prevQuad = null;
        }
        case "S" -> {
          double[] c1 =
              prevCubic == null
                  ? new double[] {cur[0], cur[1]}
                  : new double[] {2 * cur[0] - prevCubic[0], 2 * cur[1] - prevCubic[1]};
          double[] c2 = {bx + num(tk, i), by + num(tk, i)};
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          pts.addAll(cubic(cur, c1, c2, p));
          cur = p;
          prevCubic = c2;
          prevQuad = null;
        }
        case "Q" -> {
          double[] c = {bx + num(tk, i), by + num(tk, i)};
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          pts.addAll(quad(cur, c, p));
          cur = p;
          prevQuad = c;
          prevCubic = null;
        }
        case "T" -> {
          double[] c =
              prevQuad == null
                  ? new double[] {cur[0], cur[1]}
                  : new double[] {2 * cur[0] - prevQuad[0], 2 * cur[1] - prevQuad[1]};
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          pts.addAll(quad(cur, c, p));
          cur = p;
          prevQuad = c;
          prevCubic = null;
        }
        case "A" -> {
          double rx = num(tk, i);
          double ry = num(tk, i);
          double rot = num(tk, i);
          boolean large = num(tk, i) != 0;
          boolean sweep = num(tk, i) != 0;
          double[] p = {bx + num(tk, i), by + num(tk, i)};
          pts.addAll(arc(cur, rx, ry, rot, large, sweep, p));
          cur = p;
          prevCubic = null;
          prevQuad = null;
        }
        case "Z" -> {
          double[] p = {start[0], start[1]};
          cur = p;
          pts.add(p);
          prevCubic = null;
          prevQuad = null;
        }
        default -> i[0]++; // an unknown token — skip it rather than spin
      }
    }
    return pts;
  }

  private static double num(List<String> tk, int[] i) {
    if (i[0] >= tk.size()) {
      return 0;
    }
    try {
      return Double.parseDouble(tk.get(i[0]++));
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  /** Enough segments to look smooth without turning a short curve into a thousand points. */
  private static int segmentsFor(double[]... pts) {
    double len = 0;
    for (int i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return Math.min(64, Math.max(4, (int) Math.ceil(len / 3)));
  }

  private static List<double[]> cubic(double[] p0, double[] p1, double[] p2, double[] p3) {
    int n = segmentsFor(p0, p1, p2, p3);
    List<double[]> out = new ArrayList<>(n);
    for (int i = 1; i <= n; i++) {
      double t = (double) i / n;
      double s = 1 - t;
      out.add(
          new double[] {
            s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0],
            s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1]
          });
    }
    return out;
  }

  /** A quadratic is a cubic with lifted control points. */
  private static List<double[]> quad(double[] p0, double[] p1, double[] p2) {
    double[] c1 = {p0[0] + 2.0 / 3 * (p1[0] - p0[0]), p0[1] + 2.0 / 3 * (p1[1] - p0[1])};
    double[] c2 = {p2[0] + 2.0 / 3 * (p1[0] - p2[0]), p2[1] + 2.0 / 3 * (p1[1] - p2[1])};
    return cubic(p0, c1, c2, p2);
  }

  private static List<double[]> arc(
      double[] p0, double rx0, double ry0, double rotDeg, boolean largeArc, boolean sweep, double[] p1) {
    double rx = Math.abs(rx0);
    double ry = Math.abs(ry0);
    if (rx == 0 || ry == 0) {
      // Degenerate: the spec says treat it as a straight line.
      return List.of(p1);
    }
    double phi = Math.toRadians(rotDeg);
    double cosP = Math.cos(phi);
    double sinP = Math.sin(phi);
    double dx = (p0[0] - p1[0]) / 2;
    double dy = (p0[1] - p1[1]) / 2;
    double x1 = cosP * dx + sinP * dy;
    double y1 = -sinP * dx + cosP * dy;
    double lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if (lam > 1) {
      double k = Math.sqrt(lam);
      rx *= k;
      ry *= k;
    }
    double denom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    double numer = Math.max(0, rx * rx * ry * ry - denom);
    double coef = (largeArc == sweep ? -1 : 1) * Math.sqrt(denom == 0 ? 0 : numer / denom);
    double cx1 = coef * rx * y1 / ry;
    double cy1 = -coef * ry * x1 / rx;
    double cx = cosP * cx1 - sinP * cy1 + (p0[0] + p1[0]) / 2;
    double cy = sinP * cx1 + cosP * cy1 + (p0[1] + p1[1]) / 2;

    double theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    double delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && delta > 0) {
      delta -= 2 * Math.PI;
    }
    if (sweep && delta < 0) {
      delta += 2 * Math.PI;
    }

    int n = Math.min(64, Math.max(6, (int) Math.ceil(Math.abs(delta) / Math.PI * 24)));
    List<double[]> out = new ArrayList<>(n);
    for (int i = 1; i <= n; i++) {
      double t = theta + delta * i / n;
      double ex = rx * Math.cos(t);
      double ey = ry * Math.sin(t);
      out.add(new double[] {cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy});
    }
    return out;
  }

  private static double angle(double ux, double uy, double vx, double vy) {
    double dot = ux * vx + uy * vy;
    double len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    double a = Math.acos(Math.min(1, Math.max(-1, len == 0 ? 1 : dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  }
}
