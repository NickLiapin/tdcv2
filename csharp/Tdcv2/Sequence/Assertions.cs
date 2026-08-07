using Tdcv2.Expr;
using Tdcv2.Model;

namespace Tdcv2.Sequence;

/// <summary>
/// <c>&lt;assert that="Rows == 700" says="…"/&gt;</c> — a config that checks its own output.
/// </summary>
/// <remarks>
/// <para>
/// What is worth asserting is not what the config already states. You wrote
/// <c>percent="70"</c> and you assert 70 percent — you have tested that TDC can count. What the
/// config does NOT state is where the value ends up: a <c>parent=</c> filter removes rows, a
/// second condition removes more, and the share that reaches the file is 42 percent with nothing
/// to say so.
/// </para>
/// <para>
/// Three existing mechanisms, no new language: <c>that=</c> is the <c>if=</c> expression language,
/// the numbers come from <c>&lt;gen type="stat"&gt;</c>, and <c>says=</c> is the sentence a reader
/// gets in a CI log months later.
/// </para>
/// <para>
/// Every name the expression reads must be WHOLE-RUN CONSTANT, or <c>Amount &gt; 100</c> reads row
/// 0 and reports on one row out of a thousand — a check that passed because it barely looked,
/// wearing a badge that says verified. Which names an expression reads is discovered by handing the
/// evaluator a scope that records what it is asked for, so no parser knows this feature exists.
/// </para>
/// </remarks>
public static class Assertions
{
    /// <summary>
    /// Built-ins an assertion may read. <c>_count</c> is deliberately absent: it says which row you
    /// are on, which is what an assertion must not depend on.
    /// </summary>
    private static readonly string[] WholeRunBuiltins = { "_total" };

    /// <summary>Attributes that make a cell which may or may not be there.</summary>
    private static readonly string[] Unsettling = { "missing", "anomaly", "if", "repeat" };

    /// <summary>A run whose output did not hold up its own config's claim.</summary>
    public sealed class AssertionFailed : InvalidOperationException
    {
        internal AssertionFailed(string message)
            : base(message)
        {
        }
    }

    /// <summary>What reading the column found.</summary>
    private enum Constancy
    {
        Constant,
        Varies,
        EmptyOnSomeRows,
    }

    /// <summary>
    /// Check every assertion against the finished run, throwing on the first that does not hold.
    /// </summary>
    /// <remarks>
    /// <paramref name="valueAt"/> and <paramref name="known"/> come from the engine, because a
    /// column is an array on one engine and a function of the row on another — and an assertion has
    /// to mean the same thing on both.
    /// </remarks>
    public static void Check(
        Config config, Func<string, int, string?> valueAt, Func<string, bool> known)
    {
        if (config.Asserts.Count == 0)
        {
            return;
        }

        var bySpec = new Dictionary<string, SequenceSpec>(StringComparer.Ordinal);
        foreach (SequenceSpec spec in config.Sequences)
        {
            if (!string.IsNullOrEmpty(spec.Name))
            {
                bySpec[spec.Name] = spec;
            }
        }

        int count = Math.Max(config.Count, 0);
        foreach (AssertSpec assertion in config.Asserts)
        {
            var scope = new Recording(valueAt, known);
            bool held;
            try
            {
                held = Evaluate.AsCondition(assertion.That, scope);
            }
            catch (Exception e) when (e is not AssertionFailed)
            {
                throw new AssertionFailed(
                    $"assert: cannot read \"{assertion.That}\" — {e.Message}");
            }

            // The honesty rule, applied to every name the expression touched. The evaluator walks
            // both sides of `&&` rather than short-circuiting — in all five implementations, since
            // they share this walk — so which names are checked does not depend on operand order.
            foreach ((string name, string _) in scope.Read)
            {
                bySpec.TryGetValue(name, out SequenceSpec? declared);
                Constancy constancy = Measure(name, valueAt, declared, count);
                if (constancy == Constancy.Constant)
                {
                    continue;
                }

                string why = constancy == Constancy.Varies
                    ? $"\"{name}\" is not the same on every row, so this would have checked the "
                        + "first row and called the run verified"
                    : $"\"{name}\" is empty on some rows, so the run has no single value for it — "
                        + "this would have checked whatever the first row happened to hold";
                throw new AssertionFailed(
                    $"assert (\"{assertion.That}\"): {why}. An assertion reads whole-run values: "
                    + $"give it a <gen type=\"stat\" of=\"{name}\" op=\"…\"/> column, or _total.");
            }

            if (!held)
            {
                string detail = string.Join(
                    ", ",
                    scope.Read.Select(r =>
                        $"{r.Name} = {(r.Value.Length == 0 ? "(empty)" : r.Value)}"));
                string shown = detail.Length == 0
                    ? assertion.That
                    : $"{assertion.That}   with {detail}";
                throw new AssertionFailed($"assert failed: {assertion.Says}\n  {shown}");
            }
        }
    }

