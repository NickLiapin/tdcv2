using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Tdcv2.Packs;

/// <summary>
/// <c>tdcv2.config.json</c> — where a project's data packs live, written down instead of guessed.
/// </summary>
/// <remarks>
/// <para>
/// A pack downloaded by the CLI lands in a folder the config names. If this implementation did not
/// read that file, a config using a downloaded pack would work in one language and fail in another,
/// which is a portability bug of the worst kind: nothing is wrong with the config, only with which
/// runtime is asked to run it.
/// </para>
/// <para>
/// Resolution is a cascade, later levels overriding earlier ones for the same address: bundled, then
/// the global config, then the project's, then whatever the caller passed in. Paths accumulate —
/// every root is searched — while a scalar like <c>locale</c> takes the value from the highest level
/// that set one. A relative path is relative to the config file that contains it, the way a
/// compiler's configuration behaves.
/// </para>
/// </remarks>
public static class ProjectConfig
{
    public const string ProjectConfigName = "tdcv2.config.json";

    /// <summary>What the cascade resolved to, plus the files that contributed, low to high.</summary>
    public sealed record Resolved(
        IReadOnlyList<string> DataPaths, string? Locale, string? PackStore,
        IReadOnlyList<string> Sources);

    /// <summary>A config file that exists but cannot be used. Never silently ignored.</summary>
    public sealed class ConfigException : Exception
    {
        public ConfigException(string message)
            : base(message)
        {
        }
    }

    /// <summary>The cascade, starting from a directory — usually the one the run was launched in.</summary>
    public static Resolved Load(string? cwd)
    {
        var dataPaths = new List<string>();
        var sources = new List<string>();
        string? locale = null;
        string? packStore = null;

        string? globalPath = GlobalConfigPath();
        if (globalPath is not null && File.Exists(globalPath))
        {
            FileConfig g = Read(globalPath);
            dataPaths.AddRange(g.DataPaths);
            locale = g.Locale ?? locale;
            packStore = g.PackStore ?? packStore;
            sources.Add(globalPath);
        }

        string? projectPath = FindProjectConfig(cwd);
        if (projectPath is not null)
        {
            FileConfig p = Read(projectPath);
            dataPaths.AddRange(p.DataPaths);
            // The project overrides the global one.
            locale = p.Locale ?? locale;
            packStore = p.PackStore ?? packStore;
            sources.Add(projectPath);
        }

        return new Resolved(dataPaths, locale, packStore, sources);
    }

