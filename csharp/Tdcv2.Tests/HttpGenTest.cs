using System.Net;
using System.Text;
using Tdcv2.Engine;
using Tdcv2.Generators;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// The http generator, against a service that runs for the length of the test.
/// </summary>
/// <remarks>
/// A stub rather than a mocked client: the contract here is a wire contract — one POST carrying the
/// whole batch, the count in a header, one value per line back in the same order — and a mock would
/// verify the code's idea of that contract rather than the contract.
/// </remarks>
public class HttpGenTest : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _prefix;
    private Func<string, IReadOnlyDictionary<string, string>, (int Status, string Body)> _handler =
        (_, _) => (200, "");

    /// <summary>The requests the service saw, so a test can assert on what went up as well as down.</summary>
    private readonly List<(string Body, IReadOnlyDictionary<string, string> Headers)> _seen = new();

    public HttpGenTest()
    {
        // A port the OS picks: a fixed one turns two test runs on the same machine into a flake.
        var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        int port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();

        _prefix = $"http://127.0.0.1:{port}/";
        _listener.Prefixes.Add(_prefix);
        _listener.Start();
        Task.Run(Serve);
    }

    private async Task Serve()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync();
            }
            catch (Exception)
            {
                return;
            }

            using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
            string body = await reader.ReadToEndAsync();
            var headers = context.Request.Headers.AllKeys
                .Where(k => k is not null)
                .ToDictionary(k => k!, k => context.Request.Headers[k] ?? "", StringComparer.OrdinalIgnoreCase);

            lock (_seen)
            {
                _seen.Add((body, headers));
            }

            (int status, string reply) = _handler(body, headers);
            context.Response.StatusCode = status;
            byte[] bytes = Encoding.UTF8.GetBytes(reply);
            context.Response.ContentLength64 = bytes.Length;
            await context.Response.OutputStream.WriteAsync(bytes);
            context.Response.Close();
        }
    }

    public void Dispose()
    {
        _listener.Stop();
        _listener.Close();
    }

    private void Answer(Func<string, IReadOnlyDictionary<string, string>, (int, string)> handler) =>
        _handler = handler;

    [Fact]
    public void OneCallCarriesTheWholeBatch()
    {
        Answer((body, headers) =>
        {
            int n = int.Parse(headers["X-TDC-Count"]);
            return (200, string.Join("\n", Enumerable.Range(1, n).Select(i => $"v{i}")) + "\n");
        });

        IReadOnlyList<string> values =
            HttpGen.Fetch(_prefix, 4, null, "abc", HttpGen.OnErrorMode.Fail, 5000);

        Assert.Equal(new[] { "v1", "v2", "v3", "v4" }, values);
        // A million rows must cost a handful of requests, not a million.
        Assert.Single(_seen);
    }

    [Fact]
    public void InputsGoUpOnePerLineAndValuesComeBackInOrder()
    {
        Answer((body, _) =>
            (200, string.Join("\n", body.Split('\n').Select(line => line.ToUpperInvariant()))));

        IReadOnlyList<string> values = HttpGen.Fetch(
            _prefix, 3, new[] { "one", "two", "three" }, null, HttpGen.OnErrorMode.Fail, 5000);

        Assert.Equal(new[] { "ONE", "TWO", "THREE" }, values);
        Assert.Equal("one\ntwo\nthree", _seen[0].Body);
    }

    [Fact]
    public void AWrongLineCountIsAFailureNotATruncation()
    {
        // Silently keeping the first N would leave a column short by an amount nobody would notice
        // until something downstream indexed past its end.
        Answer((_, _) => (200, "only-one\n"));

        HttpGen.ServiceException e = Assert.Throws<HttpGen.ServiceException>(
            () => HttpGen.Fetch(_prefix, 3, null, null, HttpGen.OnErrorMode.Fail, 5000));
        Assert.Equal(HttpGen.FailureKind.CountMismatch, e.Kind);
    }

    [Fact]
    public void OnErrorEmptyBlanksTheColumnAndCarriesOn()
    {
        Answer((_, _) => (500, "boom"));

        Assert.Equal(
            new[] { "", "", "" },
            HttpGen.Fetch(_prefix, 3, null, null, HttpGen.OnErrorMode.Empty, 5000));
    }

    [Fact]
    public void RateLimitingIsTheOneFailureOnErrorCannotSoften()
    {
        Answer((_, _) => (429, "slow down"));

        // "Slow down" and "give me the whole column" cannot both be honoured, and pretending
        // otherwise yields quietly truncated data.
        HttpGen.ServiceException e = Assert.Throws<HttpGen.ServiceException>(
            () => HttpGen.Fetch(_prefix, 3, null, null, HttpGen.OnErrorMode.Empty, 5000));
        Assert.Equal(HttpGen.FailureKind.RateLimited, e.Kind);
    }

    [Fact]
    public void TwoSequencesOnOneServiceGetDifferentSeeds()
    {
        // Otherwise a service that generates from the seed would answer both with the same column.
        Assert.NotEqual(HttpGen.SeedFor("run", "A"), HttpGen.SeedFor("run", "B"));
        // And the same sequence in the same run always gets the same one.
        Assert.Equal(HttpGen.SeedFor("run", "A"), HttpGen.SeedFor("run", "A"));
        Assert.Matches("^[0-9a-f]{8}$", HttpGen.SeedFor("run", "A"));
    }

    [Theory]
    [InlineData(null, 30_000L)]
    [InlineData("2", 2_000L)]
    [InlineData("0.5", 500L)]
    // Unusable values fall back rather than making the run hang or fail instantly.
    [InlineData("not-a-number", 30_000L)]
    [InlineData("-1", 30_000L)]
    public void TimeoutIsInSeconds(string? raw, long expected) =>
        Assert.Equal(expected, HttpGen.TimeoutMs(raw));

    [Fact]
    public void TheEngineFeedsAnEarlierSequenceThroughIn()
    {
        Answer((body, _) =>
            (200, string.Join("\n", body.Split('\n').Select(line => $"[{line}]"))));

        string config =
            "<tdc><env count=\"3\" seed=\"svc\" mode=\"memory\">"
            + "<sequence name=\"Code\"><gen type=\"increment\" value=\"1\"/></sequence>"
            + $"<sequence name=\"Token\"><gen type=\"http\" src=\"{_prefix}\" in=\"Code\"/></sequence>"
            + "</env><block><line><data>${{Token}}</data></line></block></tdc>";

        string rendered = Engines.Render(
            ConfigBuilder.Build(TdcParserFacade.Parse(config).Tree));

        Assert.Equal("[1]\n[2]\n[3]\n", rendered);
    }
}
