using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;

namespace Tdcv2.Format;

/// <summary>
/// <c>${{Name}}</c> and <c>${{Name|upper|mask:xxx}}</c> inside a <c>&lt;data&gt;</c>.
/// </summary>
/// <remarks>
/// <para>
/// The marker itself is configurable through <c>&lt;env inject="..."&gt;</c>: the <c>%</c> in it
/// stands for the name, and everything around it is the delimiter. A config generating shell
/// scripts can set <c>inject="&lt;&lt;%&gt;&gt;"</c> and stop fighting with dollar signs.
/// </para>
/// <para>
/// A name that matches no sequence is left exactly as it was written, marker and all. Replacing it
/// with an empty string would hide a typo inside data that still looks well-formed; leaving
/// <c>${{Gendre}}</c> in the output makes it obvious on the first row.
/// </para>
/// </remarks>
public static class Interpolate
{
    /// <summary>Reads the <c>inject</c> attribute; the greedy group picks the rightmost usable <c>%</c>.</summary>
    private static readonly Regex InjectShape = new("(.+)%(.+)", RegexOptions.Compiled);

    // Null is a value here, not an absence: the cache has to remember "this inject has no slot" or
    // it would try to recompile that pattern on every single line.
    private static readonly ConcurrentDictionary<string, Regex?> PatternCache = new();

    /// <summary>What a name resolves to on the row being rendered.</summary>
    public interface ILookup
    {
        bool Has(string name);

        string Value(string name);
    }

    public static string Apply(string text, string? inject, ILookup lookup)
    {
        Regex? pattern = PatternFor(inject);
        if (pattern is null)
        {
            // An inject with no `%` names nothing, so there is nothing to substitute.
            return text;
        }

        var result = new StringBuilder();
        int last = 0;
        foreach (Match m in pattern.Matches(text))
        {
            result.Append(text, last, m.Index - last);
            Reference reference = ParseReference(m.Groups[1].Value);
            if (!lookup.Has(reference.Name))
            {
                result.Append(m.Value);
            }
            else
            {
                string value = lookup.Value(reference.Name);
                foreach (Filter f in reference.Filters)
                {
                    value = Transforms.ApplyFilter(f.Kind, f.Arg, value);
                }

                result.Append(value);
            }

            last = m.Index + m.Length;
        }

        result.Append(text[last..]);
        return result.ToString();
    }

    private sealed record Filter(string Kind, string? Arg);

    private sealed record Reference(string Name, IReadOnlyList<Filter> Filters);

    /// <summary>
    /// <c>NAME ( "|" filter )*</c>, where a filter is a bare word or <c>word:arg</c>.
    /// </summary>
    /// <remarks>
    /// The argument runs to the next <c>|</c>, which is why a mask pattern may contain anything but
    /// a pipe.
    /// </remarks>
    private static Reference ParseReference(string raw)
    {
        string[] parts = raw.Split('|');
        string name = parts[0].Trim();
        var filters = new List<Filter>();
        for (int i = 1; i < parts.Length; i++)
        {
            string piece = parts[i];
            int colon = piece.IndexOf(':');
            if (colon < 0)
            {
                string bare = piece.Trim();
                if (bare.Length > 0)
                {
                    filters.Add(new Filter(bare, null));
                }
            }
            else
            {
                string kind = piece[..colon].Trim();
                if (kind.Length > 0)
                {
                    filters.Add(new Filter(kind, piece[(colon + 1)..].Trim()));
                }
            }
        }

        return new Reference(name, filters);
    }

    /// <summary>Null when the inject has no <c>%</c> slot at all.</summary>
    private static Regex? PatternFor(string? inject)
    {
        string key = string.IsNullOrEmpty(inject) ? "${{%}}" : inject!;
        return PatternCache.GetOrAdd(key, k =>
        {
            Match shape = InjectShape.Match(k);
            if (!shape.Success || shape.Length != k.Length)
            {
                return null;
            }

            return new Regex(
                Regex.Escape(shape.Groups[1].Value) + "(.+?)" + Regex.Escape(shape.Groups[2].Value),
                RegexOptions.Compiled);
        });
    }
}
