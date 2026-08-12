using System.Globalization;
using System.Text.RegularExpressions;
using Tdcv2.Prng;

namespace Tdcv2.Pattern;

/// <summary>
/// <c>&lt;gen type="pattern" .../&gt;</c> — data shaped like a drawing.
/// </summary>
/// <remarks>
/// <para>Three ways to read one:</para>
/// <list type="bullet">
///   <item>
///     <c>points="0,0 5,9 10,2"</c> — a single line, read as a trajectory. Deterministic: no draw
///     is taken at all, so the column is the same under every seed.
///   </item>
///   <item>
///     <c>upper=</c> with an optional <c>lower=</c> — a band. Each row is a random value between
///     the two lines, one draw apiece.
///   </item>
///   <item><c>mode="density"</c> — the same drawing read as a distribution instead.</item>
/// </list>
/// <para>
/// <c>spread="N"</c> widens a single line into a tunnel of ±N without drawing its edges by hand,
/// which is the usual way to turn a clean trend into something that looks measured.
/// </para>
/// <para>
/// Like the counters, a signal's value comes from the absolute row index rather than from the row
/// before it.
/// </para>
/// <para>
/// A drawing loaded from a file — <c>src=</c> pointing at a PNG or an SVG — is read the same way
/// either format: highest and lowest ink at each position, so one stroke is an exact curve and two
/// strokes are a band.
/// </para>
/// </remarks>
public sealed class PatternGen
{
    private static readonly Regex Number =
        new(@"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", RegexOptions.Compiled);

    private enum Kind
    {
        Signal,
        Corridor,
        DensityKind,
    }

    private readonly Kind _kind;
    private readonly Curve? _curve;
    private readonly Curve? _lower;
    private readonly Curve? _upper;
    private readonly Density? _density;
    private readonly double _spread;
    private readonly int _decimals;

