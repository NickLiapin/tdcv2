using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Tdcv2.Packs;

/// <summary>
/// Data packs, fetched on demand from the registry every implementation shares.
/// </summary>
/// <remarks>
/// <para>
/// The pack collection is a body of DATA with its own release rhythm, and it grows without bound —
/// every locale, every country, eventually every corpus. It lives in one repository, and each library
/// ships only a starter set: locale-agnostic packs, one language, one country. Everything past that
/// is downloaded.
/// </para>
/// <para>
/// One registry for all of them is the point. A locale added there appears in every implementation at
/// once, and there is exactly one place to publish to. This is the .NET client for it — the same
/// <c>index.json</c>, the same bundle zips, the same digests, and the same store layout, so a project
/// can be set up by whichever implementation happens to be at hand and used by any of the others.
/// </para>
/// </remarks>
public sealed class PackRegistry
{
    /// <summary>Where the bundles live. The same default the command-line tool uses.</summary>
    public const string DefaultBaseUrl =
        "https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master";

    /// <summary>The folder inside a bundle that is a pack scan root.</summary>
    public const string BundlePacksDir = "packs";

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    /// <summary>Anything that stops a bundle being installed, said plainly.</summary>
    public sealed class PackException : Exception
    {
        public PackException(string message)
            : base(message)
        {
        }

        public PackException(string message, Exception cause)
            : base(message, cause)
        {
        }
    }

    /// <summary>
    /// One downloadable bundle, as the registry's index describes it.
    /// </summary>
    /// <remarks>
    /// <c>Regions</c> and <c>Point</c> say where a country is: the continents it belongs to, and
    /// roughly its middle as [longitude, latitude]. They come from the registry so an interactive
    /// picker can group and plot a country without keeping a copy of world geography — the picker
    /// exists in several languages, and several copies would be several copies that drift. Empty and
    /// null for languages and for <c>common</c>, and for an index published before they existed,
    /// which is why neither is required.
    /// </remarks>
    public sealed record Bundle(
        string Id, string Name, string Description, string File, long Bytes, string Sha256,
        string? Locale, string? Country, IReadOnlyList<string> Contents,
        IReadOnlyList<string> Regions, double[]? Point);

    /// <summary>The catalogue.</summary>
    public sealed record Index(int SchemaVersion, string? Description, IReadOnlyList<Bundle> Bundles)
    {
        /// <summary>A bundle by id, or a message naming what there is.</summary>
        public Bundle Find(string id)
        {
            Bundle? found = Bundles.FirstOrDefault(b => b.Id == id);
            if (found is not null)
            {
                return found;
            }

            string known = Bundles.Count == 0 ? "(none)" : string.Join(", ", Bundles.Select(b => b.Id));
            throw new PackException($"unknown bundle \"{id}\". Available: {known}");
        }
    }

    private readonly string _baseUrl;
    private static readonly HttpClient Client = new() { Timeout = Timeout };

    public PackRegistry()
        : this(DefaultBaseUrl)
    {
    }

    public PackRegistry(string baseUrl) =>
        _baseUrl = baseUrl.EndsWith('/') ? baseUrl[..^1] : baseUrl;

    /// <summary>The catalogue of what can be installed.</summary>
    public Index ReadIndex() =>
        ParseIndex(Encoding.UTF8.GetString(Fetch(_baseUrl + "/index.json")));

