using System.Globalization;

namespace Tdcv2.Errors;

public enum Severity
{
    Error,
    Warning,
}

/// <summary>
/// One complaint about a config.
/// </summary>
/// <remarks>
/// The <c>Code</c> is the contract across implementations, not the message. Wording gets edited for
/// clarity over time, and holding four languages to a sentence would make every improvement a
/// breaking change — which is what a stable code is for.
/// </remarks>
/// <param name="Line">1-based, as an editor counts.</param>
/// <param name="Column">0-based, as an editor counts.</param>
public sealed record Diagnostic(
    Severity Severity, string Code, string Message, string Hint, int Line, int Column)
{
    /// <summary>
    /// Whether the position is a bare point rather than the start of something the line delimits.
    /// </summary>
    /// <remarks>
    /// A validator complaint points at one of two things — an element, or a value inside its quotes
    /// — and both say where they end in the source text, which is how the renderer knows how far to
    /// underline. A syntax error points at neither: the parser stopped at a character and has
    /// nothing to say about what, if anything, ends after it. Underlining outward from there would
    /// claim a span nobody measured, so the caret stays on the one character — where the reference
    /// puts it, because a parse diagnostic carries no end position there either.
    /// </remarks>
    public bool IsPoint { get; init; }

    /// <summary>
    /// The near name, when there is one: <c>did you mean "person.male.firstName"?</c>
    ///
    /// Its own line rather than a sentence folded into the hint, because it is the one part a
    /// reader can act on without reading anything else — and because the reference prints it as
    /// <c>help:</c>, above the <c>note:</c>. Folded in, it arrived buried; left out, the reader
    /// was told a name is wrong and not what the right one is.
    /// </summary>
    public string Suggestion { get; init; } = "";

    /// <summary>The <c>help:</c> line for a near name, or "" when nothing was near enough.</summary>
    public static string DidYouMean(string name) =>
        string.IsNullOrEmpty(name) ? "" : $"did you mean \"{name}\"?";

    /// <summary>
    /// The candidate nearest <paramref name="needle"/>, or "" when nothing is near enough.
    ///
    /// Ported from the reference: a case-only difference always wins, and a best distance past
    /// the maximum — or past about half the needle's length — is not a typo but a different word,
    /// where saying "did you mean" is worse than saying nothing.
    /// </summary>
    public static string ClosestMatch(string needle, IEnumerable<string> candidates)
    {
        const int maxDistance = 3;
        List<string> names = candidates.ToList();
        if (string.IsNullOrEmpty(needle) || names.Count == 0)
        {
            return "";
        }

        int limit = Math.Min(maxDistance, Math.Max(1, (needle.Length / 2) + 1));
        string lower = needle.ToLowerInvariant();
        foreach (string candidate in names)
        {
            if (candidate.ToLowerInvariant() == lower && candidate != needle)
            {
                return candidate;
            }
        }

        string best = "";
        int bestDistance = int.MaxValue;
        foreach (string candidate in names)
        {
            int d = EditDistance(needle, candidate);
            if (d < bestDistance)
            {
                bestDistance = d;
                best = candidate;
            }
        }

        return bestDistance <= limit ? best : "";
    }

    /// <summary>Levenshtein, the same two-row walk the reference uses.</summary>
    private static int EditDistance(string a, string b)
    {
        int m = a.Length;
        int n = b.Length;
        if (m == 0)
        {
            return n;
        }

        if (n == 0)
        {
            return m;
        }

        int[] prev = new int[n + 1];
        int[] curr = new int[n + 1];
        for (int j = 0; j <= n; j++)
        {
            prev[j] = j;
        }

        for (int i = 1; i <= m; i++)
        {
            curr[0] = i;
            for (int j = 1; j <= n; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                curr[j] = Math.Min(Math.Min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }

            (prev, curr) = (curr, prev);
        }

        return prev[n];
    }

    public static Diagnostic Error(string code, string message, string hint, int line, int column) =>
        new(Severity.Error, code, message, hint, line, column);

    public static Diagnostic Warning(
        string code, string message, string hint, int line, int column) =>
        new(Severity.Warning, code, message, hint, line, column);

    /// <summary>A complaint about a position rather than about a span — see <see cref="IsPoint"/>.</summary>
    public static Diagnostic ErrorAt(
        string code, string message, string hint, int line, int column) =>
        new(Severity.Error, code, message, hint, line, column) { IsPoint = true };

    /// <summary>Whether anything here stops the run. A warning is worth saying and worth continuing past.</summary>
    public static bool HasErrors(IEnumerable<Diagnostic> diagnostics) =>
        diagnostics.Any(d => d.Severity == Severity.Error);

    private string SeverityText =>
        Severity.ToString().ToLowerInvariant();

    /// <summary>The shape the shared diagnostic fixtures record: severity and code, never the wording.</summary>
    public string Signature() =>
        string.Create(
            CultureInfo.InvariantCulture, $"{SeverityText} {Code} {Line}:{Column}");

    public override string ToString() =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{SeverityText} {Code} (line {Line}, col {Column}): {Message}");
}

/// <summary>A config refused before it ran, carrying every complaint rather than only the first.</summary>
public sealed class TdcDiagnosticException : Exception
{
    public TdcDiagnosticException(IReadOnlyList<Diagnostic> diagnostics, string source)
        : base(Summarize(diagnostics))
    {
        Diagnostics = diagnostics;
        Source = source;
    }

    public IReadOnlyList<Diagnostic> Diagnostics { get; }

    /// <summary>
    /// The config text, so a caller can show the offending line.
    /// </summary>
    /// <remarks>
    /// A diagnostic names a line and a column; without the text those are coordinates into
    /// something the reader has to go and find. Carrying the source is what makes the complaint act
    /// on rather than look up.
    /// </remarks>
    public new string Source { get; }

    private static string Summarize(IReadOnlyList<Diagnostic> diagnostics)
    {
        IReadOnlyList<Diagnostic> errors =
            diagnostics.Where(d => d.Severity == Severity.Error).ToList();
        IReadOnlyList<Diagnostic> shown = errors.Count > 0 ? errors : diagnostics;
        return shown.Count switch
        {
            0 => "the config was refused",
            1 => shown[0].ToString(),
            _ => $"{shown[0]} (and {shown.Count - 1} more)",
        };
    }
}
