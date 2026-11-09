using System.Net;
using System.Text;
using System.Text.Json;
using Tdcv2.Engine;
using Tdcv2.Parser;
using Tdcv2.Validation;

namespace Tdcv2.Tests;

/// <summary>
/// <c>fixtures/cross-language/http-batches.json</c>, against a real local service.
/// </summary>
/// <remarks>
/// The other four implementations run the same file; between them they hold the batch contract —
/// what each request carries, where each answer lands, and what a column reading an answer sees —
/// to one behaviour.
/// </remarks>
public class HttpBatchesTest
{
    private sealed record Seen(int Count, int Offset, int? Total, int? Input);

    private static JsonElement Fixture() =>
        JsonDocument.Parse(
                File.ReadAllText(Path.Combine(PrngVectorsTest.FixturesDir(), "http-batches.json")))
            .RootElement;

    /// <summary>A running copy of one of the fixture's services.</summary>
    private sealed class Service : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly string _name;
        public readonly List<Seen> Seen = new();
        public readonly List<string> Seeds = new();

        public Service(string name)
        {
            _name = name;
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            int port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}/gen";
            _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            _listener.Start();
            Task.Run(Serve);
        }

        public string Url { get; }

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

                _ = Task.Run(() => Handle(context));
            }
        }

        private async Task Handle(HttpListenerContext context)
        {
            using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
            string body = await reader.ReadToEndAsync();
            var headers = context.Request.Headers;
            int count = int.Parse(headers["X-TDC-Count"] ?? "0");
            int offset = int.Parse(headers["X-TDC-Offset"] ?? "0");
            string? total = headers["X-TDC-Total"];
            string? declared = headers["X-TDC-Input"];
            string[] inputs = declared is null or "0"
                ? Array.Empty<string>()
                : body.Length == 0 ? new[] { "" } : body.Split('\n');
            int served;
            lock (Seen)
            {
                Seeds.Add(headers["X-TDC-Seed"] ?? "");
                Seen.Add(new Seen(
                    count,
                    offset,
                    total is null ? null : int.Parse(total),
                    declared is null ? null : int.Parse(declared)));
                served = Seen.Count;
            }

            int status = 200;
            var lines = new List<string>();
            bool echo = true;
            if (_name == "fail-second" && served > 1)
            {
                status = 500;
            }
            else if (_name is "upper" or "upper-no-echo")
            {
                lines.AddRange(inputs.Select(line => "H" + line));
                echo = _name == "upper";
            }
            else if (_name == "row-no-echo")
            {
                lines.AddRange(Enumerable.Range(0, count).Select(i => "r" + i));
                echo = false;
            }
            else
            {
                lines.AddRange(Enumerable.Range(0, count).Select(i => "r" + (offset + i)));
            }

            byte[] payload = Encoding.UTF8.GetBytes(string.Join("\n", lines));
            context.Response.StatusCode = status;
            context.Response.ContentType = "text/plain";
            if (echo)
            {
                context.Response.AddHeader("X-TDC-Offset", offset.ToString());
            }

            context.Response.ContentLength64 = payload.Length;
            await context.Response.OutputStream.WriteAsync(payload);
            context.Response.Close();
        }

        public void Dispose() => _listener.Close();
    }

    [Fact]
    public void EveryServiceTheFixtureNamesIsRunHere()
    {
        Assert.Equal(
            new[] { "fail-second", "row", "row-no-echo", "upper", "upper-no-echo" },
            Fixture().GetProperty("services").EnumerateObject().Select(p => p.Name)
                .OrderBy(n => n, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void AParallelSplitFallsOnBatchBoundariesSoNoBatchIsFetchedTwice()
    {
        // The same splits as the TypeScript and Python twins.
        Assert.Equal(new[] { (0, 40), (40, 70), (70, 100) }, ParallelWrite.Shards(100, 3, 10));
        Assert.Equal(new[] { (0, 50), (50, 95) }, ParallelWrite.Shards(95, 2, 10));
        Assert.Equal(new[] { (0, 10), (10, 20), (20, 25) }, ParallelWrite.Shards(25, 8, 10));
    }

    [Fact]
    public void EveryHttpGeneratorIsFoundWhereverItSits()
    {
        const string text =
            "<tdc><env count=\"3\" seed=\"s\">"
            + "<sequence name=\"K\"><gen type=\"text\" value=\"x,y\"/></sequence>"
            + "<switch name=\"S\" on=\"K\"><case is=\"x\"><gen type=\"http\""
            + " src=\"http://127.0.0.1:9/\" batch=\"4\"/></case><default><gen type=\"text\""
            + " value=\"-\"/></default></switch>"
            + "<sequence name=\"F\"><gen name=\"a\" type=\"http\" src=\"http://127.0.0.1:9/\""
            + " batch=\"6\"/><gen name=\"b\" type=\"text\" value=\"z\"/></sequence>"
            + "</env><block><line><data>${{S}}</data></line></block></tdc>";
        var config = ConfigBuilder.Build(TdcParserFacade.Parse(text).Tree);
        Assert.Equal(
            new[] { 4, 6 }, Tdcv2.Generators.HttpColumn.BatchesIn(config).OrderBy(n => n).ToArray());
        Assert.Equal(12, Tdcv2.Generators.HttpColumn.Alignment(config));
    }

    // Every engine reads the same batches: the in-memory one a column at a time, the two
    // streaming ones a row at a time. "auto" is the router's choice.
    public static IEnumerable<object[]> Cases() =>
        Fixture().GetProperty("cases").EnumerateArray()
            .SelectMany(c => new[] { "auto", "1", "2", "3" }
                .Select(engine => new object[] { c.GetProperty("name").GetString()!, engine }));

    [Theory]
    [MemberData(nameof(Cases))]
    public void ASharedHttpCase(string name, string engine)
    {
        JsonElement c = Fixture().GetProperty("cases").EnumerateArray()
            .First(x => x.GetProperty("name").GetString() == name);
        using var service = new Service(c.GetProperty("service").GetString()!);
        string text = c.GetProperty("config").GetString()!.Replace("{{SRC}}", service.Url);

        var parsed = TdcParserFacade.Parse(text);
        var refusals = Validator.Validate(parsed.Tree)
            .Where(d => d.Severity == Tdcv2.Errors.Severity.Error)
            .Select(d => $"{d.Code} {d.Message}")
            .ToList();
        Assert.Empty(refusals);
        var built = ConfigBuilder.Build(parsed.Tree);
        var config = engine == "auto" ? built : built.WithEngineSelection(engine, built.Mode);

        if (c.TryGetProperty("error", out JsonElement error))
        {
            string want = error.GetString()!.Replace("{{SRC}}", service.Url);
            Exception e = Assert.ThrowsAny<Exception>(() => Engines.Render(config));
            Assert.Contains(want, e.Message);
        }
        else
        {
            Assert.Equal(c.GetProperty("output").GetString(), Engines.Render(config));
        }

        if (c.TryGetProperty("requests", out JsonElement requests))
        {
            var want = requests.EnumerateArray()
                .Select(r => new Seen(
                    r.GetProperty("count").GetInt32(),
                    r.GetProperty("offset").GetInt32(),
                    r.GetProperty("total").ValueKind == JsonValueKind.Null
                        ? null
                        : r.GetProperty("total").GetInt32(),
                    r.GetProperty("input").ValueKind == JsonValueKind.Null
                        ? null
                        : r.GetProperty("input").GetInt32()))
                .ToList();
            List<Seen> seen;
            lock (service.Seen)
            {
                seen = service.Seen.OrderBy(s => s.Offset).ToList();
            }

            Assert.Equal(want, seen);
        }

        if (c.TryGetProperty("seeds", out JsonElement seeds))
        {
            var want = seeds.EnumerateArray().Select(s => s.GetString()!).ToList();
            List<string> got;
            lock (service.Seen)
            {
                got = service.Seeds.OrderBy(s => s, StringComparer.Ordinal).ToList();
            }

            Assert.Equal(want, got);
        }
    }
}