    /// <summary>
    /// Download a bundle and unpack it into the store.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The bytes are checked against the digest the registry published before anything is written.
    /// Data that arrives corrupted, or altered on the way, is refused rather than unpacked — a
    /// generator quietly fed the wrong names produces a dataset nobody can tell is wrong.
    /// </para>
    /// <para>
    /// A bundle's zip nests everything under its own top folder — <c>en/packs/…</c> — so it is
    /// unpacked into the STORE, not into <c>&lt;store&gt;/&lt;id&gt;</c>: the archive already carries
    /// the id. Unpacking a level deeper would give <c>&lt;store&gt;/en/en/packs</c> and nothing would
    /// resolve. That layout is the registry's, shared by every implementation, so getting it wrong
    /// here breaks packs published for the others rather than only ours.
    /// </para>
    /// </remarks>
    /// <returns>The pack root to register, <c>&lt;store&gt;/&lt;id&gt;/packs</c>.</returns>
    public string Install(Bundle bundle, string store)
    {
        byte[] archive = Fetch(_baseUrl + "/" + bundle.File);
        if (bundle.Bytes > 0 && archive.Length != bundle.Bytes)
        {
            throw new PackException(
                $"bundle \"{bundle.Id}\": expected {bundle.Bytes} bytes, got {archive.Length}");
        }

        if (!string.Equals(Sha256(archive), bundle.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            throw new PackException(
                $"bundle \"{bundle.Id}\" failed its checksum — download corrupt or tampered; "
                + "not installed");
        }

        Directory.CreateDirectory(store);
        Unzip(archive, store);

        string root = Path.Combine(store, bundle.Id, BundlePacksDir);
        return Directory.Exists(root)
            ? root
            : throw new PackException(
                $"bundle \"{bundle.Id}\" has no \"packs\" folder at its root — cannot register it");
    }

    /// <summary>Bundle ids already in the store — a folder that carries a <c>packs/</c> directory.</summary>
    public static IReadOnlyList<string> Installed(string store)
    {
        if (!Directory.Exists(store))
        {
            return Array.Empty<string>();
        }

        return Directory.GetDirectories(store)
            .Where(p => Directory.Exists(Path.Combine(p, BundlePacksDir)))
            .Select(Path.GetFileName)
            .Where(name => name is not null)
            .Select(name => name!)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
    }

    // ── the wire ─────────────────────────────────────────────────────────────────────────────

    private static byte[] Fetch(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
        {
            throw new PackException("not a usable registry address: " + url);
        }

        // A registry on the filesystem — a mounted share, an offline mirror, a test's temporary
        // folder. HttpClient refuses any scheme but http and https, so the case is answered here.
        if (uri.Scheme == Uri.UriSchemeFile)
        {
            try
            {
                return System.IO.File.ReadAllBytes(uri.LocalPath);
            }
            catch (FileNotFoundException e)
            {
                throw new PackException("not found: " + url, e);
            }
            catch (DirectoryNotFoundException e)
            {
                throw new PackException("not found: " + url, e);
            }
            catch (IOException e)
            {
                throw new PackException($"cannot read {url} ({e.Message})", e);
            }
        }

        if (uri.Scheme is not ("http" or "https"))
        {
            throw new PackException(
                $"registry \"{url}\" must be an http, https or file address");
        }

        HttpResponseMessage response;
        try
        {
            response = Client.Send(new HttpRequestMessage(HttpMethod.Get, uri));
        }
        catch (Exception e) when (e is HttpRequestException or IOException or TaskCanceledException)
        {
            throw new PackException($"cannot reach {url} ({e.Message})", e);
        }

        using (response)
        {
            int status = (int)response.StatusCode;
            if (status == 404)
            {
                throw new PackException("not found: " + url);
            }

            if (status is < 200 or >= 300)
            {
                throw new PackException($"{url} returned {status}");
            }

            using var buffer = new MemoryStream();
            response.Content.ReadAsStream().CopyTo(buffer);
            return buffer.ToArray();
        }
    }

    private static string Sha256(byte[] data) =>
        System.Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    /// <summary>
    /// Unpack, refusing any entry that would land outside the target.
    /// </summary>
    /// <remarks>
    /// A zip can name <c>../../etc/something</c>, and an extractor that trusts the name writes
    /// wherever it is told. The archive is data from the network; it does not get to choose paths.
    /// </remarks>
    private static void Unzip(byte[] archive, string target)
    {
        string root = Path.GetFullPath(target);
        string prefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;

        using var zip = new ZipArchive(new MemoryStream(archive), ZipArchiveMode.Read);
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string destination = Path.GetFullPath(Path.Combine(root, entry.FullName));
            if (destination != root && !destination.StartsWith(prefix, StringComparison.Ordinal))
            {
                throw new PackException(
                    $"bundle entry \"{entry.FullName}\" would escape the pack store");
            }

            // A directory entry has an empty name after its trailing slash.
            if (entry.Name.Length == 0)
            {
                Directory.CreateDirectory(destination);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: true);
        }
    }

    // ── the index ────────────────────────────────────────────────────────────────────────────

    /// <summary>Parse and check a registry index. Malformed input is a clear error, never a guess.</summary>
    public static Index ParseIndex(string text)
    {
        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(text);
        }
        catch (JsonException e)
        {
            throw new PackException("registry index is not valid JSON: " + e.Message, e);
        }

