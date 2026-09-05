using System.Globalization;
using Tdcv2.Prng;

namespace Tdcv2.Stats;

/// <summary>
/// <c>&lt;gen type="timeseries" .../&gt;</c> — a value that depends on when it happened.
/// </summary>
/// <remarks>
/// <para>The layered model every real series is built from:</para>
/// <para><c>value(i) = base + trend·i + Σ amplitude·cos(2π·(i − peak)/period) + noise·e(i)</c></para>
/// <para>
/// A trend, one or more seasonal waves, and noise, with the row index as the clock. Sales, sensor
/// readings and traffic look like this. A uniform draw over the same range does not, and anything
/// that plots the column will show the difference immediately.
/// </para>
/// <para>
/// Like the counters, the value comes from the absolute row index rather than from the row before
/// it, so any row can be computed on its own.
/// </para>
/// </remarks>
public static class Timeseries
{
    /// <summary>How many past rows the correlated noise remembers.</summary>
    /// <remarks>
    /// The textbook AR(1) is written <c>e(t) = φ·e(t−1) + z(t)</c> — a recurrence, which a
    /// seekable engine cannot evaluate: row 900,000 would have to replay 900,000 rows. Written
    /// out, that recurrence is a weighted sum of the past innovations, <c>Σ φ^k·z(t−k)</c>, and
    /// the weights fall off geometrically — so this generator defines the noise as that sum over
    /// a FIXED window and evaluates it directly. Both engines then run the same arithmetic in the
    /// same order and cannot drift apart, and any row is computable on its own.
    /// </remarks>
    public const int NoiseWindow = 63;

    /// <summary>One seasonal wave: how long it is, how far it swings, and where it peaks.</summary>
    /// <param name="PeakAt">
    /// Which row the wave peaks on, or null for the classic sine. A plain
    /// <c>sin(2π·i/period)</c> crosses zero at row 0 and peaks a QUARTER PERIOD later, so a year
    /// of daily rows peaks in early April — the one season nobody means by "warmer in summer".
    /// <c>peak_at</c> names the ROW rather than a shift, because the row is what the author
    /// knows: 182 of 365 is the first of July.
    /// </param>
    public readonly record struct Wave(double Period, double Amplitude, double? PeakAt);

