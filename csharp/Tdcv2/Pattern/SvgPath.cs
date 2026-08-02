using System.Globalization;
using System.Text.RegularExpressions;

namespace Tdcv2.Pattern;

/// <summary>
/// Reads a curve out of an SVG file.
/// </summary>
/// <remarks>
/// <para>
/// Somebody draws the shape they want in whatever editor they already have, saves it, and points a
/// config at the file. That is a far shorter path than writing the coordinates out by hand, and it
/// is the reason the pattern generator accepts drawings at all.
/// </para>
/// <para>
/// Not an XML parser: a scan over the tags, tracking the transform stack. Only element names, a
/// handful of attributes and the nesting of <c>&lt;g&gt;</c> matter here, and every editor's output
/// differs in ways a strict parser would reject for reasons that have nothing to do with the shape.
/// </para>
/// <para>
/// Every path command is flattened to points, including the arcs and the smooth-curve shorthands.
/// Skipping any of them would silently drop part of a drawing, which is worse than refusing the
/// file: the run would succeed and the data would be the wrong shape.
/// </para>
/// </remarks>
public static class SvgPath
{
    // Digits are spelled [0-9] rather than \d: .NET's \d matches every Unicode digit, and a number
    // this reader accepted but double.Parse refused would turn one stray glyph into a broken file.
    private const string NumberPattern = @"-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?";

    private static readonly Regex Tag =
        new(@"</?([A-Za-z][A-Za-z0-9_:-]*)((?:[^>""']|""[^""]*""|'[^']*')*)/?>", RegexOptions.Compiled);

    private static readonly Regex Transform =
        new(@"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)", RegexOptions.Compiled);

    private static readonly Regex Number = new(NumberPattern, RegexOptions.Compiled);

    private static readonly Regex Token =
        new(@"[MmLlHhVvCcSsQqTtAaZz]|" + NumberPattern, RegexOptions.Compiled);

    private static readonly Regex Separator = new(@"[\s,]+", RegexOptions.Compiled);

    /// <summary>A 2×3 affine matrix, in SVG's own order.</summary>
    private readonly record struct Matrix(double A, double B, double C, double D, double E, double F);

    private static readonly Matrix Identity = new(1, 0, 0, 1, 0, 0);

    /// <summary>The top and bottom edges of everything drawn — a band.</summary>
    public sealed record Envelope(IReadOnlyList<double[]> Top, IReadOnlyList<double[]> Bottom);

    /// <summary>
    /// Measure the drawing's highest and lowest point at each position.
    /// </summary>
    /// <remarks>
    /// Measured <b>at the drawn vertices</b> rather than on a uniform grid. A grid would replace the
    /// drawing with a dense straight-line resampling and leave <c>interp="smooth"</c> nothing to
    /// round off; between two consecutive vertices every shape is a straight segment anyway, so the
    /// vertices carry the whole shape.
    /// </remarks>
    public static Envelope GetEnvelope(string svg, int samples)
    {
        IReadOnlyList<List<double[]>> curves = Collect(svg);
        if (curves.Count == 0)
        {
            throw new ArgumentException(
                "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from");
        }

        var shapes = new List<List<double[]>>(curves.Count);
        foreach (List<double[]> c in curves)
        {
            shapes.Add(Flip(c));
        }

        double xMin = double.PositiveInfinity;
        double xMax = double.NegativeInfinity;
        foreach (List<double[]> s in shapes)
        {
            foreach (double[] p in s)
            {
                xMin = Math.Min(xMin, p[0]);
                xMax = Math.Max(xMax, p[0]);
            }
        }

        if (!(xMax > xMin))
        {
            throw new ArgumentException(
                "pattern: the SVG curve has no horizontal extent to stretch over the cards");
        }

        var seen = new List<double>();
        var known = new HashSet<double>();
        foreach (List<double[]> s in shapes)
        {
            foreach (double[] p in s)
            {
                if (known.Add(p[0]))
                {
                    seen.Add(p[0]);
                }
            }
        }

        seen.Sort();
        List<double> axis = seen;
        if (axis.Count > samples)
        {
            // An absurdly dense input — a huge flattened path — keeps an even subset instead.
            double step = (double)axis.Count / samples;
            var thinned = new HashSet<double>();
            for (int i = 0; i < samples; i++)
            {
                thinned.Add(axis[(int)Math.Floor(i * step)]);
            }

            thinned.Add(xMax);
            axis = thinned.ToList();
            axis.Sort();
        }

        var top = new List<double[]>();
        var bottom = new List<double[]>();
        foreach (double x in axis)
        {
            double lo = double.PositiveInfinity;
            double hi = double.NegativeInfinity;
            foreach (List<double[]> s in shapes)
            {
                for (int k = 1; k < s.Count; k++)
                {
                    double[] a = s[k - 1];
                    double[] b = s[k];
                    if (x < Math.Min(a[0], b[0]) || x > Math.Max(a[0], b[0]))
                    {
                        continue;
                    }

                    double dx = b[0] - a[0];
                    if (dx == 0)
                    {
                        // A vertical segment covers a whole span of values at this x.
                        lo = Math.Min(lo, Math.Min(a[1], b[1]));
                        hi = Math.Max(hi, Math.Max(a[1], b[1]));
                    }
                    else
                    {
                        double y = a[1] + ((x - a[0]) / dx * (b[1] - a[1]));
                        lo = Math.Min(lo, y);
                        hi = Math.Max(hi, y);
                    }
                }
            }

            if (double.IsPositiveInfinity(lo))
            {
                continue;
            }

            top.Add(new[] { x, hi });
            bottom.Add(new[] { x, lo });
        }

        if (top.Count < 2)
        {
            throw new ArgumentException(
                "pattern: the SVG has too little geometry to read a curve from");
        }

        return new Envelope(top, bottom);
    }

