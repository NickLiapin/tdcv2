using System.Globalization;

namespace Tdcv2.Errors;

/// <summary>
/// Diagnostics, printed the way a compiler prints them.
/// </summary>
/// <remarks>
/// <para>
/// A header carrying severity and code, a <c>--&gt;</c> line naming the position, the offending
/// source line with a caret under it, and the hint as a <c>note</c>. The point is that one block
/// pasted into a chat or an issue is actionable on its own — nobody has to also send the config.
/// </para>
/// <para>
/// Held to the reference by <c>fixtures/cross-language/cli.json</c>: a user who runs the same broken
/// config through two implementations should see the same complaint, not two dialects of it.
/// </para>
/// </remarks>
public static class DiagnosticRenderer
{
    private const string Red = "\u001b[31m";
    private const string Yellow = "\u001b[33m";
    private const string Cyan = "\u001b[36m";
    private const string Bold = "\u001b[1m";
    private const string Reset = "\u001b[0m";

    private static string Colorize(string text, string code, bool enabled) =>
        enabled ? code + text + Reset : text;

    /// <summary>One diagnostic as a block. Without <paramref name="source"/> only the header and position.</summary>
    public static string Format(
        Diagnostic diagnostic, string? source, string filename, bool colors)
    {
        string severityColor = diagnostic.Severity == Severity.Error ? Red : Yellow;
        string severityText = diagnostic.Severity.ToString().ToLowerInvariant();
        string label = Colorize(
            Colorize(severityText, severityColor, colors)
            + (string.IsNullOrEmpty(diagnostic.Code) ? "" : "[" + diagnostic.Code + "]"),
            Bold,
            colors);

        var lines = new List<string>
        {
            label + ": " + diagnostic.Message,

            // The column is held 0-based, as the shared fixtures record it, and printed 1-based, as
            // every editor counts.
            string.Create(
                CultureInfo.InvariantCulture,
                $" --> {filename}:{diagnostic.Line}:{diagnostic.Column + 1}"),
        };

        if (!string.IsNullOrEmpty(source))
        {
            lines.AddRange(Snippet(diagnostic, source, colors));
        }

        if (!string.IsNullOrEmpty(diagnostic.Hint))
        {
            lines.Add(Colorize("note", Cyan, colors) + ": " + diagnostic.Hint);
        }

        return string.Join("\n", lines);
    }

    /// <summary>Every diagnostic as a block, with a count at the end. Empty input gives an empty string.</summary>
    public static string FormatAll(
        IReadOnlyList<Diagnostic> diagnostics, string? source, string filename, bool colors)
    {
        if (diagnostics.Count == 0)
        {
            return "";
        }

        var blocks = diagnostics.Select(d => Format(d, source, filename, colors)).ToList();

        int errors = diagnostics.Count(d => d.Severity == Severity.Error);
        int warnings = diagnostics.Count - errors;

        var parts = new List<string>();
        if (errors > 0)
        {
            parts.Add($"{errors} error" + (errors == 1 ? "" : "s"));
        }

        if (warnings > 0)
        {
            parts.Add($"{warnings} warning" + (warnings == 1 ? "" : "s"));
        }

        blocks.Add("");
        // "aborted" only when something actually stopped. Warnings alone leave a run that
        // finished, and announcing it as aborted sends the reader looking for a failure that
        // never happened.
        string line = errors > 0
            ? "aborted: " + string.Join(", ", parts)
            : string.Join(", ", parts);
        blocks.Add(Colorize(line, Bold, colors));
        return string.Join("\n\n", blocks);
    }

    /// <summary>
    /// The widest source excerpt a snippet will show. A generated single-line config can be
    /// arbitrarily long; echoing 100 KB of it (plus as many carets) buries the message it was
    /// meant to illustrate.
    /// </summary>
    private const int SnippetWindow = 160;

