using System.Globalization;

namespace Tdcv2.Distribution;

/// <summary>Which way a percent mask is wrong.</summary>
/// <remarks>
/// Three different mistakes, and each gets its own diagnostic code: a mask with the wrong number
/// of entries, one holding something that is not a share, and one whose shares do not add up.
/// They call for three different fixes, and one code for all of them would say only that the mask
/// is wrong.
/// </remarks>
public enum MaskKind
{
    Length,
    Number,
    Sum,
}

/// <summary>A percent mask that cannot be used, and the reason in a form a caller can branch on.</summary>
public sealed class MaskException : ArgumentException
{
    public MaskException(string message, MaskKind kind)
        : base(message) => Kind = kind;

    public MaskKind Kind { get; }
}

/// <summary>
/// Reads a <c>percent="..."</c> mask into one number per value.
/// </summary>
/// <remarks>
/// <para>
/// A mask does not have to be complete. Blank entries share whatever is left of 100 evenly, so
/// <c>percent="50"</c> across three values means "50, then split the rest" rather than an error —
/// which is what makes it usable when only one share actually matters to the config.
/// </para>
/// <para>
/// Where the blanks go depends on the mask: a leading comma pins the first entry and pads after
/// it, so <c>percent="10,,20"</c> and <c>percent=",20"</c> land differently on purpose.
/// </para>
/// </remarks>
public static class PercentMask
{
    private const double Tolerance = 0.0001;

    public static double[] Expand(string mask, int valueCount)
    {
        if (valueCount <= 0)
        {
            throw new ArgumentException("percent mask requires at least one value");
        }

        IReadOnlyList<string> parts = Normalize(mask, valueCount);

        var fixedShares = new double[parts.Count];
        var blanks = new List<int>();
        double fixedSum = 0;
        for (int i = 0; i < parts.Count; i++)
        {
            string part = parts[i];
            if (part.Length == 0)
            {
                blanks.Add(i);
                continue;
            }

            if (!double.TryParse(part, NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
                || n < 0 || double.IsInfinity(n) || double.IsNaN(n))
            {
                throw new MaskException(
                    "percent contains a non-numeric or negative value", MaskKind.Number);
            }

            fixedShares[i] = n;
            fixedSum += n;
        }

        if (fixedSum > 100 + Tolerance)
        {
            throw new MaskException(
                $"percent values sum to {fixedSum}, expected <= 100", MaskKind.Sum);
        }

        if (blanks.Count == 0)
        {
            if (Math.Abs(fixedSum - 100) > Tolerance)
            {
                throw new MaskException(
                    $"percent values sum to {fixedSum}, expected 100", MaskKind.Sum);
            }

            return fixedShares;
        }

        double remainder = (100 - fixedSum) / blanks.Count;
        foreach (int idx in blanks)
        {
            fixedShares[idx] = remainder;
        }

        return fixedShares;
    }

    private static IReadOnlyList<string> Normalize(string mask, int valueCount)
    {
        var parts = mask.Split(',').Select(s => s.Trim()).ToList();
        if (parts.Count > valueCount)
        {
            throw new MaskException(
                $"percent has {parts.Count} entries but value has {valueCount}", MaskKind.Length);
        }

        int missing = valueCount - parts.Count;
        if (missing == 0)
        {
            return parts;
        }

        var result = new List<string>();
        if (mask.TrimStart().StartsWith(",", StringComparison.Ordinal))
        {
            // A leading comma means the first entry is anchored and the padding follows it.
            result.Add(parts[0]);
            for (int i = 0; i < missing; i++)
            {
                result.Add("");
            }

            result.AddRange(parts.Skip(1));
        }
        else
        {
            result.AddRange(parts);
            for (int i = 0; i < missing; i++)
            {
                result.Add("");
            }
        }

        return result;
    }
}
