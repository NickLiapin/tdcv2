using System.Globalization;
using Tdcv2.Expr;

namespace Tdcv2.Stats;

/// <summary>
/// A distribution parameter written as an EXPRESSION rather than a number.
/// </summary>
/// <remarks>
/// <para><c>lambda="Traffic * 0.5"</c> is an intensity driven by another column;
/// <c>sd="0.5 + 0.01 * _count"</c> is a sensor that grows noisier as the run goes on. A bare
/// number stays the ordinary case and costs nothing — the spec is parsed once, exactly as before,
/// and only a config that names a column comes here.</para>
///
/// <para>Why this is allowed at all, when a per-row <c>repeat=</c> is not: how many uniform draws
/// a row consumes depends on WHICH distribution, never on its parameters. The parameter changes
/// the value the draws are turned into, not their number, so the row stays computable without its
/// predecessors — the property every engine is built on.</para>
/// </remarks>
public static class DistParams
{
    /// <summary>Every parameter any of the nine distributions reads.</summary>
    public static readonly string[] Params =
    {
        "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale", "lambda",
        "beta", "s", "n", "min", "max",
    };

    /// <summary>The two distributions sampled from a PAIR of uniforms; every other reads one.</summary>
    private static readonly HashSet<string> TwoDraw =
        new(StringComparer.Ordinal) { "normal", "lognormal" };

    /// <summary>The attributes with every expression-valued parameter replaced by its answer.</summary>
    /// <param name="Attrs">The generator's attributes, resolved.</param>
    /// <param name="Empty">A referenced column was empty on this row, so nothing can be drawn.</param>
    public sealed record Resolved(IReadOnlyDictionary<string, string> Attrs, bool Empty);

    /// <summary>Digits, a point, a sign, an exponent — anything a plain number can be.</summary>
    public static bool IsPlainNumber(string text) =>
        double.TryParse(
            text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
        && !double.IsNaN(v) && !double.IsInfinity(v);

    /// <summary>The parameters this generator wrote as an expression rather than a number.</summary>
    public static IReadOnlyList<string> ExpressionParams(IReadOnlyDictionary<string, string> attrs)
        => Params
            .Where(name => attrs.TryGetValue(name, out string? raw)
                && raw.Trim().Length > 0
                && !IsPlainNumber(raw))
            .ToArray();

    /// <summary>How many uniforms a row of this distribution spends, known from the NAME alone.</summary>
    /// <remarks>
    /// Wanted by a row that cannot be drawn at all — a parameter read an empty cell — which must
    /// still spend what a drawn row would. Otherwise blanking one cell would slide every value
    /// after it, and a <c>parent=</c> filter would quietly rewrite the rest of the column.
    /// </remarks>
    public static int Draws(IReadOnlyDictionary<string, string> attrs) =>
        TwoDraw.Contains((attrs.GetValueOrDefault("distribution") ?? "").Trim().ToLowerInvariant())
            ? 2
            : 1;

    /// <summary><paramref name="attrs"/> with each expression parameter evaluated on this row.</summary>
    /// <remarks>
    /// A name the registry knows, holding nothing, marks the row EMPTY: that is a row a
    /// <c>parent=</c> filter switched off or a <c>missing=</c> blank, and it is not a zero. It has
    /// to be noticed at the LOOKUP, because an unresolved bare word evaluates to the WORD — the
    /// way <c>if="Tier == hi"</c> reads <c>hi</c> — and the two cannot be told apart afterwards.
    /// </remarks>
    public static Resolved Resolve(
        IReadOnlyDictionary<string, string> attrs,
        IReadOnlyList<string> dynamic,
        int row,
        Func<string, bool> hasColumn,
        Func<string, string?> valueAt)
    {
        var result = new Dictionary<string, string>(attrs, StringComparer.Ordinal);
        bool empty = false;

        foreach (string name in dynamic)
        {
            if (!attrs.TryGetValue(name, out string? source))
            {
                continue;
            }

            bool sawEmpty = false;
            (string Name, string Value)? text = null;
            bool Has(string reference) => reference == "_count" || hasColumn(reference);
            string Value(string reference)
            {
                if (reference == "_count")
                {
                    return (row + 1).ToString(CultureInfo.InvariantCulture);
                }

                string cell = valueAt(reference) ?? "";
                if (hasColumn(reference))
                {
                    if (cell.Trim().Length == 0)
                    {
                        sawEmpty = true;
                    }
                    else if (text is null && !IsPlainNumber(cell))
                    {
                        text = (reference, cell);
                    }
                }

                return cell;
            }

            object? answer = Evaluate.AsValue(source, Has, Value);
            empty = empty || sawEmpty;

            string? written = answer switch
            {
                long n => n.ToString(CultureInfo.InvariantCulture),
                double d when !double.IsNaN(d) && !double.IsInfinity(d) => Numbers.ToText(d),
                // A bare column reference resolves to the cell's TEXT — `mean="M"` where M holds
                // "100". Arithmetic would have produced a number, but naming a column and nothing
                // else is the simplest way to write this and must work too.
                string s when IsPlainNumber(s) => s.Trim(),
                _ => null,
            };

            if (written is not null)
            {
                result[name] = written;
            }
            else if (!empty && text is { } held)
            {
                // Nothing numeric came out, and a column is the reason. Say which — the
                // distribution's own message would only repeat that the parameter is "not a
                // number", which the author can already see. Same wording as the formula
                // generator, for the same mistake read from the same columns.
                throw new ArgumentException(
                    $"{name}: the expression is not a number: column \"{held.Name}\" holds "
                    + $"\"{held.Value}\", which is text rather than a number");
            }
        }

        return new Resolved(result, empty);
    }
}
