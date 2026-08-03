using System.Text.Encodings.Web;
using System.Text.Json;

namespace Tdcv2.Packs;

/// <summary>
/// The pack store's own books: which paths each bundle owns, and where they all are.
/// </summary>
/// <remarks>
/// <para>
/// Bundles are axis-pure — one language (<c>en</c>), or one country (<c>usa</c>), or
/// <c>common</c> — because language and country are independent dimensions that compose (US
/// English = common + en + usa). They all unpack into ONE tree:
/// </para>
/// <code>
/// &lt;store&gt;/.tdcv2-installed.json
/// &lt;store&gt;/common/…
/// &lt;store&gt;/en/…
/// &lt;store&gt;/countries/usa/…
/// </code>
/// <para>
/// The address path is the only level that has to exist, so it is the only level there is. The
/// store is a single scan root, registered in <c>dataPaths</c> once, and a bundle is no longer
/// identifiable by a folder named after it — which is what the bookkeeping file is for: it records
/// the paths each bundle owns, so <c>pack remove</c> deletes exactly those and <c>pack list</c>
/// knows what is installed.
/// </para>
/// <para>
/// Nothing here touches the network, which is what lets the whole of it be tested from a temporary
/// folder. The wire and the unzip live in <see cref="PackRegistry"/>.
/// </para>
/// </remarks>
public static class PackStore
{
    /// <summary>
    /// The store's bookkeeping file.
    /// </summary>
    /// <remarks>
    /// A DOTFILE because it sits at the root of a scan root, and the pack loader skips ignored
    /// NAMES rather than unknown extensions — a plain <c>installed.json</c> here would be read as
    /// a pack at address <c>installed</c>.
    /// </remarks>
    public const string InstalledFile = ".tdcv2-installed.json";

    /// <summary>Bumped only if the record's shape changes in a way older tools misread.</summary>
    public const int InstalledSchemaVersion = 1;

    /// <summary>One bundle as the store has it.</summary>
    /// <param name="Paths">
    /// The paths this bundle owns, relative to the store and always <c>/</c>-separated.
    /// <c>pack remove</c> deletes exactly these; a bundle in a shared tree cannot be found by
    /// looking for a folder with its name.
    /// </param>
    /// <param name="Version">What the registry called this revision, or <c>""</c> for nothing.</param>
    /// <param name="Sha256">
    /// Digest of the archive it came from; <c>""</c> for an install migrated from the old layout.
    /// </param>
    /// <param name="Files">How many files it wrote.</param>
    public sealed record InstalledBundle(
        string Id, IReadOnlyList<string> Paths, string Version, string Sha256, int Files);

    /// <summary>The bookkeeping file's contents, ids sorted so the file is stable to diff.</summary>
    public sealed record InstalledRecord(int SchemaVersion, IReadOnlyList<InstalledBundle> Bundles);

    /// <summary>Where the bookkeeping file lives.</summary>
    public static string InstalledFilePath(string store) => Path.Combine(store, InstalledFile);

    /// <summary>
    /// Read the store's books.
    /// </summary>
    /// <remarks>
    /// A missing file means an empty store; a malformed one is an ERROR rather than an empty
    /// store, because "nothing is installed" would make <c>pack remove</c> claim there is nothing
    /// to delete while the files sit there.
    /// </remarks>
    public static InstalledRecord Read(string store)
    {
        string path = InstalledFilePath(store);
        if (!File.Exists(path))
        {
            return new InstalledRecord(
                InstalledSchemaVersion, Array.Empty<InstalledBundle>());
        }

        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(File.ReadAllText(path));
        }
        catch (JsonException e)
        {
            throw new PackRegistry.PackException(
                $"pack store record \"{path}\" is not valid JSON: {e.Message}. "
                + "Delete it and re-add your bundles.",
                e);
        }

        using (parsed)
        {
            JsonElement root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new PackRegistry.PackException(
                    $"pack store record \"{path}\" must be a JSON object");
            }

            if (!root.TryGetProperty("schemaVersion", out JsonElement version)
                || version.ValueKind != JsonValueKind.Number)
            {
                throw new PackRegistry.PackException(
                    $"pack store record \"{path}\": \"schemaVersion\" must be a number");
            }

