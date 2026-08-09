using System.Globalization;
using System.Net;
using System.Text;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="http" src="https://…"&gt;</c> — values from a service the user runs.
/// </summary>
/// <remarks>
/// <para>
/// The escape hatch. Some values cannot come from a list or a pattern: a real tokeniser, a model, a
/// legacy system that owns the numbering. Rather than grow the DSL until it can express every such
/// thing, a config can point at a service and let it answer.
/// </para>
/// <para>
/// One call carries a whole batch, never one row. That is what keeps a million rows to a handful of
/// requests instead of a million, and it is why the wire format is line-based: the inputs go up one
/// per line and the values come back one per line, in the same order.
/// </para>
/// <para>
/// An http column is <b>not reproducible</b> — the service decides the values, and the engine cannot
/// promise what it does not control. What it can do is hand the service what it needs to be
/// reproducible on its own, which is the derived seed below.
/// </para>
/// </remarks>
public static class HttpGen
{
    private const long DefaultTimeoutMs = 30_000;

    /// <summary>What <c>on_error</c> may say.</summary>
    public enum OnErrorMode
    {
        Fail,
        Empty,
    }

    /// <summary>Why a call failed.</summary>
    public enum FailureKind
    {
        Status,
        RateLimited,
        Timeout,
        Network,
        CountMismatch,
        TooLarge,
    }

    /// <summary>
    /// The most of a reply this client will hold. The wire contract is one value per line for
    /// <c>count</c> rows — a bounded, known-small answer — so a body past the cap is a misbehaving
    /// service, and reading it out would trade an error message for exhausted memory. The same
    /// limit lives in the other four implementations.
    /// </summary>
    private const int MaxResponseBytes = 64 * 1024 * 1024;

    public sealed class ServiceException : Exception
    {
        internal ServiceException(string message, FailureKind kind, string url, int? status)
            : base(message)
        {
            Kind = kind;
            Url = url;
            Status = status;
        }

        public FailureKind Kind { get; }

        public string Url { get; }

        public int? Status { get; }
    }

    /// <summary>
    /// One client for the process.
    /// </summary>
    /// <remarks>
    /// .NET's own guidance, and load-bearing here: a fresh HttpClient per call leaks sockets in
    /// TIME_WAIT, and a run that batches a million rows makes enough calls to exhaust the ephemeral
    /// port range on a machine that would otherwise be idle.
    /// </remarks>
    private static readonly HttpClient Client = new()
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    /// <summary>
    /// <c>hex(HMAC-SHA256(secret, timestamp \n seed \n count \n body))</c>.
    /// </summary>
    /// <remarks>
    /// Everything that decides what comes back is inside: change the body, the count, the seed or
    /// the minute, and the signature no longer matches. The secret is the key, so it is never
    /// sent — which is what makes this safe over plain http on a trusted network, and what makes a
    /// captured request useless tomorrow once the service checks the timestamp.
    /// </remarks>
    public static string SignRequest(
        string secret, string timestamp, string seed, int count, string body)
    {
        string message = $"{timestamp}\n{seed}\n{count.ToString(CultureInfo.InvariantCulture)}\n{body}";
        using var mac = new System.Security.Cryptography.HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(mac.ComputeHash(Encoding.UTF8.GetBytes(message))).ToLowerInvariant();
    }

    /// <summary>
    /// Run one batch and return exactly <paramref name="count"/> values.
    /// </summary>
    /// <param name="inputs">One line per input value, in row order; <c>null</c> for a pure source.</param>
    public static IReadOnlyList<string> Fetch(
        string src, int count, IReadOnlyList<string>? inputs, string? seed, OnErrorMode onError,
        long timeoutMs)
        => Fetch(src, count, inputs, seed, onError, timeoutMs, null);

