namespace Tdcv2.Prng;

/// <summary>
/// Draws that can be taken for one row without taking them for any other.
/// </summary>
/// <remarks>
/// <para>
/// The in-memory engine walks one generator from the start, so row 900 000's value exists only
/// after the 899 999 before it. That is fine when the whole run is in memory and impossible when
/// it is not.
/// </para>
/// <para>
/// Here each draw is keyed by <c>seed | streamId | index</c>, so a row's values are a function of
/// its own number. Nothing has to be kept, nothing has to be replayed, and a run of any size costs
/// the memory of one row. It is also what lets separate workers each render a slice of the same
/// file and agree at the seams.
/// </para>
/// </remarks>
public static class Seekable
{
    /// <summary>Half of a 32-bit unit in the last place — see <see cref="OpenUnit"/>.</summary>
    private const double HalfUlp = 0.5 / 4294967296.0;

    /// <summary>A generator private to one row of one stream.</summary>
    public static Sfc32 Generator(string seed, string streamId, int index)
    {
        int[] s = Prng.Cyrb128(seed + "|" + streamId + "|" + index.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return new Sfc32(s[0], s[1], s[2], s[3]);
    }

    public static double Next(string seed, string streamId, int index) =>
        Generator(seed, streamId, index).Next();

    /// <summary>An integer in <c>[0, n)</c> for this row.</summary>
    public static int NextInt(string seed, string streamId, int index, int n)
    {
        if (n <= 1)
        {
            return 0;
        }

        return (int)Math.Floor(Next(seed, streamId, index) * n);
    }

    /// <summary>
    /// Nudge a raw draw into the open interval (0,1).
    /// </summary>
    /// <remarks>
    /// sfc32 emits values in <c>[0, 1)</c>, and inverse-CDF sampling takes logarithms — at exactly
    /// zero those are infinite. The shift is about 1e-10 and changes nothing statistically.
    /// </remarks>
    public static double OpenUnit(double u) => Math.Min(1 - HalfUlp, Math.Max(HalfUlp, u + HalfUlp));

    /// <summary><c>count</c> uniforms in (0,1) for one row — what a fixed-draw sampler needs.</summary>
    public static double[] Uniforms(string seed, string streamId, int index, int count)
    {
        Sfc32 gen = Generator(seed, streamId, index);
        var result = new double[count];
        for (int k = 0; k < count; k++)
        {
            result[k] = OpenUnit(gen.Next());
        }

        return result;
    }
}