            int schemaVersion = (int)Math.Round(version.GetDouble());
            if (schemaVersion > InstalledSchemaVersion)
            {
                throw new PackRegistry.PackException(
                    $"pack store record \"{path}\" was written by a newer tdcv2 "
                    + $"(schemaVersion {schemaVersion}) — update tdcv2");
            }

            if (!root.TryGetProperty("bundles", out JsonElement raw)
                || raw.ValueKind != JsonValueKind.Array)
            {
                throw new PackRegistry.PackException(
                    $"pack store record \"{path}\": \"bundles\" must be an array");
            }

            var bundles = new List<InstalledBundle>();
            int i = 0;
            foreach (JsonElement item in raw.EnumerateArray())
            {
                bundles.Add(ParseInstalledBundle(item, i++, path, store));
            }

            return new InstalledRecord(schemaVersion, Sorted(bundles));
        }
    }

    private static InstalledBundle ParseInstalledBundle(
        JsonElement raw, int i, string path, string store)
    {
        if (raw.ValueKind != JsonValueKind.Object)
        {
            throw new PackRegistry.PackException(
                $"pack store record \"{path}\": bundles[{i}] must be an object");
        }

        string id = Text(raw, "id")
            ?? throw new PackRegistry.PackException(
                $"pack store record \"{path}\": bundles[{i}].id must be a non-empty string");

        if (!raw.TryGetProperty("paths", out JsonElement rawPaths)
            || rawPaths.ValueKind != JsonValueKind.Array)
        {
            throw new PackRegistry.PackException(
                $"pack store record \"{path}\": bundles[{i}].paths must be an array");
        }

        var paths = new List<string>();
        int j = 0;
        foreach (JsonElement item in rawPaths.EnumerateArray())
        {
            string value = item.ValueKind == JsonValueKind.String
                           && !string.IsNullOrWhiteSpace(item.GetString())
                ? item.GetString()!
                : throw new PackRegistry.PackException(
                    $"pack store record \"{path}\": bundles[{i}].paths[{j}] "
                    + "must be a non-empty string");
            j++;

            // Everything in here is deleted verbatim by `pack remove`, so a hand-edited or
            // hostile record must not be able to point outside the store.
            if (Path.IsPathRooted(value) || !IsInside(Resolve(store, value), store))
            {
                throw new PackRegistry.PackException(
                    $"pack store record \"{path}\": bundle \"{id}\" "
                    + $"claims a path outside the store: \"{value}\"");
            }

            paths.Add(value);
        }

        return new InstalledBundle(
            id,
            paths,
            Text(raw, "version") ?? "",
            Text(raw, "sha256") ?? "",
            raw.TryGetProperty("files", out JsonElement files)
            && files.ValueKind == JsonValueKind.Number
                ? (int)Math.Round(files.GetDouble())
                : 0);
    }

    private static string? Text(JsonElement raw, string name) =>
        raw.TryGetProperty(name, out JsonElement value)
        && value.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()
            : null;

    /// <summary>
    /// Sorted by id, on the raw code units.
    /// </summary>
    /// <remarks>
    /// Ordinal, never the current culture: five implementations write this file and a Turkish
    /// locale that orders two ids differently would give the same store different bytes on two
    /// machines.
    /// </remarks>
    private static List<InstalledBundle> Sorted(IEnumerable<InstalledBundle> bundles) =>
        bundles.OrderBy(b => b.Id, StringComparer.Ordinal).ToList();

    /// <summary>Write the store's books, ids sorted so re-installing the same set is a no-diff.</summary>
    public static void Write(string store, InstalledRecord record)
    {
        Directory.CreateDirectory(store);

        var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(
                   buffer,
                   new JsonWriterOptions
                   {
                       Indented = true,
                       // A pack path may be anything a filesystem accepts; the default encoder
                       // would turn a non-ASCII folder name into \uXXXX and no longer match what
                       // the other four implementations write.
                       Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                   }))
        {
            json.WriteStartObject();
            json.WriteNumber("schemaVersion", InstalledSchemaVersion);
            json.WriteStartArray("bundles");
            foreach (InstalledBundle bundle in Sorted(record.Bundles))
            {
                json.WriteStartObject();
                json.WriteString("id", bundle.Id);
                json.WriteStartArray("paths");
                foreach (string path in bundle.Paths)
                {
                    json.WriteStringValue(path);
                }

                json.WriteEndArray();
                json.WriteString("version", bundle.Version);
                json.WriteString("sha256", bundle.Sha256);
                json.WriteNumber("files", bundle.Files);
                json.WriteEndObject();
            }

            json.WriteEndArray();
            json.WriteEndObject();
        }

        File.WriteAllBytes(
            InstalledFilePath(store),
            buffer.ToArray().Concat(new[] { (byte)'\n' }).ToArray());
    }

    /// <summary>The record with <paramref name="entry"/> in place of any earlier install of that id.</summary>
    public static InstalledRecord With(InstalledRecord record, InstalledBundle entry) =>
        new(InstalledSchemaVersion,
            Sorted(record.Bundles.Where(b => b.Id != entry.Id).Append(entry)));

    /// <summary>The record without <paramref name="id"/>.</summary>
    public static InstalledRecord Without(InstalledRecord record, string id) =>
        new(InstalledSchemaVersion, record.Bundles.Where(b => b.Id != id).ToList());

    /// <summary>
    /// Bundle ids the store has, from its books.
    /// </summary>
    /// <remarks>
    /// A missing store means nothing installed, not an error. A tree somebody unpacked by hand is
    /// not "installed" either: nothing records what it owns, so nothing could remove it cleanly.
    /// </remarks>
    public static IReadOnlyList<string> InstalledIds(string store) =>
        Read(store).Bundles.Select(b => b.Id).OrderBy(id => id, StringComparer.Ordinal).ToList();

    /// <summary>
    /// The paths a bundle owns, given every file it carries (store-relative, <c>/</c>-separated).
    /// </summary>
    /// <remarks>
    /// Usually one path: every file of <c>ru</c> sits under <c>ru/</c>, every file of
    /// <c>russia</c> under <c>countries/russia/</c>, so the longest shared directory IS the
    /// subtree the bundle owns — and <c>countries/</c>, which several bundles share, is correctly
    /// not claimed by any of them. A bundle whose files diverge at the top level owns each of
    /// those top-level entries instead, which keeps the answer an antichain: no owned path
    /// contains another.
    /// </remarks>
    public static IReadOnlyList<string> OwnedPaths(IReadOnlyList<string> files)
    {
        if (files.Count == 0)
        {
            return Array.Empty<string>();
        }

        List<string[]> directories = files
            .Select(f => f.Split('/'))
            .Select(parts => parts[..^1])
            .ToList();

        string[] common = directories[0];
        foreach (string[] directory in directories.Skip(1))
        {
            int i = 0;
            while (i < common.Length && i < directory.Length && common[i] == directory[i])
            {
                i++;
            }

            common = common[..i];
            if (common.Length == 0)
            {
                break;
            }
        }

        return common.Length > 0
            ? new[] { string.Join("/", common) }
            : files.Select(f => f.Split('/')[0])
                .Where(first => first.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(first => first, StringComparer.Ordinal)
                .ToList();
    }

    /// <summary>True if <paramref name="child"/> is the same as, or nested under, the parent.</summary>
    /// <remarks>Guards zip-slip: the paths are normalised before they are compared.</remarks>
    public static bool IsInside(string child, string parent)
    {
        string root = Path.GetFullPath(parent);
        string target = Path.GetFullPath(child);
        if (target == root)
        {
            return true;
        }

        string prefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        return target.StartsWith(prefix, StringComparison.Ordinal);
    }

    /// <summary>A store-relative, <c>/</c>-separated path as this filesystem spells it.</summary>
    public static string Resolve(string store, string relative) =>
        Path.Combine(store, relative.Replace('/', Path.DirectorySeparatorChar));

    /// <summary>
    /// Every file under <paramref name="directory"/>, <c>/</c>-separated and relative to it, sorted.
    /// </summary>
    /// <remarks>
    /// Dotfiles included: <c>_locale.json</c> and anything else the packs carry has to travel with
    /// them, and deciding what is "really" data is the loader's job.
    /// </remarks>
    public static IReadOnlyList<string> WalkRelative(string directory)
    {
        if (!Directory.Exists(directory))
        {
            return Array.Empty<string>();
        }

        return Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(directory, p)
                .Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Delete the paths a bundle owns, and any parent left empty behind them.</summary>
    public static void DeleteOwnedPaths(string store, IReadOnlyList<string> paths)
    {
        foreach (string relative in paths)
        {
            string target = Resolve(store, relative);
            // The record is a file on disk and may have been edited; a path that does not resolve
            // inside the store is not deleted on its say-so.
            if (!IsInside(target, store) || Path.GetFullPath(target) == Path.GetFullPath(store))
            {
                throw new PackRegistry.PackException(
                    $"refusing to delete \"{relative}\": it is not inside the pack store");
            }

            if (Directory.Exists(target))
            {
                Directory.Delete(target, recursive: true);
            }
            else if (File.Exists(target))
            {
                File.Delete(target);
            }

            PruneEmptyDirs(Path.GetDirectoryName(target)!, store);
        }
    }

    /// <summary>Delete a directory and every empty parent up to (but never including) the store.</summary>
    public static void PruneEmptyDirs(string directory, string stopAt)
    {
        string current = Path.GetFullPath(directory);
        string root = Path.GetFullPath(stopAt);
        while (current != root && IsInside(current, root))
        {
            try
            {
                if (Directory.EnumerateFileSystemEntries(current).Any())
                {
                    return;
                }

                Directory.Delete(current);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return;
            }

            string? parent = Path.GetDirectoryName(current);
            if (parent is null)
            {
                return;
            }

            current = parent;
        }
    }

    // ── migrating a store written by an older tdcv2 ──────────────────────────────────────────

    /// <summary>One bundle's tree, moved out of its old folder.</summary>
    /// <param name="From">Store-relative source, e.g. <c>ru/packs</c>.</param>
    /// <param name="To">Store-relative destinations, e.g. <c>ru</c>.</param>
    public sealed record StoreMove(string Id, string From, IReadOnlyList<string> To, int Files);

    /// <summary>What <see cref="Migrate"/> did, for the caller to report.</summary>
    /// <param name="Leftovers">
    /// Files that were in a bundle's old folder but OUTSIDE its <c>packs/</c> tree. They belong to
    /// no pack address, so they are left exactly where they are rather than guessed at or deleted.
    /// </param>
    /// <param name="Registered">
    /// The store, as written into <c>dataPaths</c>; null if it was already there.
    /// </param>
    public sealed record StoreMigration(
        string Store, IReadOnlyList<StoreMove> Moves, IReadOnlyList<string> Leftovers,
        int DroppedDataPaths, string? Registered);

    /// <summary>Bundle folders in the old layout: <c>&lt;store&gt;/&lt;id&gt;/packs/…</c>.</summary>
    public static IReadOnlyList<string> LegacyBundleIds(string store)
    {
        if (!Directory.Exists(store))
        {
            return Array.Empty<string>();
        }

        return Directory.GetDirectories(store)
            .Where(p => Directory.Exists(Path.Combine(p, PackRegistry.BundlePacksDir)))
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrEmpty(name))
            .Select(name => name!)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>One file the migration is going to move, once it knows they all can.</summary>
    private readonly record struct PlannedMove(string Destination, string Id, string From);

    /// <summary>
    /// Move a store written by an older tdcv2 into the flat layout, in place.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns null when there is nothing to move. Everything is PLANNED before anything moves: a
    /// store half in one layout and half in the other is worse than one that refused and said why,
    /// and the refusal costs the user only the two minutes it takes to move the offending file
    /// themselves.
    /// </para>
    /// <para>
    /// Anyone who ran <c>pack add</c> before the flat store has <c>&lt;store&gt;/&lt;id&gt;/packs/…</c>
    /// on disk and one <c>dataPaths</c> entry per bundle in their config; both are fixed here, so
    /// the first <c>tdcv2 pack</c> after an upgrade is all it takes.
    /// </para>
    /// </remarks>
    public static StoreMigration? Migrate(string store, string configPath)
    {
        IReadOnlyList<string> ids = LegacyBundleIds(store);
        if (ids.Count == 0)
        {
            return null;
        }

        var planned = new List<PlannedMove>();
        var claimedBy = new Dictionary<string, string>(StringComparer.Ordinal);
        var perBundle = new List<(string Id, IReadOnlyList<string> Rels)>();
        var conflicts = new List<string>();
        var leftovers = new List<string>();

        foreach (string id in ids)
        {
            string packsRoot = PacksRootOf(store, id);
            IReadOnlyList<string> rels = WalkRelative(packsRoot);
            perBundle.Add((id, rels));

            // Read before anything moves: a bundle whose tree lands back under its own name
            // (`ru/packs/ru` → `ru`) would otherwise report its own data as a leftover the moment
            // it arrived.
            foreach (string rel in WalkRelative(Path.Combine(store, id)))
            {
                if (!rel.StartsWith(PackRegistry.BundlePacksDir + "/", StringComparison.Ordinal))
                {
                    leftovers.Add($"{id}/{rel}");
                }
            }

            foreach (string rel in rels)
            {
                string destination = Resolve(store, rel);
                if (!IsInside(destination, store))
                {
                    conflicts.Add($"{id}: \"{rel}\" would land outside the store");
                    continue;
                }

                string key = Path.GetFullPath(destination);
                if (claimedBy.TryGetValue(key, out string? claimant))
                {
                    conflicts.Add($"{rel}: claimed by both \"{claimant}\" and \"{id}\"");
                    continue;
                }

                if (File.Exists(destination) || Directory.Exists(destination))
                {
                    conflicts.Add($"{rel}: something is already there");
                    continue;
                }

                // Landing inside another bundle's old folder would move a file out from under a
                // move still to come.
                if (ids.Any(other =>
                        other != id && IsInside(destination, PacksRootOf(store, other))))
                {
                    conflicts.Add($"{rel}: it would land inside another bundle's old folder");
                    continue;
                }

                claimedBy[key] = id;
                planned.Add(new PlannedMove(destination, id, Resolve(packsRoot, rel)));
            }
        }

        if (conflicts.Count > 0)
        {
            throw new PackRegistry.PackException(Refusal(store, conflicts));
        }

        foreach (PlannedMove move in planned)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(move.Destination)!);
            MoveFile(move.From, move.Destination);
        }

        InstalledRecord record = Read(store);
        var moves = new List<StoreMove>();
        foreach ((string id, IReadOnlyList<string> rels) in perBundle)
        {
            IReadOnlyList<string> paths = OwnedPaths(rels);
            record = With(record, new InstalledBundle(id, paths, "", "", rels.Count));
            moves.Add(new StoreMove(
                id, $"{id}/{PackRegistry.BundlePacksDir}", paths, rels.Count));
            PruneEmptyTree(PacksRootOf(store, id));
            PruneEmptyTree(Path.Combine(store, id));
        }

        Write(store, record);

        int dropped = ProjectConfig.UnregisterInside(configPath, store);
        string stored = ProjectConfig.StoredPath(configPath, store);
        bool added = ProjectConfig.Register(configPath, new[] { store });
        return new StoreMigration(store, moves, leftovers, dropped, added ? stored : null);
    }

    private static string PacksRootOf(string store, string id) =>
        Path.Combine(store, id, PackRegistry.BundlePacksDir);

    /// <summary>The refusal, naming the first five collisions and counting the rest.</summary>
    private static string Refusal(string store, IReadOnlyList<string> conflicts)
    {
        var shown = conflicts.Take(5).Select(c => "  " + c).ToList();
        if (conflicts.Count > 5)
        {
            shown.Add($"  … and {conflicts.Count - 5} more");
        }

        return $"cannot move the pack store \"{store}\" to the flat layout — "
               + $"{conflicts.Count} path(s) collide:\n"
               + string.Join("\n", shown) + "\n"
               + "Nothing was moved. Clear those paths, or delete the store and run "
               + "`tdcv2 pack add` again.";
    }

    /// <summary>Move one file, falling back to copy+delete if the store spans two devices.</summary>
    private static void MoveFile(string from, string to)
    {
        try
        {
            File.Move(from, to);
        }
        catch (IOException)
        {
            File.Copy(from, to, overwrite: true);
            File.Delete(from);
        }
    }

    /// <summary>
    /// Delete every empty directory in a subtree, and the directory itself if that leaves it empty.
    /// </summary>
    /// <remarks>
    /// Moving files out leaves the whole shape of the old tree behind, and empty folders in a scan
    /// root are noise a user then has to wonder about.
    /// </remarks>
    private static bool PruneEmptyTree(string directory)
    {
        if (!Directory.Exists(directory))
        {
            return false;
        }

        bool empty = true;
        foreach (string entry in Directory.GetFileSystemEntries(directory))
        {
            if (!Directory.Exists(entry) || !PruneEmptyTree(entry))
            {
                empty = false;
            }
        }

        if (!empty)
        {
            return false;
        }

        try
        {
            Directory.Delete(directory);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