    /// <param name="Waves">
    /// The seasonal waves, in the order written. Empty means no seasonality. A list rather than
    /// one wave because real series carry more than one season at a time: shop takings rise on
    /// Saturdays AND in December, and a model given only the weekly wave has nothing to find in
    /// the yearly one. The waves simply sum.
    /// </param>
    /// <param name="NoiseSd">Standard deviation of the noise; zero means no noise, and no draws.</param>
    /// <param name="NoiseCorrelation">
    /// How strongly one row's noise carries into the next, in (−1, 1). Zero is the independent
    /// (white) noise this generator has always produced. Real measurement error is rarely
    /// independent: a sensor reading high today tends to read high tomorrow, and a model tested
    /// only against white noise has never met the case it will actually fail on.
    /// </param>
    public readonly record struct Spec(
        double Base, double Trend, IReadOnlyList<Wave> Waves,
        double NoiseSd, double NoiseCorrelation, int Decimals)
    {
        public bool HasNoise => NoiseSd != 0;
    }

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng)
    {
        Spec spec = Parse(attrs);
        bool noisy = spec.HasNoise;
        // The window's draws, kept in a ring: walking forward, 63 of the 64 terms were drawn for
        // the row before. It is a cache and nothing else — the sum is the same terms in the same
        // order either way.
        var ring = new Ring();
        double Draw(int row) =>
            StandardNormal(Seekable.OpenUnit(prng.Next()), Seekable.OpenUnit(prng.Next()));
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            // Two uniforms per row when there is noise, none at all when there is not — the draw
            // budget has to be exactly this, or a column declared after this one shifts.
            int here = i;
            double z = noisy
                ? CorrelatedNoise(spec, here, k => ring.Read(here, k, Draw))
                : 0;
            result.Add(Fixed(ValueAt(spec, i, z), spec.Decimals));
        }

        return result;
    }

    public static Spec Parse(IReadOnlyDictionary<string, string> attrs)
    {
        IReadOnlyList<double> periods = NumberList(attrs, "period");
        IReadOnlyList<double> amplitudes = NumberList(attrs, "amplitude");
        IReadOnlyList<double> peaks = NumberList(attrs, "peak_at");
        foreach (double period in periods)
        {
            if (period < 0)
            {
                throw new ArgumentException("timeseries: \"period\" must be >= 0");
            }
        }

        // The three lists describe the same waves position by position, so a length that
        // disagrees is not a wave anybody can draw. The validator says this first and better;
        // this is the backstop for callers who build a gen through the library.
        if (amplitudes.Count > 1 && amplitudes.Count != periods.Count)
        {
            throw new ArgumentException(
                "timeseries: \"amplitude\" must have as many entries as \"period\"");
        }

        if (peaks.Count > 0 && peaks.Count != periods.Count)
        {
            throw new ArgumentException(
                "timeseries: \"peak_at\" must have as many entries as \"period\"");
        }

        var waves = new List<Wave>(periods.Count);
        for (int k = 0; k < periods.Count; k++)
        {
            // One amplitude for many periods is the shorthand for waves of equal height; the far
            // more common case is one of each, which reads the same.
            double amplitude = amplitudes.Count == 0
                ? 0
                : amplitudes[amplitudes.Count == 1 ? 0 : k];
            waves.Add(new Wave(periods[k], amplitude, peaks.Count == 0 ? null : peaks[k]));
        }

        double noiseSd = Number(attrs, "noise", 0);
        if (noiseSd < 0)
        {
            throw new ArgumentException("timeseries: \"noise\" must be >= 0");
        }

        double noiseCorrelation = Number(attrs, "noise_correlation", 0);
        if (!(Math.Abs(noiseCorrelation) < 1))
        {
            throw new ArgumentException(
                "timeseries: \"noise_correlation\" must be between -1 and 1");
        }

        string? decimalsRaw = attrs.GetValueOrDefault("decimals");
        int decimals = 0;
        if (!string.IsNullOrWhiteSpace(decimalsRaw)
            && (!int.TryParse(decimalsRaw.Trim(), out decimals) || decimals < 0))
        {
            throw new ArgumentException(
                "timeseries: \"decimals\" must be a non-negative integer");
        }

        return new Spec(
            Number(attrs, "base", 0),
            Number(attrs, "trend", 0),
            waves,
            noiseSd,
            noiseCorrelation,
            decimals);
    }

    /// <summary>The correlated noise at row <paramref name="i"/>, from the innovations of rows
    /// <c>i − k</c>.</summary>
    /// <remarks>
    /// <para>
    /// <paramref name="past"/> hands back the innovation of row <c>i − k</c>; the caller decides
    /// where it comes from, which is what lets a sequential walk keep a ring of 64 and a random
    /// access pay for 64 lookups. The ARITHMETIC is the same either way — the same terms, added
    /// in the same order — so the two engines cannot disagree.
    /// </para>
    /// <para>
    /// The sum is divided by the length of its own weight vector, so <b>every row has the same
    /// spread</b>. Without that the first rows of a column would be visibly quieter than the
    /// rest — the window has fewer terms to add there — and a series that settles down after
    /// sixty rows is an artefact of the method, not of anything the config asked for.
    /// </para>
    /// </remarks>
    public static double CorrelatedNoise(Spec spec, int i, Func<int, double> past)
    {
        if (spec.NoiseCorrelation == 0)
        {
            return past(0);
        }

        int reach = Math.Min(i, NoiseWindow);
        double sum = 0;
        double squares = 0;
        double weight = 1;
        for (int k = 0; k <= reach; k++)
        {
            sum += weight * past(k);
            squares += weight * weight;
            weight *= spec.NoiseCorrelation;
        }

        return sum / Math.Sqrt(squares);
    }

    /// <summary>The window's innovations, kept so a forward walk draws each row once.</summary>
    /// <remarks>
    /// A cache and nothing else: the arithmetic never changes, so an engine that seeks and an
    /// engine that walks produce one series. <c>draw</c> is asked only for rows the walk has
    /// reached, in order, which is what lets the in-memory engine hand it a SEQUENTIAL generator —
    /// on that path there is no row to seek to, and the ring is the only reason the window can be
    /// read at all.
    /// </remarks>
    public sealed class Ring
    {
        private readonly double[] _slots = new double[NoiseWindow + 1];

        /// <summary>The highest row in the ring; rows <c>have - NoiseWindow .. have</c> are live.</summary>
        private long _have = -1;

        public double Read(int row, int k, Func<int, double> draw)
        {
            const int size = NoiseWindow + 1;
            if (row > _have)
            {
                // Forward by one on a sequential walk; a first touch deep into the column fills
                // the whole window at once, which is what a seeking engine wants.
                for (long r = Math.Max(0, Math.Max(row - (long)NoiseWindow, _have + 1)); r <= row; r++)
                {
                    _slots[(int)(r % size)] = draw((int)r);
                }

                _have = row;
            }

            long want = row - (long)k;
            if (want < 0)
            {
                return 0; // before row zero there is nothing to remember
            }

            // A jump backwards past the window re-draws, which costs one hash and cannot give a
            // different number.
            return want > _have - size ? _slots[(int)(want % size)] : draw((int)want);
        }
    }

    /// <summary>A standard normal deviate by Box–Muller, from two uniforms in (0,1).</summary>
    public static double StandardNormal(double u1, double u2) =>
        Math.Sqrt(-2 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2);

    public static double ValueAt(Spec spec, int i, double e)
    {
        double v = spec.Base + (spec.Trend * i);
        foreach (Wave wave in spec.Waves)
        {
            if (wave.Period <= 0 || wave.Amplitude == 0)
            {
                continue;
            }

            // One formula for both. `cos` peaks where its argument is zero, so the wave peaks
            // exactly on `peak`. The DEFAULT peak is a quarter period in, which is where a plain
            // `sin(2π·i/period)` already peaked — so a config without `peak_at` produces the same
            // bytes it always did, without a second branch saying so.
            double peak = wave.PeakAt ?? wave.Period / 4;
            v += wave.Amplitude * Math.Cos(2 * Math.PI * (i - peak) / wave.Period);
        }

        if (spec.NoiseSd != 0)
        {
            v += spec.NoiseSd * e;
        }

        return v;
    }

    /// <summary>A comma-separated list of numbers, or empty when the attribute is absent.</summary>
    private static IReadOnlyList<double> NumberList(
        IReadOnlyDictionary<string, string> attrs, string key)
    {
        string? raw = attrs.GetValueOrDefault(key);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return Array.Empty<double>();
        }

        var out_ = new List<double>();
        foreach (string piece in raw.Split(','))
        {
            if (!double.TryParse(
                    piece.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
                || !double.IsFinite(n))
            {
                throw new ArgumentException(
                    $"timeseries: \"{key}\" must be a number (got \"{raw}\")");
            }

            out_.Add(n);
        }

        return out_;
    }

    private static string Fixed(double v, int decimals) => Distribution.ToFixed(v, decimals);

    private static double Number(
        IReadOnlyDictionary<string, string> attrs, string key, double fallback)
    {
        string? raw = attrs.GetValueOrDefault(key);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!double.TryParse(
                raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            || !double.IsFinite(n))
        {
            throw new ArgumentException(
                $"timeseries: \"{key}\" must be a number (got \"{raw}\")");
        }

        return n;
    }
}