    /// <summary>
    /// Constant from the SPEC alone, without reading a single row.
    /// </summary>
    /// <remarks>
    /// Reading the column is the honest test and stays below, but it costs a pass over the run —
    /// and on a streaming engine that pass regenerates every value. Measured at two million rows it
    /// cost a third of a second per name, which at a billion rows is minutes spent proving what the
    /// spec already said. So this runs first and, like the <c>uniq</c> capacity check, only ever
    /// answers "definitely constant": anything it cannot prove falls through to the scan, so no
    /// config is refused that would have been accepted.
    /// </remarks>
    private static bool ConstantByConstruction(SequenceSpec? spec)
    {
        Gen? gen = spec?.Gen;
        if (gen is null)
        {
            return false; // a compound, a mix, a switch — read it
        }

        if (spec!.Parent is not null)
        {
            return false; // a filtered column is empty on the rows the filter excluded
        }

        if (Unsettling.Any(attr => gen.Attrs.ContainsKey(attr)))
        {
            return false;
        }

        return gen.Type switch
        {
            "stat" => true, // one number for the whole run, by definition
            "text" => gen.Attrs.TryGetValue("value", out string? raw) && !raw.Contains(','),
            _ => false,
        };
    }

    /// <summary>Whether this column holds one and the same value on every row of the run.</summary>
    /// <remarks>
    /// An EMPTY cell fails the rule as surely as a different one: a column a <c>parent=</c> filter
    /// leaves blank on half the run has no whole-run value at all, and the condition would compare
    /// against whatever row 0 happened to hold.
    /// </remarks>
    private static Constancy Measure(
        string name, Func<string, int, string?> valueAt, SequenceSpec? spec, int count)
    {
        if (WholeRunBuiltins.Contains(name) || ConstantByConstruction(spec))
        {
            return Constancy.Constant;
        }

        string? seen = null;
        for (int row = 0; row < count; row++)
        {
            string value = valueAt(name, row) ?? "";
            if (value.Length == 0)
            {
                return Constancy.EmptyOnSomeRows;
            }

            if (seen is null)
            {
                seen = value;
            }
            else if (!string.Equals(seen, value, StringComparison.Ordinal))
            {
                return Constancy.Varies;
            }
        }

        return seen is null ? Constancy.EmptyOnSomeRows : Constancy.Constant;
    }

    /// <summary>
    /// A scope that answers from row 0 and remembers every real column it was asked for — the whole
    /// discovery mechanism, and the reason no parser changes.
    /// </summary>
    private sealed class Recording : Evaluate.IScope
    {
        private readonly Func<string, int, string?> _valueAt;
        private readonly Func<string, bool> _known;

        internal Recording(Func<string, int, string?> valueAt, Func<string, bool> known)
        {
            _valueAt = valueAt;
            _known = known;
        }

        internal List<(string Name, string Value)> Read { get; } = new();

        public bool Has(string name) => _known(name);

        public string Value(string name)
        {
            string found = _valueAt(name, 0) ?? "";
            // Only a real column is recorded. A name that is not declared is not data at all — the
            // expression language reads it as its own literal text, which is what lets `Kind == a`
            // go unquoted — so it has nothing to be constant about, and the validator is the one
            // that asks whether it was a typo.
            if (_known(name) && !Read.Any(r => string.Equals(r.Name, name, StringComparison.Ordinal)))
            {
                Read.Add((name, found));
            }

            return found;
        }
    }
}
