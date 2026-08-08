using System.Globalization;

namespace Tdcv2.Expr;

/// <summary>
/// The key two TEXTS share when <c>==</c> calls them equal.
/// </summary>
/// <remarks>
/// <para><c>==</c> between two texts has one rule that is not plain string equality: if both read
/// as whole numbers, they are compared as whole numbers. So <c>"01" == "1"</c> is true, and
/// <c>"0" == "00"</c> is true.</para>
/// <para>Most of the engine never needs this, because it evaluates the expression. Two places do
/// not evaluate it and must still agree with it: a <c>&lt;gen type="pool" filter="field ==
/// Column"&gt;</c> is BUCKETED, so a row costs a map lookup instead of a walk over every member;
/// and TDC225 asks, before the run, whether the two sides can ever overlap.</para>
/// <para>Both compared raw text, and both were therefore wrong about the same configs. Measured on
/// a pool whose <c>code</c> holds <c>01,02,03</c> against a column producing <c>1,2,3</c>,
/// <c>filter="code == Want"</c> was REFUSED by check as unmatchable while
/// <c>filter="code == Want &amp;&amp; 1 == 1"</c> — the same question with one term that changes
/// nothing — matched every row.</para>
/// </remarks>
internal static class MatchKey
{
    /// <summary>
    /// <c>"01"</c> and <c>"1"</c> share the key <c>"1"</c>; <c>"1.0"</c> and <c>"1"</c> do not,
    /// because <c>==</c> between two texts does not read a decimal point either.
    /// </summary>
    public static string Of(string value)
    {
        string body = value.Length > 0 && (value[0] == '+' || value[0] == '-')
            ? value[1..]
            : value;
        if (body.Length == 0)
        {
            return value;
        }

        foreach (char c in body)
        {
            if (c < '0' || c > '9')
            {
                return value;
            }
        }

        // Outside the exact domain the evaluator stops treating it as a whole number, and so
        // does this.
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long n)
            ? n.ToString(CultureInfo.InvariantCulture)
            : value;
    }
}
