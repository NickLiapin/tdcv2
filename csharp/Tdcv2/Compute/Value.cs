using System.Numerics;
using System.Text.RegularExpressions;

namespace Tdcv2.Compute;

/// <summary>Anything the compute layer refuses to do, with the reason it refused.</summary>
public sealed class ComputeError : Exception
{
    public ComputeError(string message)
        : base(message)
    {
    }
}

/// <summary>
/// The value model of the compute layer: three types, and no more.
/// </summary>
/// <remarks>
/// <para>
/// An integer, a string, or a list of those. No boolean and no floating point — deliberately. Every
/// check digit in the world is integer arithmetic over the characters of a string, and a float in
/// that computation is a way to get the wrong answer on one number in a million and never find out
/// which.
/// </para>
/// <para>
/// Integers are arbitrary precision but range-checked to signed 64 bits, so an overflow is the same
/// deterministic error in every implementation rather than a silent wrap in whichever one has 64-bit
/// ints.
/// </para>
/// </remarks>
public abstract record Value
{
    public sealed record Int(BigInteger V) : Value;

    public sealed record Str(string V) : Value;

    public sealed record Lst(IReadOnlyList<Value> V) : Value;

    private static readonly BigInteger Int64Min = long.MinValue;
    private static readonly BigInteger Int64Max = long.MaxValue;

    private static readonly Regex IntegerText = new("^-?[0-9]+$", RegexOptions.Compiled);

    public static Value Of(BigInteger v) => new Int(Guard64(v));

    public static Value Of(long v) => new Int(v);

    public static Value Of(string v) => new Str(v);

    public static Value Of(IReadOnlyList<Value> v) => new Lst(v.ToArray());

    public static BigInteger Guard64(BigInteger v)
    {
        if (v < Int64Min || v > Int64Max)
        {
            throw new ComputeError(
                $"integer overflow: {v} is outside the signed 64-bit range");
        }

        return v;
    }

    /// <summary>
    /// Coerce to an integer for arithmetic.
    /// </summary>
    /// <remarks>
    /// A <em>single</em> digit character coerces, because iterating a string yields characters and
    /// summing them is the whole point. A multi-digit string does not: <c>"12"</c> in an arithmetic
    /// slot is far more often a mistake than an intention, so it has to say <c>&lt;to_number&gt;</c>
    /// out loud.
    /// </remarks>
    public static BigInteger AsInt(Value value, string context = "arithmetic")
    {
        switch (value)
        {
            case Int i:
                return i.V;
            case Str s:
            {
                if (s.V.Length == 1 && s.V[0] >= '0' && s.V[0] <= '9')
                {
                    return BigInteger.Parse(s.V);
                }

                string hint = IntegerText.IsMatch(s.V)
                    ? " — wrap it in <to_number> to convert a multi-digit string"
                    : "";
                throw new ComputeError(
                    $"expected an integer in {context}, got the string \"{s.V}\"{hint}");
            }

            default:
                throw new ComputeError($"expected an integer in {context}, got a list");
        }
    }

    /// <summary>An int or a string renders to text. A list never does.</summary>
    public static string AsStr(Value value) => value switch
    {
        Str s => s.V,
        Int i => i.V.ToString(),
        _ => throw new ComputeError("cannot use a list where a string is expected"),
    };

    public static string ToOutput(Value value)
    {
        if (value is Lst)
        {
            throw new ComputeError("compute result must be an int or str, not a list");
        }

        return AsStr(value);
    }

    public static BigInteger ParseIntStrict(string s)
    {
        if (!IntegerText.IsMatch(s))
        {
            throw new ComputeError($"<to_number>: \"{s}\" is not a valid integer");
        }

        return Guard64(BigInteger.Parse(s));
    }

    /// <summary>
    /// Euclidean remainder — always in <c>[0, |b|)</c>.
    /// </summary>
    /// <remarks>
    /// Not the host language's <c>%</c>: C#, Java and JavaScript all give a negative remainder for a
    /// negative dividend, Python does not, and a check digit computed with the wrong sign convention
    /// is wrong only for some inputs. Pinning it here makes every implementation agree.
    /// </remarks>
    public static BigInteger Mod(BigInteger a, BigInteger b)
    {
        if (b.IsZero)
        {
            throw new ComputeError("<mod>: the modulus (second child) must not be zero");
        }

        BigInteger m = BigInteger.Abs(b);
        BigInteger r = a % m;
        return r.Sign < 0 ? r + m : r;
    }

    /// <summary>Integer division that rounds toward negative infinity.</summary>
    public static BigInteger FloorDiv(BigInteger a, BigInteger b)
    {
        if (b.IsZero)
        {
            throw new ComputeError("<divide>: the divisor (second child) must not be zero");
        }

        BigInteger q = BigInteger.DivRem(a, b, out BigInteger r);
        if (!r.IsZero && a.Sign < 0 != b.Sign < 0)
        {
            q -= BigInteger.One;
        }

        return q;
    }
}