    /// <summary>The offending line, with a caret under the column. Nothing when the line is out of range.</summary>
    private static IReadOnlyList<string> Snippet(
        Diagnostic diagnostic, string source, bool colors)
    {
        string[] sourceLines = source.Split('\n');
        int index = diagnostic.Line - 1;
        if (index < 0 || index >= sourceLines.Length)
        {
            return Array.Empty<string>();
        }

        string text = sourceLines[index];
        string number = diagnostic.Line.ToString(CultureInfo.InvariantCulture);
        string blank = new(' ', number.Length);
        string pipe = Colorize("|", Cyan, colors);
        int column = Math.Max(0, diagnostic.Column);
        int caretLen = Underline(text, column);

        // Window an over-long line around the carets, marking cut edges with "…".
        // The same formula lives in the other four implementations' renderers.
        string shown = text;
        int caretStart = column;
        if (text.Length > SnippetWindow)
        {
            int start = Math.Max(0, Math.Min(column - 40, text.Length - SnippetWindow));
            int end = start + SnippetWindow;
            string prefix = start > 0 ? "\u2026" : "";
            string suffix = end < text.Length ? "\u2026" : "";
            shown = prefix + text[start..end] + suffix;
            caretLen = Math.Max(1, Math.Min(caretLen, end - column));
            caretStart = column - start + prefix.Length;
        }

        string caret = new string(' ', caretStart)
            + Colorize(new string('^', caretLen), Red, colors);

        return new[]
        {
            blank + " " + pipe,
            Colorize(number, Cyan, colors) + " " + pipe + " " + shown,
            blank + " " + pipe + " " + caret,
            blank + " " + pipe,
        };
    }

    /// <summary>
    /// How many characters the carets cover: the whole of what is wrong, not its first letter.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Read back off the source line rather than carried on the diagnostic. A position points at
    /// one of two things — an element, or a value inside its quotes — and both say where they end
    /// in the text itself, so a hundred call sites do not each have to remember to pass a length
    /// they would get wrong once and nobody would notice.
    /// </para>
    /// <para>
    /// Every diagnostic in the shared fixtures underlines exactly what the reference underlines; a
    /// position that is neither gets one caret, which is what it had before.
    /// </para>
    /// </remarks>
    private static int Underline(string text, int column)
    {
        if (column >= text.Length)
        {
            return 1;
        }

        // A tag: through its closing ">", or through the matching "</name>" when it has one.
        // "<!--" is not a tag, so a comment is not swallowed.
        bool named = column + 1 < text.Length && IsAsciiLetter(text[column + 1]);
        if (text[column] == '<' && named)
        {
            int openEnd = TagEnd(text, column);
            if (openEnd < 0)
            {
                return text.Length - column;
            }

            if (text[openEnd - 1] == '/')
            {
                return openEnd + 1 - column;
            }

            int depth = 1;
            int k = openEnd + 1;
            while (k < text.Length)
            {
                if (text[k] != '<')
                {
                    k++;
                    continue;
                }

                if (k + 1 < text.Length && text[k + 1] == '/')
                {
                    int closeEnd = text.IndexOf('>', k);
                    if (closeEnd < 0)
                    {
                        break;
                    }

                    if (--depth == 0)
                    {
                        return closeEnd + 1 - column;
                    }

                    k = closeEnd + 1;
                }
                else
                {
                    int end = TagEnd(text, k);
                    if (end < 0)
                    {
                        break;
                    }

                    if (text[end - 1] != '/')
                    {
                        depth++;
                    }

                    k = end + 1;
                }
            }

            return text.Length - column;
        }

        // Otherwise a value: up to the quote that closes it. An empty one puts the position on
        // that quote already, and underlines the one character.
        int close = text.IndexOf('"', column);
        return close > column ? close - column : 1;
    }

    private static bool IsAsciiLetter(char c) =>
        (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

    /// <summary>
    /// The <c>&gt;</c> that closes the tag opening at <paramref name="at"/> — a <c>&gt;</c> inside
    /// an attribute value ends nothing.
    /// </summary>
    private static int TagEnd(string text, int at)
    {
        char quote = '\0';
        for (int i = at + 1; i < text.Length; i++)
        {
            char c = text[i];
            if (quote != '\0')
            {
                if (c == quote)
                {
                    quote = '\0';
                }
            }
            else if (c == '"' || c == '\'')
            {
                quote = c;
            }
            else if (c == '>')
            {
                return i;
            }
        }

        return -1;
    }
}
