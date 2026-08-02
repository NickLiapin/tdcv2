using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Tdcv2.Format;

/// <summary>
/// A positional mask: <c>mask="xxx-xxx"</c>, <c>mask="w[1] w[0]"</c>, <c>mask="x[0]. *"</c>.
/// </summary>
/// <remarks>
/// <para>
/// The alphabet is small on purpose. <c>x</c> takes one character, <c>w</c> takes one word,
/// <c>*</c> takes everything not yet used, a backslash escapes the next character, and anything
/// else is a literal. That is enough to reformat a phone number, swap a name around, or build an
/// initial, without a config ever reaching for a regular expression.
/// </para>
/// <para>
/// <c>x[i]</c> and <c>w[i]</c> address the <em>original</em> input — 0-based, negative from the
/// end, <c>a..b</c> inclusive. Indexing and consumption are two channels that do not interfere:
/// what an index emits never depends on what has been consumed, and consumption only decides what
/// is left for a bare <c>x</c>, <c>w</c> or <c>*</c>. So the same notation reads as a move when
/// nothing else claims that position and as a copy when something does — which is why
/// <c>"w[1] w[0]"</c> swaps two words and <c>"w[0] *"</c> repeats the first one.
/// </para>
/// <para>
/// Out-of-range indexes emit nothing rather than failing. The length of a value is not known until
/// it is generated, so there is nothing to check the mask against beforehand, and stopping a
/// million-row run over one short value would be worse than a gap in it.
/// </para>
/// </remarks>
public static class Mask
{
    private static readonly Regex OneIndex = new(@"^(-?\d+)$", RegexOptions.Compiled);
    private static readonly Regex RangeIndex = new(@"^(-?\d+)\.\.(-?\d+)$", RegexOptions.Compiled);

    private enum Kind
    {
        Char,
        Word,
        CharAt,
        WordAt,
        Rest,
        Literal,
    }

    private sealed record Slot(Kind Kind, string? Text, int From, int To);

    private sealed record Span(int Start, int End);

    public static string Apply(string pattern, string input)
    {
        IReadOnlyList<string> chars = CodePoints(input);
        var used = new bool[chars.Count];
        IReadOnlyList<Span> spans = WordSpans(chars);
        var result = new StringBuilder();

        foreach (Slot slot in Parse(pattern))
        {
            switch (slot.Kind)
            {
                case Kind.Literal:
                    result.Append(slot.Text);
                    break;

                case Kind.Char:
                {
                    int i = NextFree(used);
                    if (i < chars.Count)
                    {
                        result.Append(chars[i]);
                        used[i] = true;
                    }

                    break;
                }

                case Kind.Word:
                {
                    int i = NextFree(used);
                    while (i < chars.Count && !used[i] && !IsSpace(chars[i]))
                    {
                        result.Append(chars[i]);
                        used[i] = true;
                        i++;
                    }

                    // Swallow one delimiter with the word, so what a later `*` prints does not
                    // begin with the space this word left behind.
                    if (i < chars.Count && !used[i] && IsSpace(chars[i]))
                    {
                        used[i] = true;
                    }

                    break;
                }

                case Kind.CharAt:
                    foreach (int i in Walk(slot.From, slot.To, chars.Count))
                    {
                        result.Append(chars[i]);
                        used[i] = true;
                    }

                    break;

                case Kind.WordAt:
                {
                    var picked = new List<string>();
                    foreach (int wi in Walk(slot.From, slot.To, spans.Count))
                    {
                        Span span = spans[wi];
                        for (int i = span.Start; i < span.End; i++)
                        {
                            used[i] = true;
                        }

                        // Take one adjacent delimiter along, so the leftovers a later `*` prints
                        // do not collapse into a double space.
                        if (span.End < chars.Count && IsSpace(chars[span.End]))
                        {
                            used[span.End] = true;
                        }
                        else if (span.Start > 0 && IsSpace(chars[span.Start - 1]))
                        {
                            used[span.Start - 1] = true;
                        }

                        picked.Add(string.Concat(chars.Skip(span.Start).Take(span.End - span.Start)));
                    }

                    result.Append(string.Join(" ", picked));
                    break;
                }

                case Kind.Rest:
                    for (int i = 0; i < chars.Count; i++)
                    {
                        if (!used[i])
                        {
                            result.Append(chars[i]);
                            used[i] = true;
                        }
                    }

                    break;
            }
        }

        return result.ToString();
    }

    /// <summary>
    /// Parse a mask without applying it — what the validator needs to refuse a broken one early.
    /// </summary>
    /// <remarks>Throws the same complaint applying it would, only before a single row exists.</remarks>
    public static void Check(string pattern) => Parse(pattern);

