using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Tdcv2.Format;

/// <summary>
/// Text transforms applied to a finished value.
/// </summary>
/// <remarks>
/// Shared by three places that all mean the same thing: the <c>case=</c> attribute on a
/// <c>&lt;gen&gt;</c>, the compute tags, and the <c>${{Name|upper}}</c> interpolation filters. One
/// implementation, so the three cannot drift apart.
/// </remarks>
public static class Transforms
{
    public static IReadOnlyList<string> CaseTransforms { get; } =
        new[] { "upper", "lower", "capitalize", "title" };

    /// <summary>Every name accepted after a <c>|</c> inside an interpolation.</summary>
    public static IReadOnlyList<string> FilterNames { get; } = new[]
    {
        "upper", "lower", "capitalize", "title", "mask", "slice", "replace", "trim", "group",
        "compact", "csv", "sql",
    };

    /// <summary>A run of non-whitespace, for <c>title</c>.</summary>
    private static readonly Regex Word = new(@"\S+", RegexOptions.Compiled);

    private static readonly Regex WholeNumber = new(@"^-?\d+$", RegexOptions.Compiled);

    public static bool IsCaseTransform(string name) => CaseTransforms.Contains(name);

    public static bool IsFilterName(string name) => FilterNames.Contains(name);

    /// <summary>
    /// Apply one interpolation filter.
    /// </summary>
    /// <remarks>
    /// An unknown filter passes the value through untouched. Filters are lenient by design and the
    /// validator is where a typo gets named; failing here would turn a misspelling into a dead run
    /// rather than a visible oddity in the output.
    /// </remarks>
    public static string ApplyFilter(string kind, string? arg, string value)
    {
        string a = arg ?? "";
        switch (kind)
        {
            case "mask":
                return Mask.Apply(a, value);
            case "slice":
            {
                string[] parts = a.Split(',');
                int? to = parts.Length < 2 || parts[1].Length == 0 ? null : IntOr(parts[1], null);
                return Slice(value, parts.Length > 0 ? IntOr(parts[0], 0) ?? 0 : 0, to);
            }

            case "replace":
            {
                int comma = a.IndexOf(',');
                string from = comma < 0 ? a : a[..comma];
                string to = comma < 0 ? "" : a[(comma + 1)..];
                return from.Length == 0 ? value : value.Replace(from, to);
            }

            case "trim":
                return value.Trim();
            case "group":
            {
                int comma = a.IndexOf(',');
                string size = comma < 0 ? a : a[..comma];
                string sep = comma < 0 ? " " : a[(comma + 1)..];
                return Group(value, size.Length == 0 ? 3 : IntOr(size, 3) ?? 3, sep);
            }

            case "compact":
                return Compact(value, a.Length == 0 ? 36 : IntOr(a, 36) ?? 36);
            case "csv":
                return Csv(value);
            case "sql":
                return Sql(value);
            case "upper":
            case "lower":
            case "capitalize":
            case "title":
                return ApplyCase(kind, value);
            default:
                return value;
        }
    }

    /// <summary>
    /// A substring by code-point index, <c>[from, to)</c>; a missing <c>to</c> means the end.
    /// </summary>
    /// <remarks>
    /// A negative index counts from the END, which is what the reference's <c>Array.slice</c> does
    /// and what Python's own slicing does. It matters: <c>slice:-3</c> has to mean "the last three
    /// characters" everywhere, not "all of them" in whichever implementation clamped it to zero.
    /// </remarks>
    public static string Slice(string s, int from, int? to)
    {
        IReadOnlyList<string> cp = Mask.CodePoints(s);
        int n = cp.Count;
        int f = from < 0 ? Math.Max(0, n + from) : Math.Min(from, n);
        int t = to is null ? n : (to.Value < 0 ? Math.Max(0, n + to.Value) : Math.Min(to.Value, n));
        return t <= f ? "" : string.Concat(cp.Skip(f).Take(t - f));
    }

