using Tdcv2.Errors;

namespace Tdcv2.Tests;

/// <summary>
/// What the carets cover.
/// </summary>
/// <remarks>
/// The position a diagnostic carries is pinned by the shared fixtures; how much of the line it
/// underlines is not, and it is the difference between being shown the mistake and being shown
/// where to start looking. These are the two shapes a position ever has, and the two that would be
/// easy to get wrong.
/// </remarks>
public class UnderlineTest
{
    private static string Carets(string source, int line, int column)
    {
        string text = DiagnosticRenderer.Format(
            Diagnostic.Error("TDC000", "x", string.Empty, line, column), source, "t.tdc", false);
        foreach (string l in text.Split('\n'))
        {
            if (l.Contains('^', StringComparison.Ordinal))
            {
                return l.Trim().TrimStart('|').Trim();
            }
        }

        return string.Empty;
    }

    private static string Carets(int n) => new('^', n);

    [Fact]
    public void AValueIsUnderlinedToItsClosingQuote() =>
        Assert.Equal(
            Carets("notanumber".Length),
            Carets("<gen type=\"number\" value=\"notanumber\"/>", 1, 26));

    [Fact]
    public void AnElementIsUnderlinedWholeChildrenAndAll() =>
        // Not to the first ">": that would stop at the opening tag and leave the body — the part
        // being complained about — unmarked.
        Assert.Equal(
            Carets("<data>${{Nope}}</data>".Length),
            Carets("<block><line><data>${{Nope}}</data></line></block>", 1, 13));

    [Fact]
    public void ASelfClosingElementStopsAtItsOwnSlash() =>
        Assert.Equal(
            Carets("<gen type=\"file\" row=\"k\"/>".Length),
            Carets("<sequence name=\"B\"><gen type=\"file\" row=\"k\"/></sequence>", 1, 19));

    [Fact]
    public void AGreaterThanInsideAValueDoesNotEndTheTag()
    {
        const string source = "<data value=\"a>b\"/>";
        Assert.Equal(Carets(source.Length), Carets(source, 1, 0));
    }

    [Fact]
    public void ACommentIsNotATag() =>
        // "<!--" starts with "<" and is not an element; underlining it whole would point at the
        // comment rather than at the empty document being complained about.
        Assert.Equal("^", Carets("<!-- nothing here -->", 1, 0));

    [Fact]
    public void APositionPastTheEndOfTheLineStillRenders() =>
        Assert.Equal("^", Carets("<tdc/>", 1, 99));

    [Fact]
    public void ASyntaxErrorMarksTheCharacterItStoppedOn()
    {
        // The parser complains about a position, not about a span — whatever happens to begin
        // there is not what it was complaining about. So the caret stays put, even where a value
        // or an element starts and the width could be read off the line.
        const string source = "<data pair=\"alpha\">x</data>";
        string carets = DiagnosticRenderer
            .Format(Diagnostic.ErrorAt("TDC001", "unclosed <data pair=\"alpha\">", "", 1, 0),
                source, "t.tdc", false)
            .Split('\n')
            .First(l => l.Contains('^', StringComparison.Ordinal));

        Assert.Equal("^", carets.Trim().TrimStart('|').Trim());

        // And the same position, asked about as a span, still covers the element.
        Assert.Equal(Carets(source.Length), Carets(source, 1, 0));
    }
}