    private static IReadOnlyList<Slot> Parse(string pattern)
    {
        IReadOnlyList<string> pat = CodePoints(pattern);
        var slots = new List<Slot>();
        for (int i = 0; i < pat.Count; i++)
        {
            string ch = pat[i];
            if (ch == "\\" && i + 1 < pat.Count)
            {
                slots.Add(new Slot(Kind.Literal, pat[i + 1], 0, 0));
                i++;
                continue;
            }

            if (ch == "*")
            {
                slots.Add(new Slot(Kind.Rest, null, 0, 0));
                continue;
            }

            if (ch != "x" && ch != "w")
            {
                slots.Add(new Slot(Kind.Literal, ch, 0, 0));
                continue;
            }

            // A `[` is index syntax only directly after an x or a w. Anywhere else it is ordinary
            // text, so mask="[tel.] xxx" needs no escaping.
            if (i + 1 < pat.Count && pat[i + 1] == "[")
            {
                int close = IndexOf(pat, "]", i + 2);
                if (close != -1)
                {
                    string body = string.Concat(pat.Skip(i + 2).Take(close - i - 2));
                    (int From, int To)? spec = ParseIndexSpec(body);
                    if (spec is null)
                    {
                        throw new ArgumentException(
                            $"mask: invalid index \"[{body}]\" after \"{ch}\" — use {ch}[0], "
                            + $"{ch}[0..4] or {ch}[-1]; ranges use \"..\" (a hyphen would clash "
                            + $"with a negative index). For a literal bracket write {ch}\\[");
                    }

                    slots.Add(new Slot(
                        ch == "x" ? Kind.CharAt : Kind.WordAt, null, spec.Value.From, spec.Value.To));
                    i = close;
                    continue;
                }

                // No closing bracket anywhere: plain text, left alone.
            }

            slots.Add(new Slot(ch == "x" ? Kind.Char : Kind.Word, null, 0, 0));
        }

        return slots;
    }

    /// <summary><c>-3</c>, <c>7</c>, <c>0..4</c>, <c>-2..-1</c> — and nothing else.</summary>
    private static (int From, int To)? ParseIndexSpec(string body)
    {
        Match one = OneIndex.Match(body);
        if (one.Success && one.Length == body.Length)
        {
            int n = int.Parse(one.Groups[1].Value, CultureInfo.InvariantCulture);
            return (n, n);
        }

        Match range = RangeIndex.Match(body);
        if (!range.Success || range.Length != body.Length)
        {
            return null;
        }

        return (
            int.Parse(range.Groups[1].Value, CultureInfo.InvariantCulture),
            int.Parse(range.Groups[2].Value, CultureInfo.InvariantCulture));
    }

    /// <summary>Indices from..to inclusive, counting backwards when the range runs that way.</summary>
    private static IReadOnlyList<int> Walk(int from, int to, int length)
    {
        int a = from < 0 ? length + from : from;
        int b = to < 0 ? length + to : to;
        int step = a <= b ? 1 : -1;
        var result = new List<int>();
        for (int i = a; step > 0 ? i <= b : i >= b; i += step)
        {
            if (i >= 0 && i < length)
            {
                result.Add(i);
            }
        }

        return result;
    }

    private static IReadOnlyList<Span> WordSpans(IReadOnlyList<string> chars)
    {
        var spans = new List<Span>();
        int i = 0;
        while (i < chars.Count)
        {
            if (IsSpace(chars[i]))
            {
                i++;
                continue;
            }

            int start = i;
            while (i < chars.Count && !IsSpace(chars[i]))
            {
                i++;
            }

            spans.Add(new Span(start, i));
        }

        return spans;
    }

    private static int NextFree(bool[] used)
    {
        int i = 0;
        while (i < used.Length && used[i])
        {
            i++;
        }

        return i;
    }

    private static int IndexOf(IReadOnlyList<string> chars, string needle, int from)
    {
        for (int i = from; i < chars.Count; i++)
        {
            if (chars[i] == needle)
            {
                return i;
            }
        }

        return -1;
    }

    private static bool IsSpace(string c) => c.Length > 0 && char.IsWhiteSpace(c[0]);

    /// <summary>One string per code point, so a surrogate pair is never split in half.</summary>
    public static IReadOnlyList<string> CodePoints(string value)
    {
        var result = new List<string>(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            if (char.IsHighSurrogate(value[i]) && i + 1 < value.Length
                && char.IsLowSurrogate(value[i + 1]))
            {
                result.Add(value.Substring(i, 2));
                i++;
            }
            else
            {
                result.Add(value[i].ToString());
            }
        }

        return result;
    }
}