    /// <summary>
    /// The global config's location, following each platform's own convention.
    /// </summary>
    /// <remarks>
    /// The same places the CLI writes to, because a config only one of them can find is worse than
    /// no config at all.
    /// </remarks>
    public static string? GlobalConfigPath()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(home))
        {
            return null;
        }

        if (OperatingSystem.IsWindows())
        {
            string? appData = Environment.GetEnvironmentVariable("APPDATA");
            string windowsBase = string.IsNullOrWhiteSpace(appData)
                ? Path.Combine(home, "AppData", "Roaming")
                : appData;
            return Path.Combine(windowsBase, "tdcv2", "config.json");
        }

        string? xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        string basePath = string.IsNullOrWhiteSpace(xdg) ? Path.Combine(home, ".config") : xdg;
        return Path.Combine(basePath, "tdcv2", "config.json");
    }

    /// <summary>The nearest <c>tdcv2.config.json</c> at or above this directory, or <c>null</c>.</summary>
    public static string? FindProjectConfig(string? cwd)
    {
        var dir = new DirectoryInfo(Path.GetFullPath(cwd ?? Directory.GetCurrentDirectory()));
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, ProjectConfigName);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>One config file's contribution: absolute paths, and whatever scalars it set.</summary>
    private readonly record struct FileConfig(
        IReadOnlyList<string> DataPaths, string? Locale, string? PackStore);

    private static FileConfig Read(string path)
    {
        JsonElement root = Document(path);
        string basePath = Path.GetDirectoryName(Path.GetFullPath(path))!;

        var dataPaths = new List<string>();
        if (root.TryGetProperty("dataPaths", out JsonElement paths))
        {
            if (paths.ValueKind != JsonValueKind.Array)
            {
                throw new ConfigException(
                    $"config \"{path}\": \"dataPaths\" must be an array of strings");
            }

            foreach (JsonElement entry in paths.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.String
                    || string.IsNullOrWhiteSpace(entry.GetString()))
                {
                    throw new ConfigException(
                        $"config \"{path}\": \"dataPaths\" entries must be non-empty strings");
                }

                dataPaths.Add(Against(basePath, entry.GetString()!));
            }
        }

        string? locale = Text(root, "locale", path);
        string? store = Text(root, "packStore", path);
        return new FileConfig(
            dataPaths, locale, store is null ? null : Against(basePath, store));
    }

    /// <summary>A scalar string setting: absent, or present and non-empty. Nothing in between.</summary>
    private static string? Text(JsonElement root, string field, string path)
    {
        if (!root.TryGetProperty(field, out JsonElement value))
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new ConfigException(
                $"config \"{path}\": \"{field}\" must be a non-empty string");
        }

        return value.GetString()!.Trim();
    }

    /// <summary>
    /// Add pack roots to a config's <c>dataPaths</c>, creating the file if there is none.
    /// </summary>
    /// <remarks>
    /// Written relative when the path sits under the config's own folder, the way the command-line
    /// tool writes them, so a checked-in config keeps working on another machine. Existing settings
    /// are preserved and duplicates are dropped.
    /// </remarks>
    public static bool Register(string configPath, IReadOnlyList<string> packRoots)
    {
        string configDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
        List<KeyValuePair<string, object?>> document = ReadDocument(configPath);
        List<string> entries = Entries(document);

        bool added = false;
        foreach (string root in packRoots)
        {
            // De-duped by RESOLVED path, so an entry written "./x" and the same folder named
            // absolutely do not both land in the file.
            string target = Path.GetFullPath(root);
            if (!entries.Any(entry => Against(configDir, entry) == target))
            {
                entries.Add(Storable(configDir, target));
                added = true;
            }
        }

        Put(document, "dataPaths", entries.Cast<object?>().ToList());
        Write(configPath, configDir, document);
        return added;
    }

    /// <summary>How <paramref name="target"/> would be written down in this config.</summary>
    public static string StoredPath(string configPath, string target) =>
        Storable(Path.GetDirectoryName(Path.GetFullPath(configPath))!, target);

    /// <summary>
    /// The inverse of <see cref="Register"/>: pack roots dropped from a config's <c>dataPaths</c>.
    /// </summary>
    /// <remarks>
    /// Matched by resolved path, so an entry written relative and one written absolute both go.
    /// Returns whether the file changed. Removing a root does not remove data — a bundled pack
    /// covering the same addresses simply resurfaces, being a lower-priority root.
    /// </remarks>
    public static bool Unregister(string configPath, IReadOnlyList<string> packRoots)
    {
        if (!File.Exists(configPath))
        {
            return false;
        }

        string configDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
        List<KeyValuePair<string, object?>> document = ReadDocument(configPath);
        List<string> entries = Entries(document);

        var targets = packRoots.Select(Path.GetFullPath).ToHashSet(StringComparer.Ordinal);
        List<string> kept = entries.Where(e => !targets.Contains(Against(configDir, e))).ToList();
        if (kept.Count == entries.Count)
        {
            return false;
        }

        Put(document, "dataPaths", kept.Cast<object?>().ToList());
        Write(configPath, configDir, document);
        return true;
    }

    /// <summary>
    /// Drop every <c>dataPaths</c> entry that points INSIDE a store; the store itself is kept.
    /// </summary>
    /// <remarks>
    /// That is the per-bundle registration the old layout needed — a hundred of them for a hundred
    /// bundles — and after the move to the flat layout each one names a folder that no longer
    /// exists. Matched by resolved path, so a relative and an absolute spelling of the same folder
    /// both go. Returns how many went.
    /// </remarks>
    public static int UnregisterInside(string configPath, string store)
    {
        if (!File.Exists(configPath))
        {
            return 0;
        }

        string configDir = Path.GetDirectoryName(Path.GetFullPath(configPath))!;
        List<KeyValuePair<string, object?>> document = ReadDocument(configPath);
        List<string> entries = Entries(document);

        string root = Path.GetFullPath(store);
        List<string> kept = entries
            .Where(e =>
            {
                string absolute = Against(configDir, e);
                return absolute == root || !PackStore.IsInside(absolute, root);
            })
            .ToList();
        if (kept.Count == entries.Count)
        {
            return 0;
        }

        Put(document, "dataPaths", kept.Cast<object?>().ToList());
        Write(configPath, configDir, document);
        return entries.Count - kept.Count;
    }

    private static JsonElement Document(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (IOException e)
        {
            throw new ConfigException($"cannot read config \"{path}\": {e.Message}");
        }

        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(text);
        }
        catch (JsonException e)
        {
            throw new ConfigException($"config \"{path}\" is not valid JSON: {e.Message}");
        }

        return parsed.RootElement.ValueKind == JsonValueKind.Object
            ? parsed.RootElement.Clone()
            : throw new ConfigException($"config \"{path}\" must be a JSON object");
    }

    /// <summary>
    /// The config as it is written, or an empty one.
    /// </summary>
    /// <remarks>
    /// Kept WHOLE, as an ordered list of pairs, and rewritten in place: every key the file already
    /// had survives in the order it was written, including keys this version knows nothing about.
    /// Rebuilding the document from the three settings we happen to parse would silently delete
    /// anything else a project put there.
    /// </remarks>
    private static List<KeyValuePair<string, object?>> ReadDocument(string path)
    {
        if (!File.Exists(path))
        {
            return new List<KeyValuePair<string, object?>>();
        }

        JsonElement root = Document(path);
        return root.EnumerateObject()
            .Select(p => new KeyValuePair<string, object?>(p.Name, Materialize(p.Value)))
            .ToList();
    }

    /// <summary>A JsonElement turned into plain objects, so the document can be edited and rewritten.</summary>
    private static object? Materialize(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => value.EnumerateObject()
            .Select(p => new KeyValuePair<string, object?>(p.Name, Materialize(p.Value)))
            .ToList(),
        JsonValueKind.Array => value.EnumerateArray().Select(Materialize).ToList(),
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };

    /// <summary>The document's <c>dataPaths</c>, as strings — anything else in the array is dropped.</summary>
    private static List<string> Entries(IReadOnlyList<KeyValuePair<string, object?>> document)
    {
        foreach (KeyValuePair<string, object?> entry in document)
        {
            if (entry.Key == "dataPaths" && entry.Value is List<object?> list)
            {
                return list.OfType<string>().ToList();
            }
        }

        return new List<string>();
    }

    /// <summary>Replace a key in place, or append it — the order of everything else is the file's.</summary>
    private static void Put(
        List<KeyValuePair<string, object?>> document, string key, object? value)
    {
        for (int i = 0; i < document.Count; i++)
        {
            if (document[i].Key == key)
            {
                document[i] = new KeyValuePair<string, object?>(key, value);
                return;
            }
        }

        document.Add(new KeyValuePair<string, object?>(key, value));
    }

    /// <summary>The whole document, two-space indented — the shape every implementation writes.</summary>
    private static void Write(
        string configPath, string configDir, IReadOnlyList<KeyValuePair<string, object?>> document)
    {
        var json = new StringBuilder();
        WriteValue(json, document, 0);
        json.Append('\n');
        try
        {
            Directory.CreateDirectory(configDir);
            File.WriteAllText(configPath, json.ToString());
        }
        catch (IOException e)
        {
            throw new ConfigException($"cannot write config \"{configPath}\": {e.Message}");
        }
    }

    private static void WriteValue(StringBuilder output, object? value, int depth)
    {
        string pad = new(' ', (depth + 1) * 2);
        string closePad = new(' ', depth * 2);

        switch (value)
        {
            case IReadOnlyList<KeyValuePair<string, object?>> map:
                if (map.Count == 0)
                {
                    output.Append("{}");
                    return;
                }

                output.Append("{\n");
                for (int i = 0; i < map.Count; i++)
                {
                    output.Append(pad).Append('"').Append(Escape(map[i].Key)).Append("\": ");
                    WriteValue(output, map[i].Value, depth + 1);
                    output.Append(i == map.Count - 1 ? "\n" : ",\n");
                }

                output.Append(closePad).Append('}');
                return;

            case IReadOnlyList<object?> list:
                if (list.Count == 0)
                {
                    output.Append("[]");
                    return;
                }

                output.Append("[\n");
                for (int i = 0; i < list.Count; i++)
                {
                    output.Append(pad);
                    WriteValue(output, list[i], depth + 1);
                    output.Append(i == list.Count - 1 ? "\n" : ",\n");
                }

                output.Append(closePad).Append(']');
                return;

            case string text:
                output.Append('"').Append(Escape(text)).Append('"');
                return;

            case bool flag:
                output.Append(flag ? "true" : "false");
                return;

            case double number:
                output.Append(
                    number == Math.Floor(number) && double.IsFinite(number)
                        ? ((long)number).ToString(CultureInfo.InvariantCulture)
                        : number.ToString("R", CultureInfo.InvariantCulture));
                return;

            default:
                output.Append("null");
                return;
        }
    }

    /// <summary>
    /// Relative when it sits under the config's folder; absolute when it does not.
    /// </summary>
    /// <remarks>
    /// The relative form keeps the leading <c>./</c> the reference writes. It is the same path either
    /// way, but a config is a file people read and diff across implementations, so "the same" should
    /// also LOOK the same.
    /// </remarks>
    private static string Storable(string configDir, string target)
    {
        string absolute = Path.GetFullPath(target);
        string basePath = Path.GetFullPath(configDir);
        if (absolute == basePath)
        {
            return ".";
        }

        string prefix = basePath.EndsWith(Path.DirectorySeparatorChar)
            ? basePath
            : basePath + Path.DirectorySeparatorChar;
        return absolute.StartsWith(prefix, StringComparison.Ordinal)
            ? "./" + absolute[prefix.Length..].Replace('\\', '/')
            : absolute;
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static string Against(string basePath, string value)
    {
        string p = value.Trim();
        return Path.IsPathRooted(p) ? Path.GetFullPath(p) : Path.GetFullPath(Path.Combine(basePath, p));
    }
}
