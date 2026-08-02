namespace Tdcv2.Unicode;

/// <summary>
/// The inline character set behind <c>&lt;gen type="symbol" value="…"&gt;</c>.
/// </summary>
/// <remarks>
/// <para>
/// Grammar: <c>[X-Y]</c> is an inclusive code-point range, every other character stands for itself,
/// and commas and spaces <em>outside</em> brackets are ignored so a long set can be written with
/// breathing room. To include a comma or a space, bracket it: <c>[,]</c>, <c>[ ]</c>. A hyphen at
/// either end of a group is a literal hyphen.
/// </para>
/// <para>
/// It exists so that picking one of a handful of symbols does not require a regular expression. The
/// result keeps first-seen order and drops duplicates — order matters because the set is indexed by
/// a random draw, so two implementations that ordered it differently would produce different
/// characters from the same seed.
/// </para>
/// </remarks>
public static class CharSet
{
    public static IReadOnlyList<string> Parse(string spec)
    {
        IReadOnlyList<string> chars = Alphabets.CodePoints(spec);
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int i = 0;
        while (i < chars.Count)
        {
            string c = chars[i];
            if (c == "[")
            {
                int end = -1;
                for (int j = i + 1; j < chars.Count; j++)
                {
                    if (chars[j] == "]")
                    {
                        end = j;
                        break;
                    }
                }

                if (end < 0)
                {
                    throw new ArgumentException(
                        $"character set: unterminated \"[\" in \"{spec}\"");
                }

                ExpandGroup(chars.Skip(i + 1).Take(end - i - 1).ToList(), result, seen, spec);
                i = end + 1;
                continue;
            }

            if (c == "," || IsSeparator(c))
            {
                i++;
                continue;
            }

            Add(result, seen, c);
            i++;
        }

        return result;
    }

    private static void ExpandGroup(
        IReadOnlyList<string> group, List<string> result, HashSet<string> seen, string spec)
    {
        int j = 0;
        while (j < group.Count)
        {
            string c = group[j];
            // A range needs all three tokens present, so a leading or trailing "-" stays literal.
            if (j + 2 < group.Count && group[j + 1] == "-")
            {
                int lo = char.ConvertToUtf32(c, 0);
                int hi = char.ConvertToUtf32(group[j + 2], 0);
                if (hi < lo)
                {
                    throw new ArgumentException(
                        $"character set: reversed range \"{c}-{group[j + 2]}\" in \"{spec}\"");
                }

                for (int cp = lo; cp <= hi; cp++)
                {
                    Add(result, seen, char.ConvertFromUtf32(cp));
                }

                j += 3;
                continue;
            }

            Add(result, seen, c);
            j++;
        }
    }

    private static void Add(List<string> result, HashSet<string> seen, string c)
    {
        if (seen.Add(c))
        {
            result.Add(c);
        }
    }

    private static bool IsSeparator(string c) =>
        c is " " or "\t" or "\n" or "\r";
}
