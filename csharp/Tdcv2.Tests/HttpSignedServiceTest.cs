using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Tdcv2.Generators;

namespace Tdcv2.Tests;

/// <summary>
/// A signed request, against a service that checks the signature over the request line it
/// actually received.
/// </summary>
/// <remarks>
/// The service reads the socket itself rather than going through HttpListener: the point is the
/// bytes System.Uri and HttpClient put on the wire, and a server that decodes or normalises the
/// target on the way in would check a different string than the one sent. Of the five clients,
/// .NET's is the one that rewrites a target handed to it (it decodes <c>%41</c> and upper-cases
/// <c>%d0</c>), so this is where a signed target that is not the sent target shows up as a 401.
/// </remarks>
public class HttpSignedServiceTest
{
    private const string Secret = "k7Fm2p-test-secret";

    /// <summary>What one request carried, as read off the socket.</summary>
    private sealed record Received(
        string Method, string Target, IReadOnlyDictionary<string, string> Headers, byte[] Body);

    /// <summary>A service that answers <c>ok-&lt;line&gt;</c> per input line, and 401 to a bad signature.</summary>
    private sealed class SignedService : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly byte[] _key;
        private readonly List<Received> _requests = new();

        public SignedService(string secret)
        {
            _key = Encoding.UTF8.GetBytes(secret);
            // A port the OS picks, held for the life of the service — no probe-then-bind race.
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            BaseUrl = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            Task.Run(Serve);
        }

        public string BaseUrl { get; }

        public IReadOnlyList<Received> Requests
        {
            get
            {
                lock (_requests)
                {
                    return _requests.ToArray();
                }
            }
        }

        private async Task Serve()
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync();
                }
                catch (Exception)
                {
                    return;
                }

                _ = Task.Run(() => Handle(client));
            }
        }

        private async Task Handle(TcpClient client)
        {
            using (client)
            {
                NetworkStream stream = client.GetStream();
                Received request = await Read(stream);
                lock (_requests)
                {
                    _requests.Add(request);
                }

                string Header(string name) => request.Headers.GetValueOrDefault(name, "");
                string body = Encoding.UTF8.GetString(request.Body);
                // The message a service written against the docs recomputes: the method and the
                // target exactly as they arrived on the request line, then the batch headers.
                string message = string.Join(
                    "\n",
                    request.Method,
                    request.Target,
                    Header("X-TDC-Timestamp"),
                    Header("X-TDC-Seed"),
                    Header("X-TDC-Count"),
                    Header("X-TDC-Offset"),
                    Header("X-TDC-Total"),
                    body);
                using var mac = new HMACSHA256(_key);
                string mine = Convert.ToHexString(mac.ComputeHash(Encoding.UTF8.GetBytes(message)))
                    .ToLowerInvariant();
                string signature = Header("X-TDC-Signature");

                (int status, string reply) = signature.Length > 0 && signature == mine
                    ? (200, string.Join("\n", body.Split('\n').Select(line => "ok-" + line)))
                    : (401, "bad signature");
                byte[] payload = Encoding.UTF8.GetBytes(reply);
                string head =
                    $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Unauthorized")}\r\n"
                    + "Content-Type: text/plain\r\n"
                    + $"Content-Length: {payload.Length}\r\n"
                    + "Connection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(head));
                await stream.WriteAsync(payload);
                await stream.FlushAsync();
            }
        }

        /// <summary>The request line, the headers and a Content-Length body, byte for byte.</summary>
        private static async Task<Received> Read(NetworkStream stream)
        {
            var head = new List<byte>();
            byte[] one = new byte[1];
            while (!(head.Count >= 4 && head[^4] == '\r' && head[^3] == '\n' && head[^2] == '\r'
                       && head[^1] == '\n'))
            {
                if (await stream.ReadAsync(one) == 0)
                {
                    throw new IOException("connection closed inside the request head");
                }

                head.Add(one[0]);
            }

            // Latin-1 maps each byte to one char, so a byte outside ASCII in the request line
            // stays visible instead of being folded into a decoded character.
            string[] lines = Encoding.Latin1.GetString(head.ToArray())
                .Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
            string[] requestLine = lines[0].Split(' ');
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string line in lines.Skip(1))
            {
                int colon = line.IndexOf(':');
                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }

            int length = int.Parse(headers.GetValueOrDefault("Content-Length", "0"));
            byte[] body = new byte[length];
            int read = 0;
            while (read < length)
            {
                int n = await stream.ReadAsync(body.AsMemory(read));
                if (n == 0)
                {
                    throw new IOException("connection closed inside the request body");
                }

                read += n;
            }

            return new Received(requestLine[0], requestLine[1], headers, body);
        }

        public void Dispose() => _listener.Stop();
    }

    /// <summary>
    /// Paths and queries in the shapes that differ between clients — an escape of a plain letter,
    /// lower-case hex, a quote in the query, a space, non-ASCII, an empty <c>?</c>, a fragment.
    /// Each only passes if what was signed is what went on the wire.
    /// </summary>
    [Theory]
    [InlineData("/%7eme/%d0%bf a?k=it's&v=%41")]
    [InlineData("/a/A~%2F%2f/b?x=%41&y=!$&()*+,;=:@/?z~&q=it's")]
    [InlineData("/пи/ %25[]|^`{}\"<>\\?k=%23%3F%2F")]
    [InlineData("/gen?")]
    [InlineData("/a..b/.x/x.?p=%zz#top")]
    [InlineData("/😀/100%")]
    [InlineData("?x=1")]
    [InlineData("")]
    public void IsAcceptedAtAnAddressTheFiveClientsWouldEachHaveSentDifferently(string tail)
    {
        using var service = new SignedService(Secret);
        string src = service.BaseUrl + tail;

        IReadOnlyList<string> values = HttpGen.Fetch(
            src, 1, new[] { "x" }, "abc123", HttpGen.OnErrorMode.Fail, 5000, Secret);

        Assert.Equal(new[] { "ok-x" }, values);
        Received seen = Assert.Single(service.Requests);
        Assert.Equal("POST", seen.Method);
        Assert.Equal(HttpTarget.Of(src).Target, seen.Target);
    }

    /// <summary>
    /// The replay found while writing the article on http (2026-11-19): one service, two addresses,
    /// one secret. A request signed for the first one, sent unchanged to the second, must not be
    /// answered.
    /// </summary>
    [Fact]
    public async Task IsRefusedAtAnotherAddressOfTheSameService()
    {
        using var service = new SignedService(Secret);
        Assert.Equal(
            new[] { "ok-qwerty" },
            HttpGen.Fetch(
                service.BaseUrl + "/hash", 1, new[] { "qwerty" }, "abc123",
                HttpGen.OnErrorMode.Fail, 5000, Secret));
        Received signedFor = Assert.Single(service.Requests);

        async Task<int> Replay(string url)
        {
            using var client = new HttpClient();
            var content = new ByteArrayContent(signedFor.Body);
            content.Headers.ContentType =
                new System.Net.Http.Headers.MediaTypeHeaderValue("text/plain");
            using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = content };
            foreach ((string name, string value) in signedFor.Headers)
            {
                if (name.StartsWith("X-TDC-", StringComparison.OrdinalIgnoreCase))
                {
                    request.Headers.TryAddWithoutValidation(name, value);
                }
            }

            using HttpResponseMessage response = await client.SendAsync(request);
            return (int)response.StatusCode;
        }

        Assert.Equal(200, await Replay(service.BaseUrl + "/hash"));
        Assert.Equal(401, await Replay(service.BaseUrl + "/invite"));
    }
}
