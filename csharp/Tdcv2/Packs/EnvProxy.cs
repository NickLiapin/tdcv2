namespace Tdcv2.Packs;

/// <summary>
/// Which proxy a registry request goes through, read from the environment the way curl and npm
/// read it — the same rule in all five implementations.
/// </summary>
/// <remarks>
/// <para>
/// .NET would read these variables on its own, once, when the process first makes a request. The
/// rule is spelled out here instead so that it is the SAME rule the other four apply — the order
/// of the variables, what <c>no_proxy</c> matches — and so that the proxy a failure went through
/// can be named in the message.
/// </para>
/// <list type="bullet">
/// <item>An <c>https</c> address takes the first non-empty of <c>https_proxy</c>,
/// <c>HTTPS_PROXY</c>, <c>all_proxy</c>, <c>ALL_PROXY</c>; an <c>http</c> one <c>http_proxy</c>,
/// <c>HTTP_PROXY</c>, <c>all_proxy</c>, <c>ALL_PROXY</c>.</item>
/// <item><c>no_proxy</c> (or <c>NO_PROXY</c>) is a comma-separated list of hosts that go direct:
/// <c>*</c> for all, otherwise a host matches an entry it equals or ends with after a dot, with a
/// leading dot and a port ignored.</item>
/// <item>A value with no scheme is an <c>http://</c> proxy.</item>
/// </list>
/// </remarks>
internal static class EnvProxy
{
    /// <summary>The proxy an address goes through, and the variable that named it.</summary>
    /// <param name="Shown">The proxy as <c>scheme://host:port</c>, the port always spelled out and
    /// the credentials left out — this is what an error message prints.</param>
    internal sealed record Choice(string Shown, string Variable, Uri Proxy);

    /// <summary>The proxy for <paramref name="target"/>, or <c>null</c> to go direct.</summary>
    internal static Choice? For(Uri target)
    {
        string scheme = target.Scheme.ToLowerInvariant();
        if (scheme is not ("http" or "https") || Bypassed(target.Host))
        {
            return null;
        }

        string[] names = scheme == "https"
            ? new[] { "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY" }
            : new[] { "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY" };
        foreach (string name in names)
        {
            string value = Read(name);
            if (value.Length == 0)
            {
                continue;
            }

            string written = value.Contains("://", StringComparison.Ordinal) ? value : "http://" + value;
            if (!Uri.TryCreate(written, UriKind.Absolute, out Uri? proxy) || proxy.Host.Length == 0)
            {
                throw new PackRegistry.PackException(
                    $"{name}=\"{value}\" is not a proxy address — write it as http://host:port");
            }

            string shown = $"{proxy.Scheme}://{proxy.Host}:{proxy.Port}";
            return new Choice(shown, name, proxy);
        }

        return null;
    }

    /// <summary>Whether <paramref name="host"/> is listed in <c>no_proxy</c> / <c>NO_PROXY</c>.</summary>
    internal static bool Bypassed(string host)
    {
        string list = Read("no_proxy");
        if (list.Length == 0)
        {
            list = Read("NO_PROXY");
        }

        string h = host.ToLowerInvariant();
        foreach (string raw in list.Split(','))
        {
            string entry = raw.Trim().ToLowerInvariant();
            if (entry == "*")
            {
                return true;
            }

            if (entry.StartsWith('.'))
            {
                entry = entry[1..];
            }

            int colon = entry.LastIndexOf(':');
            if (colon > 0 && entry.IndexOf(':') == colon)
            {
                entry = entry[..colon];
            }

            if (entry.Length > 0 && (h == entry || h.EndsWith("." + entry, StringComparison.Ordinal)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>A client for one request, going through <paramref name="choice"/> or direct.</summary>
    internal static HttpClient ClientFor(Choice? choice, TimeSpan timeout)
    {
        var handler = new HttpClientHandler();
        if (choice is null)
        {
            handler.UseProxy = false;
        }
        else
        {
            var proxy = new System.Net.WebProxy(new Uri($"{choice.Proxy.Scheme}://{choice.Proxy.Authority}"));
            string[] credentials = choice.Proxy.UserInfo.Split(':', 2);
            if (credentials[0].Length > 0)
            {
                proxy.Credentials = new System.Net.NetworkCredential(
                    Uri.UnescapeDataString(credentials[0]),
                    credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : "");
            }

            handler.Proxy = proxy;
            handler.UseProxy = true;
        }

        return new HttpClient(handler) { Timeout = timeout };
    }

    private static string Read(string name) => (Environment.GetEnvironmentVariable(name) ?? "").Trim();
}
