namespace Tdcv2.Generators;

/// <summary>
/// What a backslash means once the classes (<c>\d</c>, <c>\w</c>, <c>\s</c>, …) are out of the way.
/// </summary>
/// <remarks>
/// Shared by <c>regex</c> and <c>advanced_regex</c> — the port of the reference's
/// <c>regex-escape.ts</c>. Until it, every other escape fell to one <c>default</c> arm that
/// returned the escaped character, so <c>\x41</c> printed <c>x41</c> and
/// <c>\bINV-\d{6}\b</c> printed <c>bINV-123456b</c> after a clean check.
/// <list type="bullet">
/// <item><c>\xHH</c>, <c>\uHHHH</c> — the character with that code</item>
/// <item><c>\b \B \A \Z \z \G</c> — refused: a generated value has nothing around it to assert</item>
/// <item>any other ASCII letter — refused: never the letter itself</item>
/// </list>
/// Punctuation stays the character, as it always was.
/// </remarks>
internal static class RegexEscape
{
    /// <summary>The literal an escape stands for, or a refusal naming why it cannot be one.</summary>
    internal static string EscapedLiteral(string ch, Func<string, Exception> fail)
    {
        if (ch.Length == 1 && "bBAZzG".Contains(ch[0], StringComparison.Ordinal))
        {
            throw fail(
                $"\"\\{ch}\" is a zero-width assertion, and a generated value has nothing around it "
                + "to assert — remove it");
        }

        if (ch.Length == 1 && ch[0] is >= 'a' and <= 'z' or >= 'A' and <= 'Z')
        {
            throw fail(
                $"unknown escape \"\\{ch}\" — write the letter without the backslash, or \\xHH or "
                + "\\uHHHH for a character by its code");
        }

        return ch;
    }

    /// <summary><c>\xHH</c> or <c>\uHHHH</c>, the <c>x</c> or <c>u</c> already read.</summary>
    internal static string HexEscape(string kind, Func<string?> next, Func<string, Exception> fail)
    {
        int digits = kind == "x" ? 2 : 4;
        var hex = new System.Text.StringBuilder();
        for (int i = 0; i < digits; i++)
        {
            string? c = next();
            if (c is null || c.Length != 1 || !Uri.IsHexDigit(c[0]))
            {
                throw fail(
                    $"\"\\{kind}\" needs exactly {digits} hex digits, as in "
                    + (kind == "x" ? "\\x41" : "\\u0410"));
            }

            hex.Append(c);
        }

        int code = Convert.ToInt32(hex.ToString(), 16);
        if (code is >= 0xD800 and <= 0xDFFF)
        {
            throw fail($"\"\\u{hex}\" is half of a surrogate pair — write the character itself");
        }

        return char.ConvertFromUtf32(code);
    }
}
