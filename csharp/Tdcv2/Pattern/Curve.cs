namespace Tdcv2.Pattern;

/// <summary>How the line is read between two drawn points.</summary>
public enum Interp
{
    /// <summary>
    /// The straight segment. Faithful to a polyline, but one segment stretched over thousands of
    /// rows climbs by an identical step every time, which reads as obviously machine-made.
    /// </summary>
    Linear,

    /// <summary>
    /// A monotone cubic through the points: it eases in and out of each one and, unlike an
    /// ordinary spline, never overshoots past a drawn value — which matters when the drawing is
    /// the specification.
    /// </summary>
    Smooth,

    /// <summary>Hold each value until the next point.</summary>
    Step,
}

/// <summary>
/// A drawn line, read as data.
/// </summary>
/// <remarks>
/// <para>
/// The horizontal axis is the row index: row <c>i</c> of <c>count</c> reads the curve at
/// <c>t = i/(count-1)</c>, so a sketch of half a dozen points stretches over however many rows are
/// generated — ten, or a million. The vertical axis is the value, and since a drawing has no
/// inherent scale the config declares the range with <c>y_range="min..max"</c>; only the shape of
/// the line matters, never the numbers it was drawn with.
/// </para>
/// <para>
/// This is what a config reaches for when the data has to look like something — a daily traffic
/// curve, a sales year with a Christmas peak — and no named distribution has that shape.
/// </para>
/// </remarks>
public sealed class Curve
{
    private readonly double[] _xs;
    private readonly double[] _ys;
    private readonly double _yMin;
    private readonly double _yMax;
    private readonly double[]? _yRange;
    private readonly int _decimals;
    private readonly Interp _interp;
    private readonly double[]? _slopes;

    private Curve(
        double[] xs, double[] ys, double yMin, double yMax, double[]? yRange, int decimals,
        Interp interp, double[]? slopes)
    {
        _xs = xs;
        _ys = ys;
        _yMin = yMin;
        _yMax = yMax;
        _yRange = yRange;
        _decimals = decimals;
        _interp = interp;
        _slopes = slopes;
    }

    public double[] Xs => _xs;

    public double YMin => _yMin;

    public double[]? YRange => _yRange;

    public int Decimals => _decimals;

    /// <summary>
    /// Build a curve from raw points.
    /// </summary>
    /// <param name="normExtent">
    /// Overrides the height extent used to normalize into <c>yRange</c>; a corridor passes the
    /// extent shared by both of its lines so the two live in one value space and the band between
    /// them means something.
    /// </param>
    public static Curve Of(
        IReadOnlyList<double[]> points, double[]? yRange, int decimals, double[]? normExtent,
        Interp interp)
    {
        if (points.Count < 2)
        {
            throw new ArgumentException("pattern: need at least two points to define a curve");
        }

        // A stable sort, as Java's is: two points at the same x keep the order they were written.
        List<double[]> sorted = points.OrderBy(p => p[0]).ToList();

        var xs = new double[sorted.Count];
        var ys = new double[sorted.Count];
        for (int i = 0; i < sorted.Count; i++)
        {
            xs[i] = sorted[i][0];
            ys[i] = sorted[i][1];
        }

        double lo = ys[0];
        double hi = ys[0];
        foreach (double y in ys)
        {
            lo = Math.Min(lo, y);
            hi = Math.Max(hi, y);
        }

        double nyMin = normExtent is not null ? normExtent[0] : lo;
        double nyMax = normExtent is not null ? normExtent[1] : hi;
        double[]? slopes = interp == Interp.Smooth ? PchipSlopes(xs, ys) : null;
        return new Curve(xs, ys, nyMin, nyMax, yRange, decimals, interp, slopes);
    }