    /// <summary>The same, signed with an already-resolved <c>secret=</c>.</summary>
    /// <param name="secret">
    /// The key to sign with, or <c>null</c> to send the request unsigned. The secret itself never
    /// goes on the wire — see <see cref="SignRequest"/>.
    /// </param>
    public static IReadOnlyList<string> Fetch(
        string src, int count, IReadOnlyList<string>? inputs, string? seed, OnErrorMode onError,
        long timeoutMs, string? secret)
    {
        if (count <= 0)
        {
            return Array.Empty<string>();
        }

        string body = inputs is null ? "" : string.Join("\n", inputs);

        using var request = new HttpRequestMessage(HttpMethod.Post, src)
        {
            Content = new StringContent(body, Encoding.UTF8, "text/plain"),
        };
        request.Headers.TryAddWithoutValidation(
            "X-TDC-Count", count.ToString(CultureInfo.InvariantCulture));
        if (seed is not null)
        {
            request.Headers.TryAddWithoutValidation("X-TDC-Seed", seed);
        }

        // `X-TDC-Input` closes an ambiguity the body alone cannot: `in=` naming a column of one
        // empty value sends an empty body, byte for byte what a pure source sends, and the service
        // invented a value where it had been asked to process one. Absent keeps the old reading,
        // so a service written before this header is unaffected.
        if (inputs is not null)
        {
            request.Headers.TryAddWithoutValidation(
                "X-TDC-Input", inputs.Count.ToString(CultureInfo.InvariantCulture));
        }

        if (!string.IsNullOrEmpty(secret))
        {
            // The REAL clock, not the run's pinned `now`: the timestamp exists so a service can
            // refuse a request replayed tomorrow, and a config pinned to last year would otherwise
            // be refused by every service that checks.
            string timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                .ToString(CultureInfo.InvariantCulture);
            request.Headers.TryAddWithoutValidation("X-TDC-Timestamp", timestamp);
            request.Headers.TryAddWithoutValidation(
                "X-TDC-Signature", SignRequest(secret, timestamp, seed ?? "", count, body));
        }

        HttpResponseMessage response;
        byte[] raw;
        // The timeout is per call, so it is a cancellation token rather than a property of the
        // shared client — one config's timeout= must not become every other config's.
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(timeoutMs));
        try
        {
            response = Client.Send(request, timeout.Token);
            // Read through a hard cap, not to the end — see MaxResponseBytes.
            using Stream stream = response.Content.ReadAsStream(timeout.Token);
            raw = ReadBounded(stream);
        }
        catch (OperationCanceledException)
        {
            return Fail(
                new ServiceException(
                    $"did not answer within {timeoutMs}ms", FailureKind.Timeout, src, null),
                count, onError);
        }
        catch (Exception e) when (e is HttpRequestException or IOException)
        {
            return Fail(
                new ServiceException(
                    $"could not be reached ({e.Message})", FailureKind.Network, src, null),
                count, onError);
        }