    /// <summary>Group characters from the <em>right</em>, so a number's last group stays whole.</summary>
    public static string Group(string s, int size, string sep)
    {
        if (size <= 0 || s.Length == 0)
        {
            return s;
        }

        // A decimal number is grouped where a person groups one: the digits BEFORE the
        // separator, and nowhere else. Chunking the whole string from the right put the space in
        // the fraction — 1234.56 came out "1 234 .56", a number in no locale, and nothing said
        // so. Only this exact shape is treated as a number, so group:4 on a card number stays the
        // blocks it was written for, and so does every other string.
        System.Text.RegularExpressions.Match decimalValue = DecimalShape.Match(s);
        if (decimalValue.Success)
        {
            return decimalValue.Groups[1].Value
                + ChunkFromRight(decimalValue.Groups[2].Value, size, sep)
                + decimalValue.Groups[3].Value;
        }

        return ChunkFromRight(s, size, sep);
    }

    private static readonly System.Text.RegularExpressions.Regex DecimalShape =
        new(@"^([+-]?)(\d+)(\.\d+)$");

    private static string ChunkFromRight(string s, int size, string sep)
    {
        IReadOnlyList<string> cp = Mask.CodePoints(s);
        if (cp.Count == 0)
        {
            return s;
        }

        var parts = new List<string>();
        for (int end = cp.Count; end > 0; end -= size)
        {
            int start = Math.Max(0, end - size);
            parts.Insert(0, string.Concat(cp.Skip(start).Take(end - start)));
        }

        return string.Join(sep, parts);
    }

