using System.Text;

namespace Tdcv2.Parser;

/// <summary>
/// Paired raw text, rewritten before the lexer ever sees it.
/// </summary>
/// <remarks>
/// <para>
/// <c>&lt;data pair="X"&gt;…&lt;/data pair="X"&gt;</c> lets a body carry a literal
/// <c>&lt;/data&gt;</c> — a snippet of TDC syntax inside generated documentation, say. The grammar
/// keeps one static <c>&lt;/data&gt;</c> close token because a lexer that had to know which closer
/// belongs to which opener would need the pair value inside a token rule, so the pairing is
/// resolved here instead: the paired closer becomes a plain <c>&lt;/data&gt;</c> and every literal
/// <c>&lt;/data&gt;</c> in the body becomes a sentinel the lexer reads as ordinary text.
/// <see cref="Restore"/> puts the sentinel back when a body is read.
/// </para>
/// <para>
/// The rewrite is length-preserving on purpose. Everything the lexer, the parser and the validator
/// report afterwards carries a line and a column, and those have to point into the file the user
/// wrote rather than into the one this pass produced — which is why the closing tag's leftover
/// characters become spaces instead of disappearing.
/// </para>
/// <para>
/// Ported from <c>typescript/src/parser/paired-data.ts</c>. The five implementations have to agree
/// character for character, malformed input included, so this follows the reference's decisions
/// even where a fresh design would choose otherwise.
/// </para>
/// </remarks>
public static class PairedData
{
    /// <summary>
    /// NUL, which cannot appear in a hand-written config, standing in for the two ends of a
    /// literal <c>&lt;/data&gt;</c> while the lexer runs.
    /// </summary>
    private const char Guard = '\0';

    /// <summary>
    /// What a literal <c>&lt;/data&gt;</c> inside a paired body becomes for the duration of
    /// lexing. Exactly as long as the text it stands in for, which is what keeps every later
    /// position honest.
    /// </summary>
    private static readonly string Sentinel = Guard + "/data" + Guard;

    private const string Open = "<data";
    private const string Close = "</data>";
    private const string ClosePrefix = "</data";

    /// <summary>One paired tag that does not line up, at the position a person can act on.</summary>
    public sealed record Problem(int Line, int Column, string Message);

    /// <summary>The source to lex, and everything wrong with the paired tags in it.</summary>
    public sealed record Rewrite(string Source, IReadOnlyList<Problem> Problems);

    /// <summary>A close tag, and the <c>pair</c> it carried if it carried one.</summary>
    private readonly record struct CloseTag(int Start, int End, string? Pair);

    /// <summary>A line (1-based) and column (0-based), as every diagnostic here counts them.</summary>
    private readonly record struct Position(int Line, int Column);

    public static Rewrite Preprocess(string source)
    {
        var output = new StringBuilder();
        int cursor = 0;
        var problems = new List<Problem>();
        var seen = new Dictionary<string, Position>(StringComparer.Ordinal);

        while (cursor < source.Length)
        {
            int openStart = source.IndexOf(Open, cursor, StringComparison.Ordinal);
            if (openStart < 0)
            {
                output.Append(source, cursor, source.Length - cursor);
                break;
            }

            if (!IsDataOpenAt(source, openStart))
            {
                // `<database>` and friends: emit the false start and keep looking past it.
                output.Append(source, cursor, openStart + Open.Length - cursor);
                cursor = openStart + Open.Length;
                continue;
            }

            int openEnd = FindTagEnd(source, openStart);
            if (openEnd < 0)
            {
                output.Append(source, cursor, source.Length - cursor);
                break;
            }

            string openText = source[openStart..(openEnd + 1)];
            string? pair = PairValue(openText);
            if (pair is null || IsSelfClosing(openText))
            {
                output.Append(source, cursor, openEnd + 1 - cursor);
                cursor = openEnd + 1;
                continue;
            }

            Position pairPosition = At(source, openStart + openText.IndexOf(pair, StringComparison.Ordinal));
            if (seen.TryGetValue(pair, out Position previous))
            {
                problems.Add(new Problem(
                    pairPosition.Line,
                    pairPosition.Column,
                    $"duplicate <data pair=\"{pair}\"> value. "
                    + $"First use was at line {previous.Line}, column {previous.Column}."));
            }
            else
            {
                seen[pair] = pairPosition;
            }

            int bodyStart = openEnd + 1;
            (CloseTag? match, CloseTag? mismatch) = FindClose(source, bodyStart, pair);
            if (match is null)
            {
                Position at = At(source, mismatch?.Start ?? openStart);
                string message = mismatch is null
                    ? $"unclosed <data pair=\"{pair}\">"
                    : $"expected </data pair=\"{pair}\">, got </data pair=\"{mismatch.Value.Pair}\">";
                problems.Add(new Problem(at.Line, at.Column, message));

                // Nothing after an unmatched opener can be rewritten with any confidence about
                // where the body was meant to end, so the rest of the file is handed over untouched.
                output.Append(source, cursor, source.Length - cursor);
                break;
            }

            CloseTag close = match.Value;
            output.Append(source, cursor, bodyStart - cursor);
            output.Append(source[bodyStart..close.Start].Replace(Close, Sentinel, StringComparison.Ordinal));
            output.Append(Close);
            output.Append(StructuralWhitespace(source[(close.Start + Close.Length)..(close.End + 1)]));
            cursor = close.End + 1;
        }

        return new Rewrite(output.ToString(), problems);
    }

    /// <summary>A body as the user wrote it, with the sentinel back to a literal close tag.</summary>
    public static string Restore(string text) =>
        text.Replace(Sentinel, Close, StringComparison.Ordinal);