    /// <summary>SVG grows downward and a graph grows upward, so the vertical axis flips once.</summary>
    private static List<double[]> Flip(IReadOnlyList<double[]> points)
    {
        var output = new List<double[]>(points.Count);
        foreach (double[] p in points)
        {
            output.Add(new[] { p[0], p[1] == 0 ? 0 : -p[1] });
        }

        return output;
    }

    // ── scanning ─────────────────────────────────────────────────────────────────────────────

    private static List<List<double[]>> Collect(string svg)
    {
        var found = new List<List<double[]>>();
        var stack = new List<Matrix> { Identity };

        foreach (Match m in Tag.Matches(svg))
        {
            string whole = m.Value;
            string name = m.Groups[1].Value.ToLowerInvariant();
            bool closing = whole.StartsWith("</", StringComparison.Ordinal);
            bool selfClosing = whole.EndsWith("/>", StringComparison.Ordinal);
            Matrix top = stack[^1];

            if (closing)
            {
                if ((name == "g" || name == "svg") && stack.Count > 1)
                {
                    stack.RemoveAt(stack.Count - 1);
                }

                continue;
            }

            string? transform = Attribute(whole, "transform");
            Matrix local = transform is null ? top : Multiply(top, ParseTransform(transform));

            if (name == "g" || name == "svg")
            {
                if (!selfClosing)
                {
                    stack.Add(local);
                }

                continue;
            }

            List<double[]>? raw = null;
            if (name == "path")
            {
                string? d = Attribute(whole, "d");
                if (d is not null)
                {
                    raw = FlattenPath(d);
                }
            }
            else if (name == "polyline" || name == "polygon")
            {
                string? points = Attribute(whole, "points");
                if (points is not null)
                {
                    raw = ReadPoints(points);
                }
            }
            else if (name == "line")
            {
                double? x1 = ParseNumber(Attribute(whole, "x1"));
                double? y1 = ParseNumber(Attribute(whole, "y1"));
                double? x2 = ParseNumber(Attribute(whole, "x2"));
                double? y2 = ParseNumber(Attribute(whole, "y2"));
                if (x1 is not null && y1 is not null && x2 is not null && y2 is not null)
                {
                    raw = new List<double[]>
                    {
                        new[] { x1.Value, y1.Value },
                        new[] { x2.Value, y2.Value },
                    };
                }
            }

            if (raw is null || raw.Count < 2)
            {
                continue;
            }

            var points2 = new List<double[]>(raw.Count);
            foreach (double[] p in raw)
            {
                points2.Add(Apply(local, p));
            }

            found.Add(points2);
        }

        return found;
    }

