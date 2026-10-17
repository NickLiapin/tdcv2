using System.Text.RegularExpressions;
using Tdcv2.Generators;

namespace Tdcv2.Validation;

/// <summary>
/// What a <c>&lt;line each="…"&gt;</c> walks, and <c>| json</c> on a list — TDC312.
/// </summary>
/// <remarks>
/// A <c>repeat=</c> column is a LIST joined into one cell with its separator, and <c>| json</c>
/// cannot see that: it reads text. Without its argument it prints the whole cell as one string,
/// <c>"English;Spanish"</c>, which is valid JSON and almost never what the config meant. With an
/// argument that is not the column's separator it prints a one-element array. Both run, both
/// produce a file that parses, and the mistake surfaces in whatever reads the file — so
/// <c>check</c> says so, naming the separator to write.
/// </remarks>
internal static class JsonLists
{
    private static readonly Regex InterpRef = new(@"\$\{\{([^}]*)\}\}", RegexOptions.Compiled);

    /// <summary>
    /// The names a <c>&lt;line each="…"&gt;</c> or <c>&lt;group each="…"&gt;</c> walks, at any
    /// depth — a pool among them is read by being printed.
    /// </summary>
    internal static HashSet<string> EachPools(TDCParser.OpenCloseElementContext? block)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (TDCParser.OpenCloseElementContext item in Children(block))
        {
            if (item.name.Text is not ("line" or "group"))
            {
                continue;
            }

            string each = Attributes(item.attr()).GetValueOrDefault("each", string.Empty).Trim();
            if (each.Length > 0)
            {
                result.Add(each);
            }

            if (item.name.Text == "group")
            {
                result.UnionWith(EachPools(item));
            }
        }

