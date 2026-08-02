namespace Tdcv2.Pattern;

/// <summary>
/// The other question the same drawing can answer: <c>mode="density"</c>.
/// </summary>
/// <remarks>
/// <para>
/// A signal reads the line as a trajectory — the horizontal axis is the row index, the height is
/// that row's value, and the rows walk along the line in order. A density asks the opposite: the
/// horizontal axis is the <em>value</em> and the height is how <em>often</em> that value comes up.
/// Draw a hump over the middle and the numbers pile up in the middle, in no particular order.
/// </para>
/// <para>
/// It is "draw your own probability" instead of picking <c>normal</c> or <c>poisson</c> from a
/// list — which matters when the real shape has two peaks, or a long tail on one side only, and no
/// named distribution fits.
/// </para>
/// </remarks>
public sealed class Density
{
    /// <summary>How finely the drawing is integrated; every drawn vertex is kept on top of this.</summary>
    private const int Grid = 512;

    private readonly double[] _xs;
    private readonly double[] _dens;
    private readonly double[] _cdf;
    private readonly double _area;
    private readonly double[]? _yRange;
    private readonly int _decimals;

    private Density(
        double[] xs, double[] dens, double[] cdf, double area, double[]? yRange, int decimals)
    {
        _xs = xs;
        _dens = dens;
        _cdf = cdf;
        _area = area;
        _yRange = yRange;
        _decimals = decimals;
    }

    public int Decimals => _decimals;

    /// <summary>
    /// Turn a curve into a distribution.
    /// </summary>
    /// <remarks>
    /// Zero probability is the drawing's own floor — the lowest point on it — so the deepest part
    /// of the drawing is the value that never appears. A drawing with no height at all has nothing
    /// to weight by, and becomes a flat distribution rather than an error.
    /// </remarks>
    public static Density Of(Curve curve)
    {
        double[] vertices = curve.Xs;
        double xMax = vertices[^1];

        var grid = new List<double>();
        int per = Math.Max(1, (int)Math.Ceiling((double)Grid / Math.Max(1, vertices.Length - 1)));
        for (int i = 0; i < vertices.Length - 1; i++)
        {
            double a = vertices[i];
            double b = vertices[i + 1];
            for (int k = 0; k < per; k++)
            {
                grid.Add(a + ((b - a) * k / per));
            }
        }

        grid.Add(xMax);

        var xs = new double[grid.Count];
        var dens = new double[grid.Count];
        for (int i = 0; i < grid.Count; i++)
        {
            xs[i] = grid[i];
            dens[i] = Math.Max(0, curve.HeightAtX(xs[i]) - curve.YMin);
        }

        var cum = new double[xs.Length];
        double total = 0;
        for (int i = 0; i < xs.Length - 1; i++)
        {
            double h = xs[i + 1] - xs[i];
            total += h * (dens[i] + dens[i + 1]) / 2;
            cum[i + 1] = total;
        }

        if (total <= 0)
        {
            var flat = new double[xs.Length];
            var uniform = new double[xs.Length];
            for (int i = 0; i < xs.Length; i++)
            {
                flat[i] = 1;
                uniform[i] = xs.Length > 1 ? (double)i / (xs.Length - 1) : 0;
            }

            return new Density(xs, flat, uniform, xMax - xs[0], curve.YRange, curve.Decimals);
        }

        var cdf = new double[cum.Length];
        for (int i = 0; i < cum.Length; i++)
        {
            cdf[i] = cum[i] / total;
        }

        return new Density(xs, dens, cdf, total, curve.YRange, curve.Decimals);
    }

    /// <summary>
    /// Invert the distribution: one uniform becomes one value.
    /// </summary>
    /// <remarks>
    /// Inside a grid cell the density is a straight line, so the area up to a point is a quadratic
    /// and the exact crossing is solved rather than searched. Bucketing would be simpler and would
    /// bias every value towards its cell's edge.
    /// </remarks>
    public double ValueAt(double u)
    {
        double target = Math.Min(Math.Max(u, 0), 1);
        int lo = 0;
        int hi = _cdf.Length - 1;
        while (lo < hi)
        {
            int mid = (int)(((uint)(lo + hi + 1)) >> 1);
            if (_cdf[mid] <= target)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }

        int k = Math.Min(lo, _xs.Length - 2);
        double xa = _xs[k];
        double h = _xs[k + 1] - xa;
        double d0 = _dens[k];
        double d1 = _dens[k + 1];
        double cellArea = (target - _cdf[k]) * _area;

        double s;
        double slope = d1 - d0;
        if (h <= 0)
        {
            s = 0;
        }
        else if (Math.Abs(slope) < 1e-12)
        {
            s = d0 == 0 ? 0 : Math.Min(1, cellArea / (h * d0));
        }
        else
        {
            // (slope/2)·s² + d0·s − cellArea/h = 0
            double c = -cellArea / h;
            double disc = Math.Max(0, (d0 * d0) - (2 * slope * c));
            s = (-d0 + Math.Sqrt(disc)) / slope;
            if (!double.IsFinite(s) || s < 0)
            {
                s = 0;
            }

            if (s > 1)
            {
                s = 1;
            }
        }

        double x = xa + (s * h);

        if (_yRange is null)
        {
            return x;
        }

        double x0 = _xs[0];
        double xN = _xs[^1];
        double span = xN - x0;
        double xn = span == 0 ? 0 : (x - x0) / span;
        return _yRange[0] + (xn * (_yRange[1] - _yRange[0]));
    }
}