    /// <summary>
    /// Fritsch–Carlson tangents: the slope at a point is a weighted harmonic mean of its
    /// neighbouring secants, forced to zero wherever the data turns. That is what keeps the
    /// smoothed line inside the values that were actually drawn.
    /// </summary>
    private static double[] PchipSlopes(double[] xs, double[] ys)
    {
        int n = xs.Length;
        var h = new double[n - 1];
        var d = new double[n - 1];
        for (int i = 0; i < n - 1; i++)
        {
            h[i] = xs[i + 1] - xs[i];
            d[i] = h[i] == 0 ? 0 : (ys[i + 1] - ys[i]) / h[i];
        }

        var m = new double[n];
        m[0] = d[0];
        m[n - 1] = d[n - 2];
        for (int i = 1; i < n - 1; i++)
        {
            double d0 = d[i - 1];
            double d1 = d[i];
            if (d0 * d1 <= 0)
            {
                m[i] = 0;
            }
            else
            {
                double w1 = (2 * h[i]) + h[i - 1];
                double w2 = h[i] + (2 * h[i - 1]);
                m[i] = (w1 + w2) / ((w1 / d0) + (w2 / d1));
            }
        }

        return m;
    }

    /// <summary>The segment <c>[xs[k], xs[k+1]]</c> that contains <c>x</c>.</summary>
    internal static int SegmentAt(double[] xs, double x)
    {
        int lo = 0;
        int hi = xs.Length - 1;
        while (lo < hi)
        {
            int mid = (int)(((uint)(lo + hi + 1)) >> 1);
            if (xs[mid] <= x)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }

        return Math.Min(lo, xs.Length - 2);
    }

    /// <summary>The drawn height at a horizontal coordinate.</summary>
    internal double HeightAtX(double x)
    {
        int k = SegmentAt(_xs, x);
        double xa = _xs[k];
        double xb = _xs[k + 1];
        double ya = _ys[k];
        double yb = _ys[k + 1];
        double dx = xb - xa;
        if (dx <= 0)
        {
            return ya;
        }

        double s = (x - xa) / dx;
        if (_interp == Interp.Step)
        {
            return ya;
        }

        if (_interp == Interp.Smooth && _slopes is not null)
        {
            double ma = _slopes[k];
            double mb = _slopes[k + 1];
            double s2 = s * s;
            double s3 = s2 * s;
            return (((2 * s3) - (3 * s2) + 1) * ya)
                + ((s3 - (2 * s2) + s) * dx * ma)
                + (((-2 * s3) + (3 * s2)) * yb)
                + ((s3 - s2) * dx * mb);
        }

        return ya + (s * (yb - ya));
    }

    /// <summary>
    /// The value at position <c>t</c> in [0,1].
    /// </summary>
    /// <remarks>
    /// <c>dt</c> is how much of the drawing one row covers. When the rows outnumber the drawn
    /// points, that window is shorter than a segment and the reading is simply the point on the
    /// line. When the drawing has <em>more</em> points than there are rows — a thousand-point trace
    /// squeezed into ten — each row averages the line across its whole window instead, so the
    /// detail in between is summarised rather than silently dropped by landing on one arbitrary
    /// sample.
    /// </remarks>
    public double ValueAt(double t, double dt)
    {
        double x0 = _xs[0];
        double xN = _xs[^1];
        double span = xN - x0;

        double half = dt / 2;
        double xa = x0 + (Clamp01(t - half) * span);
        double xb = x0 + (Clamp01(t + half) * span);
        int inside = dt > 0 ? SegmentAt(_xs, xb) - SegmentAt(_xs, xa) : 0;

        double y;
        if (inside <= 0)
        {
            y = HeightAtX(x0 + (Clamp01(t) * span));
        }
        else
        {
            int steps = Math.Min(64, Math.Max(2, inside * 2));
            double sum = 0;
            for (int i = 0; i <= steps; i++)
            {
                double w = i == 0 || i == steps ? 0.5 : 1;
                sum += w * HeightAtX(xa + ((xb - xa) * i / steps));
            }

            y = sum / steps;
        }

        if (_yRange is null)
        {
            return y;
        }

        double vspan = _yMax - _yMin;
        double yn = vspan == 0 ? 0 : (y - _yMin) / vspan;
        return _yRange[0] + (yn * (_yRange[1] - _yRange[0]));
    }

    private static double Clamp01(double v) => Math.Min(Math.Max(v, 0), 1);
}
