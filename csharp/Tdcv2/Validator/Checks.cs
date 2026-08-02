using System.Text.RegularExpressions;
using Tdcv2.Date;
using Tdcv2.Format;
using Tdcv2.Generators;
using Tdcv2.Unicode;

namespace Tdcv2.Validation;

/// <summary>
/// The per-generator rules, kept apart from the structural ones so neither file grows unreadable.
/// </summary>
/// <remarks>
/// Most of these work by handing the attribute to the generator's own parser and reporting what it
/// says. That is deliberate: a validator with its own idea of what a valid range looks like drifts
/// from the generator that actually reads it, and then a config passes validation and fails at run
/// time — the worst of both.
/// </remarks>
internal static class Checks
{
    /// <summary>Names the engine owns; a sequence may not claim one.</summary>
    internal static readonly IReadOnlySet<string> Builtins =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "_count", "_first", "_last", "_total", "_item", "_item_id",
        };

    /// <summary>Attributes a named distribution replaces, so carrying both is a contradiction.</summary>
    internal static readonly IReadOnlyList<string> DistributionConflicts =
        new[] { "value", "percent", "length", "include", "exclude" };

    private static readonly Regex WholeNumber = new(@"^\d+$", RegexOptions.Compiled);
    private static readonly Regex NumberRange = new(@"^\d+\s*-\s*\d+$", RegexOptions.Compiled);

    internal static bool IsBuiltin(string name) => Builtins.Contains(name);

    /// <summary><c>null</c> when the pattern parses under the finite subset.</summary>
    internal static string? RegexProblem(string pattern, int maxLength) =>
        Attempt(() => RegexGen.Compile(pattern, maxLength));

    internal static string? AdvancedRegexProblem(string pattern, int maxLength) =>
        Attempt(() => AdvancedRegexGen.Compile(pattern, maxLength));

    internal static string? NumberRangeProblem(string value) =>
        Attempt(() => NumberGen.ParseRanges(value));

    internal static bool IsKnownAlphabet(string name) => Alphabets.Chars(name) is not null;

    internal static bool IsKnownDateLocale(string name) => DateLocales.IsKnown(name);

    internal static bool IsKnownFilter(string name) => Transforms.IsFilterName(name);

    internal static IReadOnlyList<string> AlphabetNames() => Alphabets.Names();

    internal static bool IsBooleanText(string raw) => raw is "true" or "false";

    /// <summary>A length is a positive integer, a <c>min-max</c> range, or a comma-separated list of those.</summary>
    internal static bool IsValidLength(string raw)
    {
        foreach (string part in raw.Split(','))
        {
            string p = part.Trim();
            if (!WholeNumber.IsMatch(p) && !NumberRange.IsMatch(p))
            {
                return false;
            }

            foreach (string n in p.Split('-'))
            {
                if (!int.TryParse(n.Trim(), out int value) || value <= 0)
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>Generator types on which <c>repeat=</c> is refused, and why.</summary>
    internal static string? RepeatUnsupportedReason(string? type) => type switch
    {
        "increment" or "decrement" or "timeseries" or "pattern" =>
            "its value depends on the row index, which a variable-length list makes unknowable",
        _ => null,
    };

    internal static bool HasRepeat(IReadOnlyDictionary<string, string> attrs) =>
        Repeat.Parse(attrs) is not null;

    /// <summary>Run a parser purely to hear its complaint; the value it would build is not wanted.</summary>
    private static string? Attempt(Action parse)
    {
        try
        {
            parse();
            return null;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException
                                      or FormatException or OverflowException)
        {
            return e.Message;
        }
    }
}
