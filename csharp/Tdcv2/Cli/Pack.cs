using System.Globalization;
using System.Text;
using Tdcv2.Packs;

namespace Tdcv2.Cli;

/// <summary>
/// <c>tdcv2 pack</c> — the data packs, from the shared registry.
/// </summary>
/// <remarks>
/// <para>
/// The library ships with English and the USA and nothing else, because the packs are meant to grow
/// to a size no library should carry. Everything else is downloaded on demand from one registry that
/// every implementation reads, so a pack fetched by any of them works in the others.
/// </para>
/// <para>
/// A bundle is axis-pure — one language (<c>en</c>), or one country (<c>usa</c>), or <c>common</c> —
/// because language and country are independent and compose: US English is common + en + usa.
/// Installing extracts to <c>&lt;store&gt;/&lt;id&gt;/</c> and registers only that bundle's own
/// <c>packs</c> folder in the config, so addresses stay <c>en.person.lastName</c> and never
/// <c>en.packs.en.person.lastName</c>.
/// </para>
/// <para>
/// Where things go is decided by the config cascade, not guessed: <c>packStore</c> from the nearest
/// <c>tdcv2.config.json</c>, else the global one. With neither, <c>init</c> has not been run and this
/// says so rather than inventing a folder.
/// </para>
/// </remarks>
public static class Pack
{
    private const string Usage = @"Usage: tdcv2 pack [command]

  list                  Show what can be installed, and what already is
  add <id>...           Download and install one or more bundles
  remove <id>...        Uninstall, and drop them from the config

  --registry <url>      Use another registry (default: the public one)
";

    /// <summary>Where downloads go, and which config file records them.</summary>
    public sealed record Store(string Path, string ConfigPath);

    /// <summary>
    /// The pack folder and the config that owns it, from the cascade.
    /// </summary>
    /// <remarks>
    /// A project config wins over the global one — packs belong to the project that uses them.
    /// Neither means <c>init</c> has not run, and guessing a folder here would put data somewhere the
    /// next command would not look.
    /// </remarks>
    public static Store ResolveStore(string cwd)
    {
        ProjectConfig.Resolved resolved = ProjectConfig.Load(cwd);

        string? configPath = ProjectConfig.FindProjectConfig(cwd)
            ?? ProjectConfig.GlobalConfigPath();
        if (configPath is null || !File.Exists(configPath))
        {
            throw new PackRegistry.PackException(
                "no tdcv2.config.json found — run `tdcv2 init` first");
        }

        return resolved.PackStore is null
            ? throw new PackRegistry.PackException(
                $"config \"{configPath}\" does not name a \"packStore\" — add one, or re-run "
                + "`tdcv2 init --force`")
            : new Store(resolved.PackStore, configPath);
    }

    public static int Run(
        IReadOnlyList<string> argv, string cwd, TextWriter stdout, TextWriter stderr)
    {
        if (argv.Contains("-h") || argv.Contains("--help"))
        {
            stdout.Write(Usage);
            return 0;
        }

        string? registryUrl = null;
        var rest = new List<string>();
        for (int i = 0; i < argv.Count; i++)
        {
            string arg = argv[i];
            if (arg == "--registry")
            {
                i++;
                if (i >= argv.Count)
                {
                    stderr.Write("tdcv2: missing value for --registry\n");
                    return 2;
                }

                registryUrl = argv[i];
            }
            else if (arg.StartsWith("--registry=", StringComparison.Ordinal))
            {
                registryUrl = arg["--registry=".Length..];
            }
            else
            {
                rest.Add(arg);
            }
        }

        // No subcommand on a terminal opens the picker; anywhere else — a pipe, a script — it
        // lists, which answers the same question without needing a keyboard.
        bool bare = rest.Count == 0;
        string command = rest.Count == 0 ? "list" : rest[0];
        List<string> ids = rest.Count == 0 ? new List<string>() : rest.Skip(1).ToList();

        Store store;
        try
        {
            store = ResolveStore(cwd);
        }
        catch (PackRegistry.PackException e)
        {
            stderr.Write("tdcv2: " + e.Message + "\n");
            return 2;
        }

        var registry = registryUrl is null ? new PackRegistry() : new PackRegistry(registryUrl);

        try
        {
            if (bare && PackPicker.Usable())
            {
                return Browse(registry, store, stdout, stderr);
            }

            switch (command)
            {
                case "list":
                    return List(registry, store, stdout);
                case "add":
                    if (ids.Count == 0)
                    {
                        stderr.Write("tdcv2: `pack add` needs at least one bundle id\n");
                        return 2;
                    }

                    return Add(registry, store, ids, stdout, stderr);
                case "remove":
                    if (ids.Count == 0)
                    {
                        stderr.Write("tdcv2: `pack remove` needs at least one bundle id\n");
                        return 2;
                    }

                    return Remove(store, ids, stdout, stderr);
                default:
                    stderr.Write(
                        $"tdcv2: unknown pack command \"{command}\" (use list | add | remove)\n");
                    return 2;
            }
        }
        catch (Exception e) when (e is PackRegistry.PackException or IOException
                                      or ProjectConfig.ConfigException)
        {
            stderr.Write("tdcv2: " + e.Message + "\n");
            return 2;
        }
    }

