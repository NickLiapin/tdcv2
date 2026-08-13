using System.Globalization;

namespace Tdcv2.Stats;

/// <summary>How a number becomes text when nothing asked for a particular shape.</summary>
/// <remarks>
/// The reference writes <c>String(x)</c> and the four ports each imitate it. Shared here rather
/// than copied, because a formula, a statistic and a distribution parameter all print an answer
/// and the three must agree — a whole number without a point, everything else round-tripped.
/// </remarks>
public static class Numbers
{
    /// <summary>A double as JavaScript prints it — a whole number without a decimal point.</summary>
    public static string ToText(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value) || value != Math.Floor(value)
            || Math.Abs(value) >= 9.2233720368547758e18)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        return ((long)value).ToString(CultureInfo.InvariantCulture);
    }
}
