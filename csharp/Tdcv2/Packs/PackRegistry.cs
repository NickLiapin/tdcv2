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
    /// <para>
    /// <c>Version</c> is what the registry calls this revision of the bundle. Optional: today's
    /// index declares none, and the digest already tells two revisions apart — but the store writes
    /// down whatever the registry did say, so a registry that starts versioning its bundles is
    /// understood without a client change.
    /// </para>
    /// <para>
    /// <c>Regions</c> and <c>Point</c> say where a country is: the continents it belongs to, and
    /// roughly its middle as [longitude, latitude]. They come from the registry so an interactive
    /// picker can group and plot a country without keeping a copy of world geography — the picker
    /// exists in several languages, and several copies would be several copies that drift. Empty and
    /// null for languages and for <c>common</c>, and for an index published before they existed,
    /// which is why neither is required.
    /// </para>
    /// </remarks>
    public sealed record Bundle(
        string Id, string Name, string Description, string File, long Bytes, string Sha256,
        string? Version, string? Locale, string? Country, IReadOnlyList<string> Contents,
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

    /// <summary>What one install put in the store: how many files, and under which paths.</summary>
    public sealed record Installation(int Files, IReadOnlyList<string> Paths);

    /// <summary>
    /// Download a bundle, verify it, unpack it into the store and write down what it owns.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The bytes are checked against the digest the registry published before anything is written.
    /// Data that arrives corrupted, or altered on the way, is refused rather than unpacked — a
    /// generator quietly fed the wrong names produces a dataset nobody can tell is wrong.
    /// </para>
    /// <para>
    /// A bundle's zip nests everything under <c>&lt;id&gt;/packs/</c>, which is the bundler's
    /// business and not the user's: both levels are stripped here so the address path lands
    /// directly in the store and <c>ru/person/lastName.txt</c> is what appears under it. That
    /// layout is the registry's, shared by every implementation, so getting it wrong here breaks
    /// packs published for the others rather than only ours.
    /// </para>
    /// </remarks>
    public Installation Install(Bundle bundle, string store)
    {
        Directory.CreateDirectory(store);

        byte[] archive = Fetch(_baseUrl + "/" + bundle.File);

        // Length first: a download cut short in transit is the common case, and saying how short
        // says far more than "the hash did not match". The digest then covers everything else —
        // including an archive swapped for one of exactly the same size.
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

        using var zip = new ZipArchive(new MemoryStream(archive), ZipArchiveMode.Read);
        List<KeyValuePair<string, ZipArchiveEntry>> planned = Plan(zip, bundle.Id, store);
        IReadOnlyList<string> paths =
            PackStore.OwnedPaths(planned.Select(e => e.Key).ToList());

        PackStore.InstalledRecord record = PackStore.Read(store);
        AssertNoOverlap(bundle.Id, paths, record);

        // Re-installing replaces rather than layers: without this, a bundle that dropped a file
        // would leave the old one behind for good, still answering to its address.
        PackStore.InstalledBundle? previous =
            record.Bundles.FirstOrDefault(b => b.Id == bundle.Id);
        if (previous is not null)
        {
            PackStore.DeleteOwnedPaths(store, previous.Paths);
        }

        foreach (KeyValuePair<string, ZipArchiveEntry> file in planned)
        {
            string destination = PackStore.Resolve(store, file.Key);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            file.Value.ExtractToFile(destination, overwrite: true);
        }

        PackStore.Write(
            store,
            PackStore.With(
                record,
                new PackStore.InstalledBundle(
                    bundle.Id, paths, bundle.Version ?? "", bundle.Sha256, planned.Count)));
        return new Installation(planned.Count, paths);
    }

    /// <summary>Bundle ids already in the store, from the store's own books.</summary>
    public static IReadOnlyList<string> Installed(string store) => PackStore.InstalledIds(store);

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
    /// Decide, before a single byte is written, what the archive would put where.
    /// </summary>
    /// <remarks>
    /// Every entry must carry the <c>&lt;id&gt;/packs/</c> prefix — an archive that is not the
    /// bundle it claims to be, or that carries something beside its packs, is refused whole rather
    /// than scattered into a shared tree that nothing could then take apart again. A zip can also
    /// name <c>../../etc/something</c>, and an extractor that trusts the name writes wherever it is
    /// told; the escape is caught here rather than at the write, so an archive with one escaping
    /// path does not first lay down the files that came before it.
    /// </remarks>
    private static List<KeyValuePair<string, ZipArchiveEntry>> Plan(
        ZipArchive zip, string id, string store)
    {
        string prefix = id + "/" + BundlePacksDir + "/";
        var planned = new List<KeyValuePair<string, ZipArchiveEntry>>();
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string name = entry.FullName;
            if (name.EndsWith('/'))
            {
                continue;
            }

            if (!name.StartsWith(prefix, StringComparison.Ordinal))
            {
                throw new PackException(
                    $"bundle \"{id}\" carries \"{name}\", which is not under \"{prefix}\" — "
                    + "refusing to unpack it");
            }

            string relative = name[prefix.Length..];
            if (relative.Length == 0)
            {
                continue;
            }

            if (!PackStore.IsInside(PackStore.Resolve(store, relative), store))
            {
                throw new PackException($"bundle \"{id}\" contains an unsafe path: {relative}");
            }

            planned.Add(new KeyValuePair<string, ZipArchiveEntry>(relative, entry));
        }

        if (planned.Count == 0)
        {
            throw new PackException($"bundle \"{id}\" has no files under \"{prefix}\"");
        }

        planned.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
        return planned;
    }

    /// <summary>
    /// Refuse a bundle that would write into a path another one owns.
    /// </summary>
    /// <remarks>
    /// The registry's bundles are axis-pure and no two of them name the same path, so this never
    /// fires on the real catalogue — it fires on a hand-built or renamed archive, where the
    /// alternative is two bundles interleaved in one tree and a <c>pack remove</c> that takes half
    /// of the other with it.
    /// </remarks>
    private static void AssertNoOverlap(
        string id, IReadOnlyList<string> paths, PackStore.InstalledRecord record)
    {
        foreach (PackStore.InstalledBundle other in record.Bundles)
        {
            if (other.Id == id)
            {
                continue;
            }

            foreach (string mine in paths)
            {
                foreach (string theirs in other.Paths)
                {
                    if (mine == theirs
                        || mine.StartsWith(theirs + "/", StringComparison.Ordinal)
                        || theirs.StartsWith(mine + "/", StringComparison.Ordinal))
                    {
                        throw new PackException(
                            $"bundle \"{id}\" would write into \"{mine}\", which \"{other.Id}\" "
                            + $"already owns — remove \"{other.Id}\" first");
                    }
                }
            }
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
            Optional(raw, "version", $"bundles[{i}].version"),
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