    /// <summary>Where a description starts: two spaces, the id column, a space.</summary>
    /// <summary>The narrowest the id column ever gets: two spaces, twelve, a space.</summary>
    /// <remarks>
    /// It grows to fit the widest id in the catalogue — <c>sao_tome_and_principe</c> is twenty-one
    /// characters, and a fixed twelve pushed every column after it out of line on that row alone.
    /// It never shrinks below this, so a short catalogue keeps the shape the shared CLI fixture
    /// pins.
    /// </remarks>
    private const int MinIdWidth = 12;

    /// <summary>
    /// Text folded to the terminal, with every line under the same indent.
    /// </summary>
    /// <remarks>
    /// Descriptions run to two hundred characters. Printed as one line each they wrap wherever the
    /// window happens to end and the remainder lands hard against the left margin, which turns a list
    /// of a hundred packs into a wall nobody can read down. Off a terminal there is no width to ask
    /// for, so 80 is assumed — the same answer every implementation gives, which keeps their output
    /// identical when it is piped.
    /// </remarks>
    private static IReadOnlyList<string> Wrap(string text, int indent)
    {
        int width = Math.Max(40, TerminalColumns()) - indent;
        string pad = new(' ', indent);
        var lines = new List<string>();
        var line = new StringBuilder();
        foreach (string word in text.Trim().Split(
                     (char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.Length == 0)
            {
                line.Append(word);
            }
            else if (line.Length + 1 + word.Length <= width)
            {
                line.Append(' ').Append(word);
            }
            else
            {
                lines.Add(pad + line);
                line = new StringBuilder(word);
            }
        }

        if (line.Length > 0)
        {
            lines.Add(pad + line);
        }

        return lines;
    }

    /// <summary>
    /// How wide the terminal is, or 80 when there is not one.
    /// </summary>
    /// <remarks>
    /// Asked of the terminal itself, never of <c>COLUMNS</c>: the other implementations ask the file
    /// descriptor, and an environment variable that only one of them honours is a way for the same
    /// command to print differently in the same shell.
    /// </remarks>
    private static int TerminalColumns()
    {
        try
        {
            return Console.IsOutputRedirected ? 80 : Console.WindowWidth;
        }
        catch (IOException)
        {
            return 80;
        }
    }

    /// <summary>The picker, and then whatever it decided.</summary>
    /// <remarks>
    /// The picker draws and returns; installing and removing stay here, so the download progress,
    /// the digests and the config writing live in one place rather than two.
    /// </remarks>
    private static int Browse(
        PackRegistry registry, Store store, TextWriter stdout, TextWriter stderr)
    {
        PackRegistry.Index index = registry.ReadIndex();
        if (index.Bundles.Count == 0)
        {
            stdout.Write("No bundles in the registry.\n");
            return 0;
        }

        var here = PackRegistry.Installed(store.Path).ToHashSet(StringComparer.Ordinal);
        PackPicker.Decision? decision = PackPicker.Run(index.Bundles, here, stdout);
        if (decision is null || (decision.Install.Count == 0 && decision.Remove.Count == 0))
        {
            stdout.Write("Nothing changed.\n");
            return 0;
        }

        if (decision.Remove.Count > 0)
        {
            Remove(store, decision.Remove, stdout, stderr);
        }

        return decision.Install.Count > 0
            ? Add(registry, store, decision.Install, stdout, stderr)
            : 0;
    }

    private static int List(PackRegistry registry, Store store, TextWriter stdout)
    {
        PackRegistry.Index index = registry.ReadIndex();
        var here = PackRegistry.Installed(store.Path).ToHashSet(StringComparer.Ordinal);

        if (index.Bundles.Count == 0)
        {
            stdout.Write("No bundles in the registry.\n");
            return 0;
        }

        int idWidth = Math.Max(MinIdWidth, index.Bundles.Max(b => b.Id.Length));
        // Two spaces of margin, the id column, one space — where a description and the
        // "installed" mark both start.
        int indent = 2 + idWidth + 1;

        stdout.Write("Available data packs:\n");
        stdout.Write("\n");
        foreach (PackRegistry.Bundle bundle in index.Bundles)
        {
            string mark = here.Contains(bundle.Id) ? "✓ installed" : " ";
            stdout.Write(string.Create(
                CultureInfo.InvariantCulture,
                $"  {bundle.Id.PadRight(idWidth)} {mark,-12} {bundle.Name} ({Megabytes(bundle.Bytes)})\n"));
            foreach (string line in Wrap(bundle.Description, indent))
            {
                stdout.Write(line + "\n");
            }

            stdout.Write("\n");
        }

        // An id in the store that the registry no longer lists still works; saying so beats a silent
        // omission that reads like the pack is gone.
        var known = index.Bundles.Select(b => b.Id).ToHashSet(StringComparer.Ordinal);
        List<string> orphans = here
            .Where(id => !known.Contains(id))
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToList();
        if (orphans.Count > 0)
        {
            stdout.Write("Installed but not in this registry: " + string.Join(", ", orphans) + "\n");
            stdout.Write("\n");
        }

        stdout.Write("Install with: tdcv2 pack add <id>\n");
        return 0;
    }

    private static int Add(
        PackRegistry registry, Store store, IReadOnlyList<string> ids, TextWriter stdout,
        TextWriter stderr)
    {
        PackRegistry.Index index = registry.ReadIndex();
        // Every id is looked up before anything is downloaded, so a typo in the third one does not
        // leave the first two half-installed.
        List<PackRegistry.Bundle> bundles = ids.Select(index.Find).ToList();

        foreach (PackRegistry.Bundle bundle in bundles)
        {
            stderr.Write($"tdcv2: downloading {bundle.Id} ({Megabytes(bundle.Bytes)})…\n");
            string root = registry.Install(bundle, store.Path);
            string directory = System.IO.Path.Combine(store.Path, bundle.Id);
            string stored = ProjectConfig.StoredPath(store.ConfigPath, root);
            bool added = ProjectConfig.Register(store.ConfigPath, new[] { root });
            stdout.Write(
                $"Installed {bundle.Id}: {CountFiles(directory)} files → {directory}\n");
            stdout.Write(
                added
                    ? $"  registered {stored} in {store.ConfigPath}\n"
                    : $"  already registered in {store.ConfigPath}\n");
        }

        return 0;
    }

    /// <summary>Everything the bundle unpacked, for the line that reports what landed.</summary>
    private static int CountFiles(string directory) =>
        Directory.Exists(directory)
            ? Directory.GetFiles(directory, "*", SearchOption.AllDirectories).Length
            : 0;

    private static int Remove(
        Store store, IReadOnlyList<string> ids, TextWriter stdout, TextWriter stderr)
    {
        foreach (string id in ids)
        {
            string directory = System.IO.Path.Combine(store.Path, id);
            string packs = System.IO.Path.Combine(directory, PackRegistry.BundlePacksDir);
            if (!Directory.Exists(packs) && !Directory.Exists(directory))
            {
                // Not an error. `remove` is asked for to reach a state, and that state already
                // holds; exiting non-zero would make an idempotent script fail on its second run.
                stderr.Write($"tdcv2: \"{id}\" is not installed — nothing to remove\n");
                continue;
            }

            bool removed = ProjectConfig.Unregister(store.ConfigPath, new[] { packs });
            Directory.Delete(directory, recursive: true);
            stdout.Write($"Removed {id} ({directory})\n");
            stdout.Write(
                removed
                    ? $"  unregistered from {store.ConfigPath}\n"
                    : $"  was not registered in {store.ConfigPath}\n");
        }

        return 0;
    }

    private static string Megabytes(long bytes) =>
        (bytes / 1024.0 / 1024.0).ToString("F1", CultureInfo.InvariantCulture) + " MB";
}
