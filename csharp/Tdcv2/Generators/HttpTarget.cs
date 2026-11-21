using System.Text;

namespace Tdcv2.Generators;

/// <summary>
/// The request target of an <c>http</c> generator — the path and query of <c>src=</c>, written
/// once, the way it goes on the wire.
/// </summary>
/// <remarks>
/// <para>
/// It is signed (<c>X-TDC-Signature</c> covers it), so the bytes TDC signs and the bytes the
/// service reads off the request line have to be the same bytes. The five implementations send
/// through five different HTTP clients, and handed the same URL they do NOT send the same request
/// line, measured 2026-11-21:
/// </para>
/// <list type="bullet">
/// <item>.NET decodes <c>%41</c> to <c>A</c> and <c>%7e</c> to <c>~</c>, and upper-cases
/// <c>%d0</c> to <c>%D0</c>;</item>
/// <item>Node's fetch encodes <c>'</c> in the query as <c>%27</c> and drops an empty <c>?</c>;
/// Python, curl and .NET keep both;</item>
/// <item>curl and Node resolve <c>/a/../b</c> to <c>/b</c>; the others send it as written.</item>
/// </list>
/// <para>
/// So the target is not left to the client. It is computed here by one rule, the URL that is
/// actually sent is rebuilt from it, and every client is then handed a target it sends untouched —
/// which is what the same measurement showed for a target already in this form, in all five,
/// System.Uri included.
/// </para>
/// <para>The rule:</para>
/// <list type="number">
/// <item>everything after the host; <c>#fragment</c> dropped (no client sends it);</item>
/// <item>an empty query (<c>/a?</c>) is no query;</item>
/// <item><c>/</c> when nothing is left, and a leading <c>/</c> before a bare <c>?query</c>;</item>
/// <item>a <c>%XX</c> escape of an unreserved character (<c>A-Z a-z 0-9 - . _ ~</c>) is that
/// character — RFC 3986 §6.2.2.2, and what .NET does anyway; every other escape is kept, its hex
/// digits upper-cased (§6.2.2.1);</item>
/// <item>a <c>%</c> that does not start an escape is <c>%25</c>;</item>
/// <item>any other character outside
/// <c>A-Z a-z 0-9 - . _ ~ ! $ &amp; ( ) * + , ; = : @ / ?</c> is percent-encoded as its UTF-8
/// bytes — <c>'</c> included, because fetch encodes it in a query and nothing else does.</item>
/// </list>
/// <para>
/// <c>.</c> and <c>..</c> segments are the one shape no rule can settle — two clients resolve
/// them, three send them — so the validator refuses them (TDC066) and a config never reaches this
/// point with one.
/// </para>
/// <para>
/// The same rule lives in the other four implementations, held to
/// <c>fixtures/cross-language/http-vectors.json</c> (<c>target</c>).
/// </para>
/// </remarks>
/// <param name="Url">The URL handed to the HTTP client: scheme and host as written, then
/// <paramref name="Target"/>.</param>
/// <param name="Target">Path and query as they go on the request line — and into the
/// signature.</param>
public sealed record HttpTarget(string Url, string Target)
{
    /// <summary>What every TDC request is sent with. Signed, so a service can tell.</summary>
    public const string Method = "POST";

    /// <summary>Characters a target carries as they are. <c>'</c> is deliberately absent.</summary>
    private const string KeptPunctuation = "-._~!$&()*+,;=:@/?";

    private const string UnreservedPunctuation = "-._~";

    private static readonly char[] AsciiWhitespace = { ' ', '\t', '\r', '\n' };

    /// <summary>The URL to send and the target to sign, for one <c>src=</c>.</summary>
    public static HttpTarget Of(string src)
    {
        (string origin, string rest) = SplitSrc(src);
        string raw = rest;
        int hash = raw.IndexOf('#');
        if (hash >= 0)
        {
            raw = raw.Substring(0, hash);
        }

        int query = raw.IndexOf('?');
        if (query >= 0 && query == raw.Length - 1)
        {
            raw = raw.Substring(0, query);
        }

        if (!raw.StartsWith('/'))
        {
            raw = "/" + raw;
        }

        // By code point, not by UTF-16 unit: a character outside the BMP is one character and
        // four UTF-8 bytes, never two halves encoded on their own.
        Rune[] runes = raw.EnumerateRunes().ToArray();
        var target = new StringBuilder(raw.Length);
        for (int i = 0; i < runes.Length; i++)
        {
            Rune c = runes[i];
            if (c.Value == '%')
            {
                if (i + 2 < runes.Length && IsHexDigit(runes[i + 1]) && IsHexDigit(runes[i + 2]))
                {
                    string pair = string.Concat((char)runes[i + 1].Value, (char)runes[i + 2].Value);
                    char decoded = (char)Convert.ToInt32(pair, 16);
                    if (IsUnreserved(decoded))
                    {
                        target.Append(decoded);
                    }
                    else
                    {
                        target.Append('%').Append(pair.ToUpperInvariant());
                    }

                    i += 2;
                }
                else
                {
                    target.Append("%25");
                }
            }
            else if (c.IsAscii && IsKept((char)c.Value))
            {
                target.Append((char)c.Value);
            }
            else
            {
                AppendPercentEncoded(target, c);
            }
        }

        string signed = target.ToString();
        return new HttpTarget(origin + signed, signed);
    }

    /// <summary>The first <c>.</c> or <c>..</c> segment of the target's path, if it has one.</summary>
    /// <remarks>
    /// Read AFTER the rule above, so <c>%2e%2e</c> counts — Node's URL parser treats it as
    /// <c>..</c> too.
    /// </remarks>
    public static string? DotSegmentOf(string src)
    {
        string target = Of(src).Target;
        int query = target.IndexOf('?');
        string path = query < 0 ? target : target.Substring(0, query);
        return path.Split('/').FirstOrDefault(segment => segment is "." or "..");
    }

    /// <summary><c>src=</c> cut into what is sent as written (scheme, host, port) and what is not.</summary>
    private static (string Origin, string Tail) SplitSrc(string src)
    {
        string trimmed = src.Trim(AsciiWhitespace);
        int scheme = trimmed.IndexOf("://", StringComparison.Ordinal);
        int hostStart = scheme < 0 ? 0 : scheme + 3;
        for (int i = hostStart; i < trimmed.Length; i++)
        {
            char c = trimmed[i];
            if (c is '/' or '?' or '#')
            {
                return (trimmed.Substring(0, i), trimmed.Substring(i));
            }
        }

        return (trimmed, "");
    }

    /// <summary><c>%XX</c> for each UTF-8 byte of one character.</summary>
    private static void AppendPercentEncoded(StringBuilder target, Rune c)
    {
        Span<byte> bytes = stackalloc byte[4];
        int length = c.EncodeToUtf8(bytes);
        for (int i = 0; i < length; i++)
        {
            target.Append('%')
                .Append(bytes[i].ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    private static bool IsAsciiLetterOrDigit(char c) =>
        c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9');

    private static bool IsUnreserved(char c) =>
        IsAsciiLetterOrDigit(c) || UnreservedPunctuation.IndexOf(c) >= 0;

    private static bool IsKept(char c) =>
        IsAsciiLetterOrDigit(c) || KeptPunctuation.IndexOf(c) >= 0;

    private static bool IsHexDigit(Rune r) =>
        r.Value is (>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F');
}