    private PatternGen(
        Kind kind, Curve? curve, Curve? lower, Curve? upper, Density? density, double spread,
        int decimals)
    {
        _kind = kind;
        _curve = curve;
        _lower = lower;
        _upper = upper;
        _density = density;
        _spread = spread;
        _decimals = decimals;
    }

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng, string? baseDir = null,
        IReadOnlyList<string>? roots = null)
    {
        PatternGen gen = Of(attrs, baseDir, roots);
        bool draws = gen.Draws;
        var result = new List<string>(count);
        // The drawing is stretched over the run: row i reads it at i/(count-1), and one row covers
        // 1/(count-1) of its width.
        double denom = count > 1 ? count - 1 : 1;
        for (int i = 0; i < count; i++)
        {
            double u = draws ? Seekable.OpenUnit(prng.Next()) : 0;
            result.Add(gen.ValueAt(i / denom, u));
        }

        return result;
    }

    public static PatternGen Of(
        IReadOnlyDictionary<string, string> attrs, string? baseDir = null,
        IReadOnlyList<string>? roots = null)
    {
        double spread = Spread(attrs);
        int decimals = DecimalsOf(attrs);
        double[]? yRange = YRange(attrs.GetValueOrDefault("y_range"));
        Interp interp = InterpOf(attrs.GetValueOrDefault("interp"));

        PatternGen gen;
        string? upperRaw = attrs.GetValueOrDefault("upper");
        if (!string.IsNullOrWhiteSpace(upperRaw))
        {
            IReadOnlyList<double[]> upperPts = Points(upperRaw);
            string? lowerRaw = attrs.GetValueOrDefault("lower");
            IReadOnlyList<double[]>? lowerPts =
                string.IsNullOrWhiteSpace(lowerRaw) ? null : Points(lowerRaw);
            gen = Corridor(upperPts, lowerPts, yRange, decimals, interp, spread);
        }
        else
        {
            string? pointsRaw = attrs.GetValueOrDefault("points");
            if (string.IsNullOrWhiteSpace(pointsRaw))
            {
                string? src = attrs.GetValueOrDefault("src");
                if (string.IsNullOrWhiteSpace(src))
                {
                    throw new ArgumentException(
                        "pattern: needs \"points\"/\"src\", or \"upper\"[/\"lower\"]");
                }

                gen = FromFile(src.Trim(), baseDir, roots, attrs, yRange, decimals, interp, spread);
            }
            else
            {
                Curve c = Curve.Of(Points(pointsRaw), yRange, decimals, null, interp);
                gen = new PatternGen(Kind.Signal, c, null, null, null, spread, decimals);
            }
        }

        if (Mode(attrs.GetValueOrDefault("mode")) != "density")
        {
            return gen;
        }

        if (spread > 0)
        {
            throw new ArgumentException(
                "pattern: \"spread\" has no meaning with mode=\"density\" — the drawing itself "
                + "sets the scatter");
        }

        // A band contributes its top edge: the outline is the distribution, whatever its floor does.
        Curve source = gen._kind == Kind.Corridor ? gen._upper! : gen._curve!;
        return new PatternGen(
            Kind.DensityKind, null, null, null, Density.Of(source), 0, decimals);
    }

    /// <summary>
    /// A drawing on disk: a picture, or a vector file.
    /// </summary>
    /// <remarks>
    /// Both are measured the same way — highest and lowest ink at each position — so one stroke
    /// gives an exact curve and two strokes, or a closed outline, give a band. A file may switch
    /// between the two along its own length, and a sketch usually does.
    /// </remarks>
    private static PatternGen FromFile(
        string src, string? baseDir, IReadOnlyList<string>? roots,
        IReadOnlyDictionary<string, string> attrs, double[]? yRange, int decimals, Interp interp,
        double spread)
    {
        // The same resolution a file source gets, so a drawing may live in a data folder too.
        string path = Generators.FileGen.Resolve(src, baseDir, roots);
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (IOException e)
        {
            throw new ArgumentException($"pattern: cannot read \"{src}\"", e);
        }
        catch (UnauthorizedAccessException e)
        {
            throw new ArgumentException($"pattern: cannot read \"{src}\"", e);
        }

        if (Png.IsPng(bytes))
        {
            Png.Image image = Png.Decode(bytes);
            SvgPath.Envelope traced = Png.Trace(image, InkThreshold(attrs));
            // The frame is the value scale: the picture's own height is what 0..max means.
            return FromEnvelope(
                traced, yRange, decimals, interp, spread, new double[] { 0, image.Height - 1 });
        }

        SvgPath.Envelope envelope =
            SvgPath.GetEnvelope(System.Text.Encoding.UTF8.GetString(bytes), 600);
        return FromEnvelope(envelope, yRange, decimals, interp, spread, null);
    }

    /// <summary>
    /// A traced envelope becomes a plain line when its two edges coincide, and a band otherwise.
    /// </summary>
    private static PatternGen FromEnvelope(
        SvgPath.Envelope envelope, double[]? yRange, int decimals, Interp interp, double spread,
        double[]? normExtent)
    {
        IReadOnlyList<double[]> top = envelope.Top;
        IReadOnlyList<double[]> bottom = envelope.Bottom;

        bool banded = false;
        int n = Math.Min(top.Count, bottom.Count);
        for (int i = 0; i < n; i++)
        {
            if (Math.Abs(top[i][1] - bottom[i][1]) > 1e-9)
            {
                banded = true;
                break;
            }
        }

        if (!banded)
        {
            return new PatternGen(
                Kind.Signal, Curve.Of(top, yRange, decimals, normExtent, interp), null, null, null,
                spread, decimals);
        }

        double lo = double.PositiveInfinity;
        double hi = double.NegativeInfinity;
        foreach (double[] p in top)
        {
            lo = Math.Min(lo, p[1]);
            hi = Math.Max(hi, p[1]);
        }

        foreach (double[] p in bottom)
        {
            lo = Math.Min(lo, p[1]);
            hi = Math.Max(hi, p[1]);
        }

        double[] extent = normExtent ?? new[] { lo, hi };
        return new PatternGen(
            Kind.Corridor,
            null,
            Curve.Of(bottom, yRange, decimals, extent, interp),
            Curve.Of(top, yRange, decimals, extent, interp),
            null,
            spread,
            decimals);
    }

    /// <summary><c>ink_threshold</c> — how dark counts as a line, on an opaque background.</summary>
    private static double InkThreshold(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("ink_threshold");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0.5;
        }

        if (!double.TryParse(
                raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double t)
            || !double.IsFinite(t) || t <= 0 || t >= 1)
        {
            throw new ArgumentException(
                "pattern: \"ink_threshold\" must be a number strictly between 0 and 1");
        }

        return t;
    }

    /// <summary>
    /// A corridor: two lines in one value space.
    /// </summary>
    /// <remarks>
    /// Both are normalized against their <em>shared</em> height extent, so the band between them
    /// means something. Normalizing each against its own extent would stretch them to the same
    /// height and collapse the corridor.
    /// </remarks>
    private static PatternGen Corridor(
        IReadOnlyList<double[]> upperPts, IReadOnlyList<double[]>? lowerPts, double[]? yRange,
        int decimals, Interp interp, double spread)
    {
        var heights = new List<double>();
        foreach (double[] p in upperPts)
        {
            heights.Add(p[1]);
        }

        if (lowerPts is not null)
        {
            foreach (double[] p in lowerPts)
            {
                heights.Add(p[1]);
            }
        }
        else
        {
            // No lower line means a flat floor at zero, which belongs in the shared extent.
            heights.Add(0.0);
        }

        double lo = heights.Count == 0 ? 0 : heights.Min();
        double hi = heights.Count == 0 ? 0 : heights.Max();
        var extent = new[] { lo, hi };

        Curve upper = Curve.Of(upperPts, yRange, decimals, extent, interp);
        Curve lower;
        if (lowerPts is not null)
        {
            lower = Curve.Of(lowerPts, yRange, decimals, extent, interp);
        }
        else
        {
            double x0 = upperPts[0][0];
            double xN = upperPts[^1][0];
            lower = Curve.Of(
                new[] { new[] { x0, lo }, new[] { xN, lo } }, yRange, decimals, extent, interp);
        }

        return new PatternGen(Kind.Corridor, null, lower, upper, null, spread, decimals);
    }

    /// <summary>Whether a row costs a draw: a band, a spread, or a density. A bare line costs none.</summary>
    public bool Draws => _kind != Kind.Signal || _spread > 0;

    public string ValueAt(double t, double u)
    {
        if (_kind == Kind.DensityKind)
        {
            // Position in the run means nothing here — the drawing is a distribution, so the row's
            // own draw picks the value and the order comes out random.
            return Format(_density!.ValueAt(u), _density.Decimals);
        }

        if (_kind == Kind.Signal)
        {
            double v = _curve!.ValueAt(t);
            return Format(_spread > 0 ? v + (((2 * u) - 1) * _spread) : v, _decimals);
        }

        double a = _lower!.ValueAt(t);
        double b = _upper!.ValueAt(t);
        double low = Math.Min(a, b) - _spread;
        double high = Math.Max(a, b) + _spread;
        return Format(low + (u * (high - low)), _decimals);
    }

    // ── attributes ───────────────────────────────────────────────────────────────────────────

    /// <summary>Every number in the text, in pairs. Whatever separates them is decoration.</summary>
    internal static IReadOnlyList<double[]> Points(string raw)
    {
        // A `;` is NOT a separator: every number is read in order, so
        // `0,20 100,20; 0,80 100,80` would silently become ONE curve of four points.
        // Somebody writing that meant a band, so name the spelling that works.
        if (raw.Contains(';', StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "pattern: \";\" does not separate two lines in points= — every number is read "
                + "as one curve. For a band, draw the two edges separately: "
                + "upper=\"0,80 100,80\" lower=\"0,20 100,20\".");
        }

        var nums = new List<double>();
        foreach (Match m in Number.Matches(raw))
        {
            nums.Add(double.Parse(m.Value, CultureInfo.InvariantCulture));
        }

        if (nums.Count == 0 || nums.Count % 2 != 0)
        {
            throw new ArgumentException(
                "pattern: points must be an even list of \"x,y\" coordinates (got "
                + $"{nums.Count} numbers)");
        }

        var points = new List<double[]>(nums.Count / 2);
        for (int i = 0; i < nums.Count; i += 2)
        {
            points.Add(new[] { nums[i], nums[i + 1] });
        }

        return points;
    }

    /// <summary>
    /// <c>y_range="min..max"</c> — the value axis, and REQUIRED. A drawing carries no units of
    /// its own: a curve exported from one tool runs 0..100, from another 0..10002345345. Without
    /// it every answer would be a guess about somebody's export settings.
    /// </summary>
    internal static double[]? YRange(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new ArgumentException(
                "pattern: y_range is required — it is the value axis a drawing is brought into, "
                + "and a drawing has no scale of its own. Write y_range=\"0..100\".");
        }

        string[] parts = raw.Split("..");
        if (parts.Length != 2
            || !double.TryParse(parts[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double a)
            || !double.TryParse(parts[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double b)
            || !double.IsFinite(a) || !double.IsFinite(b))
        {
            throw new ArgumentException(
                $"pattern: y_range \"{raw}\" must be \"min..max\" with two numbers");
        }

        return new[] { a, b };
    }

    internal static Interp InterpOf(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return Interp.Linear;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "linear" => Interp.Linear,
            "smooth" => Interp.Smooth,
            "step" => Interp.Step,
            _ => throw new ArgumentException(
                "pattern: \"interp\" must be \"linear\", \"smooth\" or \"step\""),
        };
    }

    internal static string Mode(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return "signal";
        }

        string v = raw.Trim().ToLowerInvariant();
        if (v != "signal" && v != "density")
        {
            throw new ArgumentException(
                "pattern: \"mode\" must be \"signal\" (a trajectory) or \"density\" (a distribution)");
        }

        return v;
    }

    internal static double Spread(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("spread");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double s)
            || !double.IsFinite(s) || s < 0)
        {
            throw new ArgumentException("pattern: \"spread\" must be a non-negative number");
        }

        return s;
    }

    internal static int DecimalsOf(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("decimals");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int d)
            || d < 0)
        {
            throw new ArgumentException("pattern: \"decimals\" must be a non-negative integer");
        }

        return d;
    }

    private static string Format(double v, int decimals) =>
        Stats.Distribution.ToFixed(v, decimals);
}