        using (response)
        {
            int status = (int)response.StatusCode;
            if (raw.Length > MaxResponseBytes)
            {
                return Fail(
                    new ServiceException(
                        $"answered with more than {MaxResponseBytes} bytes — not a per-line reply",
                        FailureKind.TooLarge, src, status),
                    count, onError);
            }
            string text = Encoding.UTF8.GetString(raw);
            if (status == 429)
            {
                // The one failure on_error cannot soften. "Slow down" and "give me the whole
                // column" cannot both be honoured, and pretending otherwise yields quietly
                // truncated data.
                throw new ServiceException(
                    "returned 429 (rate limited)", FailureKind.RateLimited, src, 429);
            }

            if (status is < 200 or >= 300)
            {
                return Fail(
                    new ServiceException($"returned {status}", FailureKind.Status, src, status),
                    count, onError);
            }

            IReadOnlyList<string> lines = SplitLines(text);
            if (lines.Count != count)
            {
                return Fail(
                    new ServiceException(
                        $"returned {lines.Count} line(s) for a batch of {count}",
                        FailureKind.CountMismatch, src, status),
                    count, onError);
            }

            return lines;
        }
    }

    private static IReadOnlyList<string> Fail(
        ServiceException e, int count, OnErrorMode onError) =>
        onError == OnErrorMode.Empty
            ? Enumerable.Repeat("", count).ToArray()
            : throw e;

    /// <summary>The reply, tolerating one trailing newline.</summary>
    /// <summary>Up to MaxResponseBytes + 1 bytes of the stream — enough to know it overflowed.</summary>
    private static byte[] ReadBounded(Stream stream)
    {
        using var buffer = new MemoryStream();
        byte[] chunk = new byte[64 * 1024];
        while (buffer.Length <= MaxResponseBytes)
        {
            int read = stream.Read(chunk, 0, chunk.Length);
            if (read <= 0)
            {
                break;
            }
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static IReadOnlyList<string> SplitLines(string text)
    {
        if (text.Length == 0)
        {
            return Array.Empty<string>();
        }

        string trimmed = text.EndsWith('\n') ? text[..^1] : text;
        return trimmed.Split('\n');
    }

    /// <summary>
    /// The value sent as <c>X-TDC-Seed</c>: eight hex digits from the run's seed and the sequence
    /// name, through the same hash the engine keys its own streams with.
    /// </summary>
    /// <remarks>
    /// Derived per sequence rather than passed through. Two http sequences pointed at one service
    /// would otherwise receive the same seed, and a service that generates from it would answer both
    /// with an identical column.
    /// </remarks>
    public static string SeedFor(string envSeed, string sequenceName)
    {
        int a = Prng.Prng.Cyrb128(envSeed + "|http|" + sequenceName)[0];
        return ((uint)a).ToString("x8", CultureInfo.InvariantCulture);
    }

    /// <summary><c>timeout="30"</c> is thirty seconds. Anything unusable falls back to the default.</summary>
    public static long TimeoutMs(string? raw)
    {
        if (raw is null)
        {
            return DefaultTimeoutMs;
        }

        return double.TryParse(
                raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double seconds)
            && double.IsFinite(seconds) && seconds > 0
            ? (long)(seconds * 1000)
            : DefaultTimeoutMs;
    }

    public static OnErrorMode OnError(IReadOnlyDictionary<string, string> attrs) =>
        attrs.GetValueOrDefault("on_error") == "empty" ? OnErrorMode.Empty : OnErrorMode.Fail;

    /// <summary>Why a <c>secret=</c> could not be turned into bytes.</summary>
    public sealed class SecretException : Exception
    {
        public SecretException(string message)
            : base(message)
        {
        }
    }

    /// <summary><c>secret="…"</c> → the bytes to sign with.</summary>
    /// <remarks>
    /// The secret is the one thing in a run that must not travel: it never goes on the wire (only
    /// a signature derived from it does) and it should not travel into version control either,
    /// which is what a config does. So the two spellings that keep it out of the file come first,
    /// and the literal is accepted — with TDC284 saying why it is a poor idea — rather than
    /// refused, because a service on 127.0.0.1 for an afternoon is a real use. An empty secret is
    /// refused wherever it came from: signing with nothing produces a signature every caller could
    /// forge, which is worse than not signing at all.
    /// </remarks>
    public static string ResolveSecret(string spec, string baseDir)
    {
        string trimmed = spec.Trim();
        if (trimmed.StartsWith("env:", StringComparison.Ordinal))
        {
            string name = trimmed.Substring(4).Trim();
            if (name.Length == 0)
            {
                throw new SecretException("secret=\"env:\" names no variable");
            }

            string? value = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SecretException(
                    $"secret=\"env:{name}\" — the environment variable is not set, or is empty");
            }

            return value.Trim();
        }

        if (trimmed.StartsWith("file:", StringComparison.Ordinal))
        {
            string raw = trimmed.Substring(5).Trim();
            if (raw.Length == 0)
            {
                throw new SecretException("secret=\"file:\" names no file");
            }

            string path = ExpandHome(raw);
            if (!Path.IsPathRooted(path))
            {
                path = Path.Combine(baseDir, path);
            }

            string text;
            try
            {
                text = File.ReadAllText(path);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw new SecretException(
                    $"secret=\"file:{raw}\" could not be read ({e.Message})");
            }

            // Trimmed because a key file written by a person almost always ends in a newline, and
            // a signature that silently includes it agrees with nothing.
            string value = text.Trim();
            if (value.Length == 0)
            {
                throw new SecretException($"secret=\"file:{raw}\" is empty");
            }

            return value;
        }

        if (trimmed.Length == 0)
        {
            throw new SecretException("secret=\"\" is empty");
        }

        return trimmed;
    }

    private static string ExpandHome(string path)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (path == "~")
        {
            return home;
        }

        return path.StartsWith("~/", StringComparison.Ordinal) && home.Length > 0
            ? Path.Combine(home, path.Substring(2))
            : path;
    }

}