        using (parsed)
        {
            JsonElement root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new PackException("registry index must be a JSON object");
            }

            if (!root.TryGetProperty("schemaVersion", out JsonElement version)
                || version.ValueKind != JsonValueKind.Number)
            {
                throw new PackException("registry index: \"schemaVersion\" must be a number");
            }

            int schemaVersion = (int)Math.Round(version.GetDouble());
            if (schemaVersion != 1)
            {
                throw new PackException(
                    $"registry index: unsupported schemaVersion {schemaVersion} — update tdcv2");
            }

            if (!root.TryGetProperty("bundles", out JsonElement raw)
                || raw.ValueKind != JsonValueKind.Array)
            {
                throw new PackException("registry index: \"bundles\" must be an array");
            }

            var bundles = new List<Bundle>();
            int i = 0;
            foreach (JsonElement item in raw.EnumerateArray())
            {
                bundles.Add(ParseBundle(item, i++));
            }

            return new Index(schemaVersion, Optional(root, "description", "description"), bundles);
        }
    }

    private static Bundle ParseBundle(JsonElement raw, int i)
    {
        if (raw.ValueKind != JsonValueKind.Object)
        {
            throw new PackException($"registry index: bundles[{i}] must be an object");
        }

        if (!raw.TryGetProperty("bytes", out JsonElement bytes)
            || bytes.ValueKind != JsonValueKind.Number
            || bytes.GetDouble() < 0)
        {
            throw new PackException(
                $"registry index: bundles[{i}].bytes must be a non-negative number");
        }

        var contents = new List<string>();
        if (raw.TryGetProperty("contents", out JsonElement items))
        {
            if (items.ValueKind != JsonValueKind.Array)
            {
                throw new PackException($"registry index: bundles[{i}].contents must be an array");
            }

            int j = 0;
            foreach (JsonElement item in items.EnumerateArray())
            {
                contents.Add(Required(item, $"bundles[{i}].contents[{j++}]"));
            }
        }

        return new Bundle(
            Required(Get(raw, "id"), $"bundles[{i}].id"),
            Required(Get(raw, "name"), $"bundles[{i}].name"),
            raw.TryGetProperty("description", out JsonElement d) ? d.GetString() ?? "" : "",
            Required(Get(raw, "file"), $"bundles[{i}].file"),
            (long)bytes.GetDouble(),
            Required(Get(raw, "sha256"), $"bundles[{i}].sha256").ToLowerInvariant(),
            Optional(raw, "locale", $"bundles[{i}].locale"),
            Optional(raw, "country", $"bundles[{i}].country"),
            contents,
            Regions(raw, i),
            Point(raw, i));
    }

    private static IReadOnlyList<string> Regions(JsonElement raw, int i)
    {
        if (!raw.TryGetProperty("regions", out JsonElement value))
        {
            return Array.Empty<string>();
        }

        if (value.ValueKind != JsonValueKind.Array)
        {
            throw new PackException($"registry index: bundles[{i}].regions must be an array");
        }

        var result = new List<string>();
        int j = 0;
        foreach (JsonElement item in value.EnumerateArray())
        {
            result.Add(Required(item, $"bundles[{i}].regions[{j++}]"));
        }

        return result;
    }

    private static double[]? Point(JsonElement raw, int i)
    {
        if (!raw.TryGetProperty("point", out JsonElement value))
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != 2)
        {
            throw new PackException(
                $"registry index: bundles[{i}].point must be [longitude, latitude]");
        }

        double[] pair = value.EnumerateArray()
            .Select(e => e.ValueKind == JsonValueKind.Number
                ? e.GetDouble()
                : throw new PackException(
                    $"registry index: bundles[{i}].point must be [longitude, latitude]"))
            .ToArray();
        return pair;
    }

    private static JsonElement? Get(JsonElement raw, string name) =>
        raw.TryGetProperty(name, out JsonElement value) ? value : null;

    private static string Required(JsonElement? value, string what) =>
        value is { ValueKind: JsonValueKind.String } v && !string.IsNullOrWhiteSpace(v.GetString())
            ? v.GetString()!
            : throw new PackException($"registry index: {what} must be a non-empty string");

    private static string? Optional(JsonElement raw, string name, string what) =>
        raw.TryGetProperty(name, out JsonElement value) && value.ValueKind != JsonValueKind.Null
            ? Required(value, what)
            : null;
}