    /// <summary>
    /// Write a whole number in a shorter alphabet: <c>1000000</c> becomes <c>lfls</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The point is a unique suffix that stays readable at scale. A row id appended to a generated
    /// address keeps it unique, but <c>john.smith2000000000@</c> is nobody's email; in base 36 the
    /// same id is six characters and covers two billion rows.
    /// </para>
    /// <para>
    /// Lowercase only, and deliberately. Base 62 would be shorter, but many systems fold the local
    /// part of an address to lower case, so <c>aB</c> and <c>Ab</c> would merge and quietly
    /// reintroduce the duplicates the suffix exists to prevent.
    /// </para>
    /// </remarks>
    public static string Compact(string value, int radix)
    {
        string text = value.Trim();
        if (!WholeNumber.IsMatch(text) || radix < 2 || radix > 36)
        {
            return value;
        }

        if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long n))
        {
            return value;
        }

        return (n < 0 ? "-" : "") + ToRadix(Math.Abs(n), radix);
    }

    /// <summary>
    /// Quote a value for CSV, per RFC 4180.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>&lt;data&gt;</c> assembles text and knows nothing about the file being written, so a
    /// value containing the delimiter silently splits the row — a product named
    /// <c>Knife set, 3 pcs</c> turns one seven-field row into eight fields, with category landing
    /// in price and price in quantity, and nothing anywhere reporting an error.
    /// </para>
    /// <para>
    /// Quoted unconditionally rather than only when needed: a rule with no exceptions is one nobody
    /// has to remember, every reader accepts redundant quotes, and "only when it contains a comma"
    /// is exactly the reasoning that loses to a newline later.
    /// </para>
    /// </remarks>
    public static string Csv(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";

    /// <summary>
    /// Escape a value for a single-quoted SQL literal by doubling apostrophes.
    /// </summary>
    /// <remarks>
    /// <c>O'Brien</c> closes the string early and the statement fails to parse — or worse, in
    /// generated data, parses into something else. The body only, with no surrounding quotes, so
    /// the config keeps writing <c>'${{Name|sql}}'</c> and the shape of the statement stays visible
    /// where it is written.
    /// </remarks>
    public static string Sql(string value) => value.Replace("'", "''");

    public static string ApplyCase(string name, string s) => name switch
    {
        "upper" => Upper(s),
        "lower" => s.ToLowerInvariant(),
        "capitalize" => UpperFirst(s),
        // Only the first letter of each word moves; the rest is left as written, so an
        // already-correct "McDonald" is not flattened to "Mcdonald".
        "title" => TitleCase(s),
        _ => throw new ArgumentException($"unknown case transform \"{name}\""),
    };

    /// <summary>
    /// Uppercase with FULL case mapping, the way JavaScript, Java and Python all do it.
    /// </summary>
    /// <remarks>
    /// .NET is the odd one out here: <c>ToUpperInvariant</c> maps one character to one character,
    /// so German <c>ß</c> stays <c>ß</c> where every other implementation writes <c>SS</c>. One
    /// row in a hundred thousand would differ, which is exactly the kind of divergence that gets
    /// found by a customer rather than by a test. The table is the set of code points whose
    /// uppercase is longer than one character, taken from the reference itself rather than
    /// guessed — regenerate it the same way if Unicode grows another.
    /// </remarks>
    public static string Upper(string s)
    {
        var result = new StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++)
        {
            int cp = char.ConvertToUtf32(s, i);
            if (char.IsHighSurrogate(s[i]))
            {
                i++;
            }

            if (MultiCharUpper.TryGetValue(cp, out string? expanded))
            {
                result.Append(expanded);
            }
            else
            {
                result.Append(char.ConvertFromUtf32(cp).ToUpperInvariant());
            }
        }

        return result.ToString();
    }

    /// <summary>Code points whose uppercase is more than one character.</summary>
    private static readonly IReadOnlyDictionary<int, string> MultiCharUpper =
        new Dictionary<int, string>
        {
        [0x00DF] = "SS",
        [0x0149] = "\u02bcN",
        [0x01F0] = "J\u030c",
        [0x0390] = "\u0399\u0308\u0301",
        [0x03B0] = "\u03a5\u0308\u0301",
        [0x0587] = "\u0535\u0552",
        [0x1E96] = "H\u0331",
        [0x1E97] = "T\u0308",
        [0x1E98] = "W\u030a",
        [0x1E99] = "Y\u030a",
        [0x1E9A] = "A\u02be",
        [0x1F50] = "\u03a5\u0313",
        [0x1F52] = "\u03a5\u0313\u0300",
        [0x1F54] = "\u03a5\u0313\u0301",
        [0x1F56] = "\u03a5\u0313\u0342",
        [0x1F80] = "\u1f08\u0399",
        [0x1F81] = "\u1f09\u0399",
        [0x1F82] = "\u1f0a\u0399",
        [0x1F83] = "\u1f0b\u0399",
        [0x1F84] = "\u1f0c\u0399",
        [0x1F85] = "\u1f0d\u0399",
        [0x1F86] = "\u1f0e\u0399",
        [0x1F87] = "\u1f0f\u0399",
        [0x1F88] = "\u1f08\u0399",
        [0x1F89] = "\u1f09\u0399",
        [0x1F8A] = "\u1f0a\u0399",
        [0x1F8B] = "\u1f0b\u0399",
        [0x1F8C] = "\u1f0c\u0399",
        [0x1F8D] = "\u1f0d\u0399",
        [0x1F8E] = "\u1f0e\u0399",
        [0x1F8F] = "\u1f0f\u0399",
        [0x1F90] = "\u1f28\u0399",
        [0x1F91] = "\u1f29\u0399",
        [0x1F92] = "\u1f2a\u0399",
        [0x1F93] = "\u1f2b\u0399",
        [0x1F94] = "\u1f2c\u0399",
        [0x1F95] = "\u1f2d\u0399",
        [0x1F96] = "\u1f2e\u0399",
        [0x1F97] = "\u1f2f\u0399",
        [0x1F98] = "\u1f28\u0399",
        [0x1F99] = "\u1f29\u0399",
        [0x1F9A] = "\u1f2a\u0399",
        [0x1F9B] = "\u1f2b\u0399",
        [0x1F9C] = "\u1f2c\u0399",
        [0x1F9D] = "\u1f2d\u0399",
        [0x1F9E] = "\u1f2e\u0399",
        [0x1F9F] = "\u1f2f\u0399",
        [0x1FA0] = "\u1f68\u0399",
        [0x1FA1] = "\u1f69\u0399",
        [0x1FA2] = "\u1f6a\u0399",
        [0x1FA3] = "\u1f6b\u0399",
        [0x1FA4] = "\u1f6c\u0399",
        [0x1FA5] = "\u1f6d\u0399",
        [0x1FA6] = "\u1f6e\u0399",
        [0x1FA7] = "\u1f6f\u0399",
        [0x1FA8] = "\u1f68\u0399",
        [0x1FA9] = "\u1f69\u0399",
        [0x1FAA] = "\u1f6a\u0399",
        [0x1FAB] = "\u1f6b\u0399",
        [0x1FAC] = "\u1f6c\u0399",
        [0x1FAD] = "\u1f6d\u0399",
        [0x1FAE] = "\u1f6e\u0399",
        [0x1FAF] = "\u1f6f\u0399",
        [0x1FB2] = "\u1fba\u0399",
        [0x1FB3] = "\u0391\u0399",
        [0x1FB4] = "\u0386\u0399",
        [0x1FB6] = "\u0391\u0342",
        [0x1FB7] = "\u0391\u0342\u0399",
        [0x1FBC] = "\u0391\u0399",
        [0x1FC2] = "\u1fca\u0399",
        [0x1FC3] = "\u0397\u0399",
        [0x1FC4] = "\u0389\u0399",
        [0x1FC6] = "\u0397\u0342",
        [0x1FC7] = "\u0397\u0342\u0399",
        [0x1FCC] = "\u0397\u0399",
        [0x1FD2] = "\u0399\u0308\u0300",
        [0x1FD3] = "\u0399\u0308\u0301",
        [0x1FD6] = "\u0399\u0342",
        [0x1FD7] = "\u0399\u0308\u0342",
        [0x1FE2] = "\u03a5\u0308\u0300",
        [0x1FE3] = "\u03a5\u0308\u0301",
        [0x1FE4] = "\u03a1\u0313",
        [0x1FE6] = "\u03a5\u0342",
        [0x1FE7] = "\u03a5\u0308\u0342",
        [0x1FF2] = "\u1ffa\u0399",
        [0x1FF3] = "\u03a9\u0399",
        [0x1FF4] = "\u038f\u0399",
        [0x1FF6] = "\u03a9\u0342",
        [0x1FF7] = "\u03a9\u0342\u0399",
        [0x1FFC] = "\u03a9\u0399",
        [0xFB00] = "FF",
        [0xFB01] = "FI",
        [0xFB02] = "FL",
        [0xFB03] = "FFI",
        [0xFB04] = "FFL",
        [0xFB05] = "ST",
        [0xFB06] = "ST",
        [0xFB13] = "\u0544\u0546",
        [0xFB14] = "\u0544\u0535",
        [0xFB15] = "\u0544\u053b",
        [0xFB16] = "\u054e\u0546",
        [0xFB17] = "\u0544\u053d"
        };

    private static int? IntOr(string raw, int? fallback) =>
        int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? value
            : fallback;

    /// <summary>Java's <c>Long.toString(n, radix)</c>: lowercase digits, no padding.</summary>
    private static string ToRadix(long value, int radix)
    {
        if (value == 0)
        {
            return "0";
        }

        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        var buffer = new StringBuilder();
        while (value > 0)
        {
            buffer.Insert(0, digits[(int)(value % radix)]);
            value /= radix;
        }

        return buffer.ToString();
    }

    private static string TitleCase(string s)
    {
        var result = new StringBuilder();
        int last = 0;
        foreach (Match m in Word.Matches(s))
        {
            result.Append(s, last, m.Index - last).Append(UpperFirst(m.Value));
            last = m.Index + m.Length;
        }

        return result.Append(s[last..]).ToString();
    }

    /// <summary>Uppercase the first character by code point, so a surrogate pair is not split.</summary>
    private static string UpperFirst(string word)
    {
        if (word.Length == 0)
        {
            return word;
        }

        int width = char.IsHighSurrogate(word[0]) && word.Length > 1 ? 2 : 1;
        return word[..width].ToUpperInvariant() + word[width..];
    }
}
