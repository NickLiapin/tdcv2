using System.Text;
using Tdcv2.Prng;
using Tdcv2.Unicode;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="symbol" .../&gt;</c> — characters, drawn one at a time.
/// </summary>
/// <remarks>
/// The pool comes from either a named <c>alphabet</c> or an inline <c>value</c> set, never both. To
/// pick a whole word from a list, <c>&lt;gen type="text"&gt;</c> is the tag; this one works below the
/// level of words.
/// </remarks>
public static class SymbolGen
{
    private const int DefaultLength = 1;
    private const int MaxLength = 1024;

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng)
    {
        IReadOnlyList<string> chars = ResolveChars(attrs);
        int length = ParseLength(attrs.GetValueOrDefault("length"));

        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            var value = new StringBuilder();
            for (int pos = 0; pos < length; pos++)
            {
                value.Append(Rand.Pick(prng, chars));
            }

            result.Add(value.ToString());
        }

        return result;
    }

    internal static int ParseLength(string? raw)
    {
        if (raw is null)
        {
            return DefaultLength;
        }

        if (!int.TryParse(raw.Trim(), out int value) || value <= 0 || value > MaxLength)
        {
            throw new ArgumentException(
                $"symbol length must be an integer from 1 to {MaxLength}, got \"{raw}\"");
        }

        return value;
    }

    internal static IReadOnlyList<string> ResolveChars(IReadOnlyDictionary<string, string> attrs)
    {
        string? value = BlankToNull(attrs.GetValueOrDefault("value"));
        string? alphabet = BlankToNull(attrs.GetValueOrDefault("alphabet"));

        if (value is not null && alphabet is not null)
        {
            throw new ArgumentException(
                "symbol generator: use either \"value\" (inline set) or \"alphabet\" (named), not both");
        }

        IReadOnlyList<string> baseChars;
        if (value is not null)
        {
            baseChars = CharSet.Parse(value);
            if (baseChars.Count == 0)
            {
                throw new ArgumentException(
                    $"symbol generator: value \"{value}\" produced an empty character set");
            }
        }
        else if (alphabet is not null)
        {
            baseChars = Alphabets.Chars(alphabet)
                ?? throw new ArgumentException(
                    $"unknown alphabet \"{alphabet}\"; known alphabets: "
                    + string.Join(", ", Alphabets.Names()));
        }
        else
        {
            throw new ArgumentException(
                "symbol generator requires \"value\" (inline set like \"abc\" or \"[a-z]\") or "
                + "\"alphabet\" (named); known alphabets: "
                + string.Join(", ", Alphabets.Names()));
        }

        return ApplyIncludeExclude(
            baseChars, attrs.GetValueOrDefault("include"), attrs.GetValueOrDefault("exclude"));
    }

    /// <summary><c>(base ∪ include) − exclude</c>. Exclude is applied last, so it always has the last word.</summary>
    private static IReadOnlyList<string> ApplyIncludeExclude(
        IReadOnlyList<string> baseChars, string? include, string? exclude)
    {
        bool hasInclude = !string.IsNullOrEmpty(include);
        bool hasExclude = !string.IsNullOrEmpty(exclude);
        if (!hasInclude && !hasExclude)
        {
            return baseChars;
        }

        // First-seen order kept, because the set is indexed by a random draw.
        var order = new List<string>(baseChars);
        var seen = new HashSet<string>(baseChars, StringComparer.Ordinal);
        if (hasInclude)
        {
            foreach (string c in CharSet.Parse(include!))
            {
                if (seen.Add(c))
                {
                    order.Add(c);
                }
            }
        }

        if (hasExclude)
        {
            var drop = new HashSet<string>(CharSet.Parse(exclude!), StringComparer.Ordinal);
            order.RemoveAll(drop.Contains);
        }

        if (order.Count == 0)
        {
            throw new ArgumentException(
                "symbol generator: the character set is empty after applying include/exclude");
        }

        return order;
    }

    private static string? BlankToNull(string? s) => string.IsNullOrEmpty(s) ? null : s;
}
