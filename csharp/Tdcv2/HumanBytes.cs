namespace Tdcv2;

/// <summary>
/// A byte count written the way a person would say it: <c>800 B</c>, <c>2.6 KB</c>,
/// <c>123 KB</c>, <c>20.5 GB</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> Every one of the 294 shipped packs is smaller than a quarter of a
/// megabyte — the largest is 248 KB and 120 are under 10 KB. Printed in megabytes to one decimal,
/// as <c>pack list</c> did, the whole catalogue collapsed into three strings: <c>0.0 MB</c> for
/// 194 packs, <c>0.1 MB</c> for 53, <c>0.2 MB</c> for the last 47. A size that cannot tell two
/// packs apart is not a size, it is a decoration; and <c>0.0</c> actively misinforms, because it
/// reads as "nothing" when the honest answer is "three kilobytes".
/// </para>
/// <para>The rules are the ones people already read without noticing:</para>
/// <list type="bullet">
///   <item>below a kilobyte, whole bytes — <c>800 B</c>, never <c>0.8 KB</c></item>
///   <item>
///     below a hundred of a unit, one decimal — <c>2.6 KB</c> distinguishes packs that
///     <c>3 KB</c> does not
///   </item>
///   <item>
///     at a hundred and above, whole numbers — <c>123 KB</c>, because a tenth of a kilobyte there
///     is noise
///   </item>
/// </list>
/// <para>
/// <b>Why the arithmetic looks like this.</b> All five implementations must produce the same
/// string for the same number: a shared CLI fixture compares their output byte for byte, so a size
/// that differs in the last digit is a five-way parity failure. Hence integers throughout — no
/// float division, no format specifier, and no reliance on how a language happens to round a half.
/// </para>
/// </remarks>
public static class HumanBytes
{
    /// <summary>Kilobyte upwards. Terabytes are the end of it; nothing here measures more.</summary>
    private static readonly string[] Units = { "KB", "MB", "GB", "TB" };

    /// <summary>
    /// <c>round(n * 10 / d)</c>, without ever forming <c>n * 10</c> — the product overflows a
    /// <c>long</c> above about 800 petabytes. Splitting the division is exact for every size any of
    /// the five will be handed.
    /// </summary>
    private static long Tenths(long n, long d)
    {
        long whole = n / d;
        long rest = n - (whole * d);
        return (whole * 10) + (((rest * 10) + (d / 2)) / d);
    }

    public static string Format(long bytes)
    {
        if (bytes <= 0)
        {
            return "0 B";
        }

        if (bytes < 1024)
        {
            return bytes + " B";
        }

        // Climb to the unit the number reads in, and one further when rounding has
        // pushed it to a whole 1024 of that unit — 1023.6 KB is 1.0 MB, and nobody
        // writes the other one.
        long d = 1024;
        string unit = Units[0];
        long t = Tenths(bytes, d);
        for (int next = 1; next < Units.Length; next++)
        {
            if (bytes < d * 1024 && t < 10_235)
            {
                break;
            }

            d *= 1024;
            unit = Units[next];
            t = Tenths(bytes, d);
        }

        return t < 1000
            ? (t / 10) + "." + (t % 10) + " " + unit
            : ((t + 5) / 10) + " " + unit;
    }
}