    private static bool IsDataOpenAt(string source, int index)
    {
        int after = index + Open.Length;
        if (after >= source.Length)
        {
            return true;
        }
        char next = source[after];
        return next == '>' || next == '/' || IsSpace(next);
    }

    private static bool IsSelfClosing(string tagText)
    {
        int at = tagText.Length - 2; // The tag always ends in '>'; read back from there.
        while (at >= 0 && IsSpace(tagText[at]))
        {
            at--;
        }
        return at >= 0 && tagText[at] == '/';
    }

    /// <summary>
    /// The close that pairs with <paramref name="expected"/>, or — when there is none — the first
    /// close that carried some other pair, which is the difference between "you closed it wrong"
    /// and "you never closed it".
    /// </summary>
    private static (CloseTag? Match, CloseTag? Mismatch) FindClose(
        string source, int start, string expected)
    {
        int searchAt = start;
        CloseTag? mismatch = null;

        while (searchAt < source.Length)
        {
            int closeStart = source.IndexOf(ClosePrefix, searchAt, StringComparison.Ordinal);
            if (closeStart < 0)
            {
                break;
            }
            int closeEnd = FindTagEnd(source, closeStart);
            if (closeEnd < 0)
            {
                break;
            }

            string? closePair = PairValue(source[closeStart..(closeEnd + 1)]);
            if (string.Equals(closePair, expected, StringComparison.Ordinal))
            {
                return (new CloseTag(closeStart, closeEnd, closePair), mismatch);
            }
            if (closePair is not null && mismatch is null)
            {
                mismatch = new CloseTag(closeStart, closeEnd, closePair);
            }
            searchAt = closeStart + ClosePrefix.Length;
        }

        return (null, mismatch);
    }

    /// <summary>The '>' that ends a tag, ignoring any inside quotes so <c>if="a&gt;b"</c> does not.</summary>
    private static int FindTagEnd(string source, int start)
    {
        char quote = '\0';
        for (int at = start; at < source.Length; at++)
        {
            char ch = source[at];
            if (quote != '\0')
            {
                if (ch == quote)
                {
                    quote = '\0';
                }
                continue;
            }
            if (ch == '"' || ch == '\'')
            {
                quote = ch;
                continue;
            }
            if (ch == '>')
            {
                return at;
            }
        }
        return -1;
    }

    /// <summary>
    /// The <c>pair="…"</c> value in a tag, as the reference's <c>\bpair\s*=\s*"([^"\r\n]*)"</c>.
    /// </summary>
    private static string? PairValue(string tagText)
    {
        int at = 0;
        while (true)
        {
            int found = tagText.IndexOf("pair", at, StringComparison.Ordinal);
            if (found < 0)
            {
                return null;
            }

            // The word boundary: `superpair=` is not a pair attribute, `data-pair=` is.
            if (found > 0 && IsWordChar(tagText[found - 1]))
            {
                at = found + 1;
                continue;
            }

            int scan = SkipSpace(tagText, found + "pair".Length);
            if (scan >= tagText.Length || tagText[scan] != '=')
            {
                at = found + 1;
                continue;
            }
            scan = SkipSpace(tagText, scan + 1);
            if (scan >= tagText.Length || tagText[scan] != '"')
            {
                at = found + 1;
                continue;
            }

            scan++;
            int valueStart = scan;
            while (scan < tagText.Length
                && tagText[scan] != '"' && tagText[scan] != '\r' && tagText[scan] != '\n')
            {
                scan++;
            }
            if (scan < tagText.Length && tagText[scan] == '"')
            {
                return tagText[valueStart..scan];
            }
            at = found + 1;
        }
    }

    private static int SkipSpace(string text, int at)
    {
        while (at < text.Length && IsSpace(text[at]))
        {
            at++;
        }
        return at;
    }

    /// <summary>Line breaks kept, everything else blanked — the leftovers hold their place.</summary>
    private static string StructuralWhitespace(string text)
    {
        var output = new StringBuilder();
        for (int at = 0; at < text.Length; at++)
        {
            char ch = text[at];
            if (ch == '\n' || ch == '\r')
            {
                output.Append(ch);
                continue;
            }
            output.Append(' ');

            // By code point, not by char: an astral character in a pair value is one space in the
            // reference, and two would push every column after it out by one.
            if (char.IsHighSurrogate(ch) && at + 1 < text.Length && char.IsLowSurrogate(text[at + 1]))
            {
                at++;
            }
        }
        return output.ToString();
    }

    private static Position At(string source, int index)
    {
        int line = 1;
        int column = 0;
        for (int at = 0; at < index; at++)
        {
            if (source[at] == '\n')
            {
                line++;
                column = 0;
            }
            else
            {
                column++;
            }
        }
        return new Position(line, column);
    }

    /// <summary>
    /// Whitespace as JavaScript's <c>\s</c> defines it, which is what the reference tests against.
    /// Spelling the set out is what stops five languages disagreeing over an exotic space:
    /// <c>char.IsWhiteSpace</c> admits U+0085 and refuses U+FEFF, so it is not this set under
    /// another name.
    /// </summary>
    private static bool IsSpace(char ch) =>
        ch is '\t' or '\n' or '\v' or '\f' or '\r' or ' '
            or '\u00a0' or '\u1680' or '\u2028' or '\u2029'
            or '\u202f' or '\u205f' or '\u3000' or '\ufeff'
        || (ch >= '\u2000' && ch <= '\u200a');

    private static bool IsWordChar(char ch) =>
        (ch >= 'a' && ch <= 'z')
        || (ch >= 'A' && ch <= 'Z')
        || (ch >= '0' && ch <= '9')
        || ch == '_';
}