        return result;
    }

    /// <summary>Every list a <c>${{…}}</c> can name, by the path it is named with, and its separator.</summary>
    /// <remarks>
    /// Only lists whose separator the config states plainly are known: a <c>&lt;sequence&gt;</c>
    /// whose single <c>&lt;gen&gt;</c> repeats, a pool field of that shape, and the same field read
    /// through a reference to the pool (<c>D.languages</c>) or on a line walking it
    /// (<c>Doctors.languages</c>), one nested level included (<c>Doctors.dept.tags</c>).
    /// </remarks>
    internal static Dictionary<string, string> Separators(TDCParser.OpenCloseElementContext? env)
    {
        var lists = new Dictionary<string, string>(StringComparer.Ordinal);
        if (env is null)
        {
            return lists;
        }

        var poolLists = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (TDCParser.OpenCloseElementContext pool in Children(env))
        {
            if (pool.name.Text != "pool")
            {
                continue;
            }

            string poolName = Attributes(pool.attr()).GetValueOrDefault("name", string.Empty).Trim();
            if (poolName.Length == 0)
            {
                continue;
            }

            Dictionary<string, string> own = ListsOf(SequencesOf(pool), poolLists);
            poolLists[poolName] = own;
            foreach (KeyValuePair<string, string> entry in own)
            {
                lists[poolName + "." + entry.Key] = entry.Value;
            }
        }

        foreach (KeyValuePair<string, string> entry in ListsOf(SequencesOf(env), poolLists))
        {
            lists[entry.Key] = entry.Value;
        }

        return lists;
    }

    /// <summary><c>(message, hint)</c> per <c>${{List | json}}</c> not splitting on the list's separator.</summary>
    /// <param name="walked">The lists an <c>each</c> line and its groups walk: there a name is the ELEMENT.</param>
    internal static List<(string Message, string Hint)> Check(
        string text, IReadOnlyDictionary<string, string> lists, IReadOnlyCollection<string> walked)
    {
        var result = new List<(string Message, string Hint)>();
        if (lists.Count == 0)
        {
            return result;
        }

        foreach (Match m in InterpRef.Matches(text))
        {
            string[] pieces = m.Groups[1].Value.Split('|');
            string name = pieces[0].Trim();
            if (!lists.TryGetValue(name, out string? separator) || walked.Contains(name))
            {
                continue;
            }

            foreach (string piece in pieces.Skip(1))
            {
                int colon = piece.IndexOf(':', StringComparison.Ordinal);
                if ((colon < 0 ? piece : piece[..colon]).Trim() != "json")
                {
                    continue;
                }

                string? arg = colon < 0 ? null : piece[(colon + 1)..].Trim();

                // `json:` with nothing after it is TDC273's to report, and one complaint is enough.
                if (arg is { Length: 0 })
                {
                    continue;
                }

                string want = separator.Trim();
                if (arg == want)
                {
                    continue;
                }

                string message = arg is null
                    ? $"\"{name}\" is a list joined with \"{separator}\", and | json prints it as one string"
                    : $"| json:{arg} splits on \"{arg}\", but \"{name}\" is joined with \"{separator}\"";
                string hint = Writable(separator)
                    ? $"Write ${{{{{name} | json:{want}}}}} for a JSON array of its elements."
                    : $"\"{separator}\" cannot be written after json: — give the list another separator=, such as \";\".";
                result.Add((message, hint));
            }
        }

        return result;
    }

    /// <summary>A separator <c>json:</c> can carry.</summary>
    /// <remarks>
    /// The argument is trimmed, a <c>|</c> starts the next filter and a <c>}</c> ends the
    /// reference, so a list joined with any of those cannot be named after the colon.
    /// </remarks>
    private static bool Writable(string separator) =>
        separator.Trim().Length > 0 && !separator.Contains('|') && !separator.Contains('}');

    private static Dictionary<string, string> ListsOf(
        List<TDCParser.OpenCloseElementContext> sequences,
        Dictionary<string, Dictionary<string, string>> poolLists)
    {
        var own = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TDCParser.OpenCloseElementContext seq in sequences)
        {
            string name = Attributes(seq.attr()).GetValueOrDefault("name", string.Empty).Trim();
            var gens = new List<IReadOnlyDictionary<string, string>>();
            foreach (TDCParser.ElementContext child in Elements(seq))
            {
                if (child.selfClosingElement() is { } self && self.name.Text == "gen")
                {
                    gens.Add(Attributes(self.attr()));
                }
                else if (child.openCloseElement() is { } open && open.name.Text == "gen")
                {
                    gens.Add(Attributes(open.attr()));
                }
            }

            if (name.Length == 0 || gens.Count != 1)
            {
                continue;
            }

            IReadOnlyDictionary<string, string> gen = gens[0];
            if (gen.GetValueOrDefault("repeat", string.Empty).Trim().Length > 0)
            {
                own[name] = gen.GetValueOrDefault("separator", Repeat.DefaultSeparator);
            }
            else if (gen.GetValueOrDefault("type") == "pool"
                && poolLists.TryGetValue(
                    gen.GetValueOrDefault("value", string.Empty).Trim(),
                    out Dictionary<string, string>? other))
            {
                // A record drawn from another pool carries that pool's lists one level down.
                foreach (KeyValuePair<string, string> entry in other)
                {
                    own[name + "." + entry.Key] = entry.Value;
                }
            }
        }

        return own;
    }

    /// <summary>The <c>&lt;sequence&gt;</c>s of a container, those wrapped in <c>&lt;uniq&gt;</c>/<c>&lt;distinct&gt;</c> included.</summary>
    private static List<TDCParser.OpenCloseElementContext> SequencesOf(
        TDCParser.OpenCloseElementContext container)
    {
        var result = new List<TDCParser.OpenCloseElementContext>();
        foreach (TDCParser.OpenCloseElementContext child in Children(container))
        {
            string tag = child.name.Text;
            if (tag == "sequence")
            {
                result.Add(child);
            }
            else if (tag is "uniq" or "distinct")
            {
                result.AddRange(SequencesOf(child));
            }
        }

        return result;
    }

    private static IEnumerable<TDCParser.OpenCloseElementContext> Children(
        TDCParser.OpenCloseElementContext? parent) =>
        Elements(parent)
            .Select(child => child.openCloseElement())
            .Where(open => open is not null)!;

    private static TDCParser.ElementContext[] Elements(TDCParser.OpenCloseElementContext? parent) =>
        parent?.content()?.element() ?? Array.Empty<TDCParser.ElementContext>();

    private static IReadOnlyDictionary<string, string> Attributes(TDCParser.AttrContext[] attrs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TDCParser.AttrContext attr in attrs)
        {
            string raw = attr.attrValue.Text;
            result[attr.attrName.Text] = raw.Substring(1, raw.Length - 2);
        }

        return result;
    }
}
