namespace Tdcv2.Parser;

/// <summary>
/// An attribute value as the lexer hands it over — quotes included — and the text between them.
/// </summary>
/// <remarks>
/// A value is quoted with <c>"</c> or with <c>'</c> and closes with the quote it opened with.
/// Nothing inside is escaped, so the other kind of quote is how a value holds one:
/// <c>value='say "hi"'</c>.
/// </remarks>
public static class AttrQuote
{
    /// <summary>Whether <c>text</c> is a whole quoted value, either kind of quote.</summary>
    public static bool IsQuoted(string text) =>
        text.Length >= 2 && (text[0] == '"' || text[0] == '\'') && text[^1] == text[0];

    /// <summary>The text between the quotes, or <c>text</c> itself when it is not quoted.</summary>
    public static string Unquote(string text) => IsQuoted(text) ? text[1..^1] : text;
}
