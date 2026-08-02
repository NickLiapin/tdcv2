using System.Globalization;
using System.Numerics;

namespace Tdcv2.Compute;

/// <summary>
/// <c>&lt;encode as="..."&gt;</c> — one character to a number.
/// </summary>
/// <remarks>
/// <para>
/// The step every alphanumeric check digit needs: an IBAN turns letters into numbers before it takes
/// its mod 97, a vehicle identification number folds letters into digits before weighting.
/// </para>
/// <para>
/// For <c>base36</c>, <c>ascii</c> and <c>unicode</c> the result is the character's <em>decimal</em>
/// value, so <c>A</c> under base36 is the string <c>"10"</c> and a fold then consumes those digits.
/// For <c>hex</c>, <c>binary</c> and <c>octal</c> it is the code point written in that base.
/// </para>
/// <para>
/// A character means one Unicode code point, never one UTF-16 unit — the rest of the layer iterates
/// strings by code point, and an encoding that disagreed would split an emoji in half.
/// </para>
/// </remarks>
public static class Encode
{
    public static string EncodeChar(string ch, string @as) => @as switch
    {
        "base36" => Base36Value(ch).ToString(CultureInfo.InvariantCulture),
        "ascii" => AsciiValue(ch),
        "unicode" => CodePointOf(ch).ToString(CultureInfo.InvariantCulture),
        "hex" => ToBase(CodePointOf(ch), 16),
        "binary" => ToBase(CodePointOf(ch), 2),
        "octal" => ToBase(CodePointOf(ch), 8),
        _ => throw new ComputeError(
            $"<encode as=\"{@as}\">: unknown encoding "
            + "(base36, ascii, unicode, hex, binary, octal)"),
    };

    private static string AsciiValue(string ch)
    {
        int cp = CodePointOf(ch);
        if (cp >= 128)
        {
            throw new ComputeError(
                $"<encode as=\"ascii\">: \"{ch}\" is not an ASCII character (code >= 128)");
        }

        return cp.ToString(CultureInfo.InvariantCulture);
    }

    internal static int CodePointOf(string ch)
    {
        if (ch.Length == 0
            || (char.IsHighSurrogate(ch[0]) ? ch.Length != 2 : ch.Length != 1))
        {
            throw new ComputeError($"<encode>: expected a single character, got \"{ch}\"");
        }

        return char.ConvertToUtf32(ch, 0);
    }

    /// <summary>0-9 to 0..9, and either case of A-Z to 10..35.</summary>
    private static int Base36Value(string ch)
    {
        int cp = CodePointOf(ch);
        if (cp >= '0' && cp <= '9')
        {
            return cp - '0';
        }

        if (cp >= 'A' && cp <= 'Z')
        {
            return cp - 'A' + 10;
        }

        if (cp >= 'a' && cp <= 'z')
        {
            return cp - 'a' + 10;
        }

        throw new ComputeError($"<encode as=\"base36\">: \"{ch}\" is not a digit or letter");
    }

    /// <summary>Lower-case digits, as <c>Integer.toString(n, radix)</c> and <c>n.toString(radix)</c> both write them.</summary>
    private static string ToBase(int value, int radix)
    {
        if (value == 0)
        {
            return "0";
        }

        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        var big = new BigInteger(Math.Abs(value));
        var text = new Stack<char>();
        while (!big.IsZero)
        {
            text.Push(digits[(int)(big % radix)]);
            big /= radix;
        }

        return (value < 0 ? "-" : "") + new string(text.ToArray());
    }
}
