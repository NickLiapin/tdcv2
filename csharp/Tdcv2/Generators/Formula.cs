using System.Globalization;
using Tdcv2.Expr;
using Tdcv2.Stats;
using Distributions = Tdcv2.Stats.Distribution;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="formula" expr="Weight / (Height * Height)"&gt;</c> — arithmetic over the
/// columns beside it.
/// </summary>
/// <remarks>
/// <para>A whole COLUMN read from other columns, like <c>running</c> and <c>stat</c>, but unlike
/// them it needs only its OWN row: row nine million is <c>Weight[9M] / Height[9M]²</c> and nothing
/// before it. So it streams and it parallelises, where a running total cannot.</para>
///
/// <para>Two rules decide what a cell holds, and both are the ones <c>stat</c> already follows:
/// without <c>decimals=</c> the value is printed whole, with it the answer is rounded; and a
/// source cell that is EMPTY makes the answer empty. A cell a <c>parent=</c> filter switched off
/// is not a zero, and <c>0 / 0</c> is not the honest reading of it.</para>
/// </remarks>
internal static class Formula
{
    /// <summary>What one row's evaluation read, so a refusal can point at the cause.</summary>
    internal sealed class ColumnsRead
    {
        /// <summary>A referenced column was empty on this row.</summary>
        internal bool Empty { get; set; }

        /// <summary>The first column that held TEXT rather than a number, and what it held.</summary>
        internal (string Name, string Value)? Text { get; set; }
    }

    /// <summary><c>expr=</c>, which a formula cannot do without.</summary>
    internal static string ExpressionOf(IReadOnlyDictionary<string, string> attrs)
    {
        string source = (attrs.GetValueOrDefault("expr") ?? "").Trim();
        if (source.Length == 0)
        {
            throw new ArgumentException("<gen type=\"formula\"> needs expr=\"…\"");
        }

        return source;
    }

    /// <summary><c>decimals=</c> when the config declared one, else the value is printed whole.</summary>
    internal static int? DecimalsOf(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("decimals") ?? "").Trim();
        if (raw.Length == 0)
        {
            return null;
        }

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            || value < 0 || value > 10)
        {
            throw new ArgumentException($"decimals=\"{raw}\" is not a whole number from 0 to 10");
        }

        return value;
    }

    /// <summary>One evaluated answer, as the text that goes in the cell.</summary>
    /// <remarks>
    /// NaN is how "arithmetic on text" arrives here. In an <c>if=</c> it merely makes every
    /// comparison false and the branch quietly does not fire; in a COLUMN it would print, and a
    /// file full of <c>NaN</c> nobody was warned about is the defect this project keeps closing.
    /// So it is refused — and the refusal names the column that held the text, because the scope
    /// recorded what the expression actually read.
    /// </remarks>
    internal static string Render(object? value, int? decimals, ColumnsRead read)
    {
        switch (value)
        {
            // A whole number is printed from the integer it still is: going through a double
            // would undo the exactness the expression language worked to keep.
            case long n:
                return decimals is null
                    ? n.ToString(CultureInfo.InvariantCulture)
                    : Distributions.ToFixed(n, decimals.Value);
            case bool on:
                return on ? "true" : "false";
            case double d when double.IsNaN(d):
                throw new ArgumentException(read.Text is { } t
                    ? $"the expression is not a number: column \"{t.Name}\" holds \"{t.Value}\", "
                      + "which is text rather than a number"
                    : "the expression has no number as its answer — 0/0, the square root of a "
                      + "negative, or another sum with no value");
            case double d when double.IsInfinity(d):
                throw new ArgumentException(
                    $"the expression is {(d > 0 ? "Infinity" : "-Infinity")} — a division by "
                    + "zero, the logarithm of zero, or a value past the range a number can hold");
            case double d:
                return decimals is null
                    ? Numbers.ToText(d)
                    : Distributions.ToFixed(d, decimals.Value);
            // Text. A formula is allowed to produce it — `expr="Age > 65 ? senior : adult"` is a
            // label, and labels are half of what a data-science config builds. `decimals=` says
            // nothing about a label, so it is left alone rather than forced through a number.
            case string text:
                return text;
            default:
                return "";
        }
    }

    /// <summary>One row's answer, or <c>null</c> when a column it read was empty.</summary>
    /// <remarks>
    /// <c>Has</c> and <c>Value</c> stay separate for the same reason they do in a condition: an
    /// absent name is not an empty one. A name the registry does not know is its own text — that
    /// is what lets <c>if="Gender == Male"</c> go unquoted — so only a name it DOES know can make
    /// the row empty.
    /// </remarks>
    internal static string? ValueAtRow(
        string source,
        int? decimals,
        int row,
        Func<string, bool> hasColumn,
        Func<string, string?> valueAt)
    {
        var read = new ColumnsRead();
        bool Has(string name) => name == "_count" || hasColumn(name);
        string Value(string name)
        {
            if (name == "_count")
            {
                return (row + 1).ToString(CultureInfo.InvariantCulture);
            }

            string cell = valueAt(name) ?? "";
            if (hasColumn(name))
            {
                if (cell.Trim().Length == 0)
                {
                    read.Empty = true;
                }
                else if (read.Text is null && !DistParams.IsPlainNumber(cell))
                {
                    read.Text = (name, cell);
                }
            }

            return cell;
        }

        object? answer = Evaluate.AsValue(source, Has, Value);
        return read.Empty ? null : Render(answer, decimals, read);
    }
}
