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
