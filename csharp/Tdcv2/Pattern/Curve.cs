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

        // Two points on ONE x is the same emptiness as a single point, one step later: no
        // width, so "where this card's line crosses the drawing" has no single answer.
        if (points.All(p => p[0] == points[0][0]))
        {
            throw new ArgumentException(
                $"pattern: every point sits at x={points[0][0]:0.####}, so the drawing has no "
                + "width and a card has nothing to read across. Give the points at least two "
                + "different x coordinates.");
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

        double[] canvas = normExtent ?? VectorCanvas(lo, hi);
        double nyMin = canvas[0];
        double nyMax = canvas[1];
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

        // A step holds each point's value in the band to its RIGHT, and the last point has no
        // band — the drawing ends there. So it used to be drawn and yet unreachable, with the
        // right edge reporting the plateau before it while linear and smooth reported the point.
        if (_interp == Interp.Step)
        {
            return x >= xb ? yb : ya;
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
    /// A row also used to own a WINDOW — the slice of drawing between it and its neighbours —
    /// and whenever a drawn vertex fell inside it the row returned that window's average instead
    /// of the crossing. Which rule a row used depended on where the vertices happened to land, so
    /// neighbouring rows of one drawing were computed by different laws and nothing in the picture
    /// said which was which. Ten rows are a request for ten readings, and ten readings are what
    /// they get; a peak between two of them is the consequence of having asked for ten, not a
    /// lost measurement.
    /// </remarks>
    public double ValueAt(double t)
    {
        double x0 = _xs[0];
        double xN = _xs[^1];
        double span = xN - x0;

        double y = HeightAtX(x0 + (Clamp01(t) * span));

        if (_yRange is null)
        {
            return y;
        }

        // The CANVAS is the scale, never the ink: the image for a raster, 0..100 grown only to
        // hold what was drawn outside it for a list of points.
        double vspan = _yMax - _yMin;
        double yn = vspan == 0 ? 0.5 : (y - _yMin) / vspan;
        double scaled = _yRange[0] + (yn * (_yRange[1] - _yRange[0]));

        // A drawn point is inside its canvas by construction, so this catches only what is added
        // AFTER the mapping — a spread's scatter and a band's width.
        double lowEdge = Math.Min(_yRange[0], _yRange[1]);
        double highEdge = Math.Max(_yRange[0], _yRange[1]);
        return Math.Min(Math.Max(scaled, lowEdge), highEdge);
    }

    /// <summary>
    /// The default height of a drawn canvas — a percentage board, the same one the Studio draws
    /// on. It is a CONSTANT rather than a measurement: a horizontal line at 50 sits halfway up a
    /// canvas of 100 no matter how many points the drawing has, so <c>y_range="0..100"</c> gives
    /// back 50 and <c>-5..5</c> gives back 0. Measuring the drawing instead would make that same
    /// line the highest thing present, hence the top of the range.
    /// </summary>
    private const double VectorCanvasTop = 100;

    /// <summary>
    /// The canvas a drawn list of points is read against. It never shrinks below 0..100; it only
    /// GROWS, to hold whatever was drawn outside it.
    /// </summary>
    internal static double[] VectorCanvas(double yMin, double yMax) =>
        new[] { Math.Min(0, yMin), Math.Max(VectorCanvasTop, yMax) };

    private static double Clamp01(double v) => Math.Min(Math.Max(v, 0), 1);
}