    private static string? Attribute(string tag, string name)
    {
        Match m = Regex.Match(
            tag, @"\b" + name + @"\s*=\s*""([^""]*)""", RegexOptions.IgnoreCase);
        if (m.Success)
        {
            return m.Groups[1].Value;
        }

        m = Regex.Match(tag, @"\b" + name + @"\s*=\s*'([^']*)'", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value : null;
    }

    private static double? ParseNumber(string? raw)
    {
        if (raw is null)
        {
            return null;
        }

        return double.TryParse(
            raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
            && double.IsFinite(v)
            ? v
            : null;
    }

    private static List<double[]> ReadPoints(string raw)
    {
        var nums = new List<double>();
        foreach (Match m in Number.Matches(raw))
        {
            nums.Add(double.Parse(m.Value, CultureInfo.InvariantCulture));
        }

        var output = new List<double[]>();
        for (int k = 0; k + 1 < nums.Count; k += 2)
        {
            output.Add(new[] { nums[k], nums[k + 1] });
        }

        return output;
    }

    // ── transforms ───────────────────────────────────────────────────────────────────────────

    private static Matrix Multiply(Matrix m, Matrix n) => new(
        (m.A * n.A) + (m.C * n.B),
        (m.B * n.A) + (m.D * n.B),
        (m.A * n.C) + (m.C * n.D),
        (m.B * n.C) + (m.D * n.D),
        (m.A * n.E) + (m.C * n.F) + m.E,
        (m.B * n.E) + (m.D * n.F) + m.F);

    private static double[] Apply(Matrix m, double[] p) => new[]
    {
        (m.A * p[0]) + (m.C * p[1]) + m.E,
        (m.B * p[0]) + (m.D * p[1]) + m.F,
    };

    private static Matrix ParseTransform(string raw)
    {
        Matrix m = Identity;
        foreach (Match hit in Transform.Matches(raw))
        {
            var args = new List<double>();
            foreach (string piece in Separator.Split(hit.Groups[2].Value))
            {
                if (piece.Length == 0)
                {
                    continue;
                }

                // A transform nobody can read contributes nothing rather than failing the file.
                if (double.TryParse(
                        piece, NumberStyles.Float, CultureInfo.InvariantCulture, out double v))
                {
                    args.Add(v);
                }
            }

            m = Multiply(m, Primitive(hit.Groups[1].Value, args));
        }

        return m;
    }

    private static Matrix Primitive(string name, IReadOnlyList<double> a)
    {
        switch (name)
        {
            case "matrix":
                return new Matrix(At(a, 0, 1), At(a, 1, 0), At(a, 2, 0), At(a, 3, 1), At(a, 4, 0), At(a, 5, 0));
            case "translate":
                return new Matrix(1, 0, 0, 1, At(a, 0, 0), At(a, 1, 0));
            case "scale":
            {
                double sx = At(a, 0, 1);
                return new Matrix(sx, 0, 0, At(a, 1, sx), 0, 0);
            }

            case "rotate":
            {
                double rad = At(a, 0, 0) * Math.PI / 180;
                var rot = new Matrix(Math.Cos(rad), Math.Sin(rad), -Math.Sin(rad), Math.Cos(rad), 0, 0);
                if (a.Count < 3)
                {
                    return rot;
                }

                double cx = At(a, 1, 0);
                double cy = At(a, 2, 0);
                return Multiply(
                    Multiply(new Matrix(1, 0, 0, 1, cx, cy), rot),
                    new Matrix(1, 0, 0, 1, -cx, -cy));
            }

            case "skewX":
                return new Matrix(1, 0, Math.Tan(At(a, 0, 0) * Math.PI / 180), 1, 0, 0);
            case "skewY":
                return new Matrix(1, Math.Tan(At(a, 0, 0) * Math.PI / 180), 0, 1, 0, 0);
            default:
                return Identity;
        }
    }

    private static double At(IReadOnlyList<double> a, int i, double fallback) =>
        i < a.Count ? a[i] : fallback;

    // ── path data ────────────────────────────────────────────────────────────────────────────

    /// <summary>Every command of a <c>d=</c> attribute, flattened to points.</summary>
    public static List<double[]> FlattenPath(string d)
    {
        var tk = new List<string>();
        foreach (Match m in Token.Matches(d))
        {
            tk.Add(m.Value);
        }

        var pts = new List<double[]>();
        int i = 0;
        double[] cur = { 0, 0 };
        double[] start = { 0, 0 };
        double[]? prevCubic = null;
        double[]? prevQuad = null;
        string cmd = string.Empty;

        while (i < tk.Count)
        {
            string tok = tk[i];
            if (!HasLetter(tok))
            {
                // A bare number repeats the previous command; after an M that means L, per the spec.
                if (cmd == "M")
                {
                    cmd = "L";
                }
                else if (cmd == "m")
                {
                    cmd = "l";
                }
            }
            else
            {
                cmd = tk[i++];
            }

            bool rel = cmd == cmd.ToLowerInvariant();
            double bx = rel ? cur[0] : 0;
            double by = rel ? cur[1] : 0;

            switch (cmd.ToUpperInvariant())
            {
                case "M":
                {
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    start = p;
                    cur = p;
                    pts.Add(p);
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                case "L":
                {
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    cur = p;
                    pts.Add(p);
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                case "H":
                {
                    double[] p = { bx + Num(tk, ref i), cur[1] };
                    cur = p;
                    pts.Add(p);
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                case "V":
                {
                    double[] p = { cur[0], by + Num(tk, ref i) };
                    cur = p;
                    pts.Add(p);
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                case "C":
                {
                    double[] c1 = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    double[] c2 = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    pts.AddRange(Cubic(cur, c1, c2, p));
                    cur = p;
                    prevCubic = c2;
                    prevQuad = null;
                    break;
                }

                case "S":
                {
                    double[] c1 = Reflect(cur, prevCubic);
                    double[] c2 = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    pts.AddRange(Cubic(cur, c1, c2, p));
                    cur = p;
                    prevCubic = c2;
                    prevQuad = null;
                    break;
                }

                case "Q":
                {
                    double[] c = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    pts.AddRange(Quad(cur, c, p));
                    cur = p;
                    prevQuad = c;
                    prevCubic = null;
                    break;
                }

                case "T":
                {
                    double[] c = Reflect(cur, prevQuad);
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    pts.AddRange(Quad(cur, c, p));
                    cur = p;
                    prevQuad = c;
                    prevCubic = null;
                    break;
                }

                case "A":
                {
                    double rx = Num(tk, ref i);
                    double ry = Num(tk, ref i);
                    double rot = Num(tk, ref i);
                    bool large = Num(tk, ref i) != 0;
                    bool sweep = Num(tk, ref i) != 0;
                    double[] p = { bx + Num(tk, ref i), by + Num(tk, ref i) };
                    pts.AddRange(Arc(cur, rx, ry, rot, large, sweep, p));
                    cur = p;
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                case "Z":
                {
                    double[] p = { start[0], start[1] };
                    cur = p;
                    pts.Add(p);
                    prevCubic = null;
                    prevQuad = null;
                    break;
                }

                default:
                    i++; // an unknown token — skip it rather than spin
                    break;
            }
        }

        return pts;
    }

    /// <summary>
    /// The control point mirrored through the current point, or the current point itself when the
    /// previous command was not of the same family.
    /// </summary>
    private static double[] Reflect(double[] cur, double[]? prev) => prev is null
        ? new[] { cur[0], cur[1] }
        : new[] { (2 * cur[0]) - prev[0], (2 * cur[1]) - prev[1] };

    private static bool HasLetter(string token)
    {
        foreach (char c in token)
        {
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
            {
                return true;
            }
        }

        return false;
    }

    private static double Num(IReadOnlyList<string> tk, ref int i)
    {
        if (i >= tk.Count)
        {
            return 0;
        }

        string text = tk[i++];
        return double.TryParse(
            text, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) ? v : 0;
    }

    /// <summary>
    /// Enough segments to look smooth without turning a short curve into a thousand points.
    /// </summary>
    private static int SegmentsFor(params double[][] pts)
    {
        double len = 0;
        for (int i = 1; i < pts.Length; i++)
        {
            len += Math.Sqrt(
                ((pts[i][0] - pts[i - 1][0]) * (pts[i][0] - pts[i - 1][0]))
                + ((pts[i][1] - pts[i - 1][1]) * (pts[i][1] - pts[i - 1][1])));
        }

        return Math.Min(64, Math.Max(4, (int)Math.Ceiling(len / 3)));
    }

    private static List<double[]> Cubic(double[] p0, double[] p1, double[] p2, double[] p3)
    {
        int n = SegmentsFor(p0, p1, p2, p3);
        var output = new List<double[]>(n);
        for (int i = 1; i <= n; i++)
        {
            double t = (double)i / n;
            double s = 1 - t;
            output.Add(new[]
            {
                (s * s * s * p0[0]) + (3 * s * s * t * p1[0]) + (3 * s * t * t * p2[0])
                    + (t * t * t * p3[0]),
                (s * s * s * p0[1]) + (3 * s * s * t * p1[1]) + (3 * s * t * t * p2[1])
                    + (t * t * t * p3[1]),
            });
        }

        return output;
    }

    /// <summary>A quadratic is a cubic with lifted control points.</summary>
    private static List<double[]> Quad(double[] p0, double[] p1, double[] p2)
    {
        double[] c1 = { p0[0] + (2.0 / 3 * (p1[0] - p0[0])), p0[1] + (2.0 / 3 * (p1[1] - p0[1])) };
        double[] c2 = { p2[0] + (2.0 / 3 * (p1[0] - p2[0])), p2[1] + (2.0 / 3 * (p1[1] - p2[1])) };
        return Cubic(p0, c1, c2, p2);
    }

    private static List<double[]> Arc(
        double[] p0, double rx0, double ry0, double rotDeg, bool largeArc, bool sweep, double[] p1)
    {
        double rx = Math.Abs(rx0);
        double ry = Math.Abs(ry0);
        if (rx == 0 || ry == 0)
        {
            // Degenerate: the spec says treat it as a straight line.
            return new List<double[]> { p1 };
        }

        double phi = rotDeg * Math.PI / 180;
        double cosP = Math.Cos(phi);
        double sinP = Math.Sin(phi);
        double dx = (p0[0] - p1[0]) / 2;
        double dy = (p0[1] - p1[1]) / 2;
        double x1 = (cosP * dx) + (sinP * dy);
        double y1 = (-sinP * dx) + (cosP * dy);
        double lam = (x1 * x1 / (rx * rx)) + (y1 * y1 / (ry * ry));
        if (lam > 1)
        {
            double k = Math.Sqrt(lam);
            rx *= k;
            ry *= k;
        }

        double denom = (rx * rx * y1 * y1) + (ry * ry * x1 * x1);
        double numer = Math.Max(0, (rx * rx * ry * ry) - denom);
        double coef = (largeArc == sweep ? -1 : 1) * Math.Sqrt(denom == 0 ? 0 : numer / denom);
        double cx1 = coef * rx * y1 / ry;
        double cy1 = -coef * ry * x1 / rx;
        double cx = (cosP * cx1) - (sinP * cy1) + ((p0[0] + p1[0]) / 2);
        double cy = (sinP * cx1) + (cosP * cy1) + ((p0[1] + p1[1]) / 2);

        double theta = Angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        double delta = Angle(
            (x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0)
        {
            delta -= 2 * Math.PI;
        }

        if (sweep && delta < 0)
        {
            delta += 2 * Math.PI;
        }

        int n = Math.Min(64, Math.Max(6, (int)Math.Ceiling(Math.Abs(delta) / Math.PI * 24)));
        var output = new List<double[]>(n);
        for (int i = 1; i <= n; i++)
        {
            double t = theta + (delta * i / n);
            double ex = rx * Math.Cos(t);
            double ey = ry * Math.Sin(t);
            output.Add(new[]
            {
                (cosP * ex) - (sinP * ey) + cx,
                (sinP * ex) + (cosP * ey) + cy,
            });
        }

        return output;
    }

    private static double Angle(double ux, double uy, double vx, double vy)
    {
        double dot = (ux * vx) + (uy * vy);
        double len = Math.Sqrt((ux * ux) + (uy * uy)) * Math.Sqrt((vx * vx) + (vy * vy));
        double a = Math.Acos(Math.Min(1, Math.Max(-1, len == 0 ? 1 : dot / len)));
        return (ux * vy) - (uy * vx) < 0 ? -a : a;
    }
}
