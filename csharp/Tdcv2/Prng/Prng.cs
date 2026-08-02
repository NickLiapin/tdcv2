namespace Tdcv2.Prng;

/// <summary>
/// Seeded pseudo-random number generator: cyrb128 feeding sfc32.
/// </summary>
/// <remarks>
/// <para>
/// This is the foundation of TDC's cross-language guarantee. The same seed has to produce the same
/// sequence of doubles here, in the TypeScript reference, in Java and in Python. If this file
/// drifts by one bit, every generated dataset drifts with it.
/// </para>
/// <para>
/// The TypeScript original leans on <c>Math.imul</c>, <c>| 0</c> and <c>&gt;&gt;&gt; 0</c> to force
/// 32-bit arithmetic out of a language whose only number is a double. C#'s <c>int</c> is already
/// 32-bit two's complement, and arithmetic on it wraps by default outside a <c>checked</c> block,
/// so those translate one for one. Two places are written out rather than borrowed: an unsigned
/// shift is <c>(int)((uint)x &gt;&gt; n)</c> — C# grew a <c>&gt;&gt;&gt;</c> operator only in
/// version 11, and spelling it this way keeps the library buildable by an older compiler — and the
/// final division casts to <c>uint</c>, which is what stops a negative <c>t</c> becoming a
/// negative double.
/// </para>
/// <para>
/// The one place a port can silently diverge is the seed string. JavaScript's <c>charCodeAt</c>
/// returns a UTF-16 code unit, and so does indexing a C# <c>string</c>. Any port that iterates
/// code points instead of code units gets different numbers for any seed outside the Basic
/// Multilingual Plane.
/// </para>
/// <para>Verified against <c>fixtures/cross-language/prng-vectors.json</c>.</para>
/// </remarks>
public static class Prng
{
    /// <summary>Derive four 32-bit state words from a seed string.</summary>
    public static int[] Cyrb128(string seed)
    {
        unchecked
        {
            int h1 = 1779033703;
            int h2 = -1150833019; // 3144134277 as a signed 32-bit int
            int h3 = 1013904242;
            int h4 = -1521486534; // 2773480762
            for (int i = 0; i < seed.Length; i++)
            {
                int k = seed[i];
                h1 = h2 ^ ((h1 ^ k) * 597399067);
                h2 = h3 ^ ((h2 ^ k) * -1425107063); // 2869860233
                h3 = h4 ^ ((h3 ^ k) * 951274213);
                h4 = h1 ^ ((h4 ^ k) * -1578923117); // 2716044179
            }

            h1 = (h3 ^ (int)((uint)h1 >> 18)) * 597399067;
            h2 = (h4 ^ (int)((uint)h2 >> 22)) * -1425107063;
            h3 = (h1 ^ (int)((uint)h3 >> 17)) * 951274213;
            h4 = (h2 ^ (int)((uint)h4 >> 19)) * -1578923117;
            return new[] { h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1 };
        }
    }

    /// <summary>Build a generator from a seed string.</summary>
    public static Sfc32 Create(string seed)
    {
        int[] s = Cyrb128(seed);
        return new Sfc32(s[0], s[1], s[2], s[3]);
    }
}

/// <summary>
/// An sfc32 generator over four state words. Each call returns a double in [0, 1).
/// </summary>
/// <remarks>
/// Stateful by nature, and deliberately not thread-safe: two threads sharing one instance would
/// interleave their draws and destroy reproducibility, which is the whole point of it.
/// </remarks>
public sealed class Sfc32
{
    private int _a;
    private int _b;
    private int _c;
    private int _d;

    public Sfc32(int a, int b, int c, int d)
    {
        _a = a;
        _b = b;
        _c = c;
        _d = d;
    }

    /// <summary>The next double in [0, 1).</summary>
    public double Next()
    {
        unchecked
        {
            int t = _a + _b;
            _a = _b ^ (int)((uint)_b >> 9);
            _b = _c + (_c << 3);
            _c = (_c << 21) | (int)((uint)_c >> 11);
            _d = _d + 1;
            t = t + _d;
            _c = _c + t;
            return (uint)t / 4294967296.0;
        }
    }
}
