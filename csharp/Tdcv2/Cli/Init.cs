using Tdcv2.Packs;

namespace Tdcv2.Cli;

/// <summary>
/// <c>tdcv2 init</c> — create a config file by asking, rather than by making anyone hand-write JSON.
/// </summary>
/// <remarks>
/// <para>
/// People want to generate data, not learn a config format. At a real terminal this asks three
/// questions — where the config should live, where downloaded packs go, which locale — and writes the
/// file. With no console, in a script or in CI, it takes the answers from flags instead, so it stays
/// scriptable and testable.
/// </para>
/// <para>
/// The decisions are pure static methods; the questions are a thin shell over them. That is what the
/// tests exercise, because a prompt is hard to test and a decision is not.
/// </para>
/// </remarks>
public static class Init
{
    private const string Usage = @"Usage: tdcv2 init [options]

  -g, --global          Write the per-user config instead of a project one
  -y, --yes             Take the defaults, ask nothing
  -f, --force           Overwrite an existing config
  --locale <loc>        Default locale for the config (default: en)
  --data-path <dir>     Folder for downloaded packs
";

    /// <summary>A command line <c>init</c> cannot obey.</summary>
    public sealed class InitException : Exception
    {
        public InitException(string message)
            : base(message)
        {
        }
    }

    /// <summary>Everything decided, nothing written yet.</summary>
    public sealed record Plan(string Path, string PackStore, string Locale, bool IsGlobal);

    /// <summary>Where the config goes: the project's own folder, or the per-user location.</summary>
    public static string ConfigTarget(bool isGlobal, string cwd)
    {
        if (!isGlobal)
        {
            return System.IO.Path.Combine(
                System.IO.Path.GetFullPath(cwd), ProjectConfig.ProjectConfigName);
        }

        return ProjectConfig.GlobalConfigPath()
            ?? throw new InitException(
                "no global config location on this platform — use a project config");
    }

    /// <summary>A project keeps packs beside its config; the global config keeps them next to itself.</summary>
    public static string DefaultPackStore(bool isGlobal, string configPath, string cwd) =>
        isGlobal
            ? System.IO.Path.Combine(System.IO.Path.GetDirectoryName(configPath)!, "packs")
            : System.IO.Path.Combine(System.IO.Path.GetFullPath(cwd), "tdcv2-packs");

    /// <summary>
    /// The file's JSON.
    /// </summary>
    /// <remarks>
    /// The store is written as <c>packStore</c>, not as a <c>dataPaths</c> entry: it is where
    /// <c>pack add</c> downloads bundles, and it is deliberately not a scan root on its own — each
    /// installed bundle registers its own <c>packs</c> folder, so that addresses stay
    /// <c>en.person.lastName</c> rather than <c>en.packs.en.person.lastName</c>. A project config
    /// stores the path relative, so the file can be checked into git and still work on another
    /// machine; a global config is machine-specific by nature and stores it absolute.
    /// </remarks>
    public static string ConfigContent(Plan plan)
    {
        string store = plan.IsGlobal
            ? plan.PackStore
            : RelativeTo(System.IO.Path.GetDirectoryName(plan.Path)!, plan.PackStore);
        return "{\n  \"packStore\": \"" + Escape(store) + "\",\n  \"locale\": \""
            + Escape(plan.Locale) + "\"\n}\n";
    }

    private static string RelativeTo(string basePath, string target)
    {
        string absolute = System.IO.Path.GetFullPath(target);
        string root = System.IO.Path.GetFullPath(basePath);
        if (absolute == root)
        {
            return ".";
        }

        string prefix = root.EndsWith(System.IO.Path.DirectorySeparatorChar)
            ? root
            : root + System.IO.Path.DirectorySeparatorChar;
        return absolute.StartsWith(prefix, StringComparison.Ordinal)
            ? "./" + absolute[prefix.Length..].Replace('\\', '/')
            : absolute;
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>Write it, and create the pack folder so <c>pack add</c> has somewhere to go.</summary>
    public static void WriteConfig(Plan plan, bool force)
    {
        if (File.Exists(plan.Path) && !force)
        {
            throw new InitException(
                $"config already exists at \"{plan.Path}\" — pass --force to overwrite, or edit "
                + "it directly");
        }

        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(plan.Path)!);
        File.WriteAllText(plan.Path, ConfigContent(plan));
        Directory.CreateDirectory(plan.PackStore);
    }

    /// <summary>What the flags said.</summary>
    public sealed record Flags(
        bool IsGlobal, bool Force, bool Yes, string? Locale, string? PackStore);

    public static Flags ParseFlags(IReadOnlyList<string> argv)
    {
        bool isGlobal = false;
        bool force = false;
        bool yes = false;
        string? locale = null;
        string? packStore = null;

        for (int i = 0; i < argv.Count; i++)
        {
            string arg = argv[i];
            if (arg is "-g" or "--global")
            {
                isGlobal = true;
            }
            else if (arg is "-f" or "--force")
            {
                force = true;
            }
            else if (arg is "-y" or "--yes")
            {
                yes = true;
            }
            else if (arg.StartsWith("--locale=", StringComparison.Ordinal))
            {
                locale = arg["--locale=".Length..];
            }
            else if (arg.StartsWith("--data-path=", StringComparison.Ordinal))
            {
                packStore = arg["--data-path=".Length..];
            }
            else if (arg is "--locale" or "--data-path")
            {
                i++;
                if (i >= argv.Count)
                {
                    throw new InitException("missing value for " + arg);
                }

                if (arg == "--locale")
                {
                    locale = argv[i];
                }
                else
                {
                    packStore = argv[i];
                }
            }
            else
            {
                throw new InitException("unknown option for init: " + arg);
            }
        }

        return new Flags(isGlobal, force, yes, locale, packStore);
    }

    public static Plan PlanFromFlags(Flags flags, string cwd)
    {
        string path = ConfigTarget(flags.IsGlobal, cwd);
        string store = flags.PackStore is not null
            ? System.IO.Path.GetFullPath(System.IO.Path.Combine(cwd, flags.PackStore))
            : DefaultPackStore(flags.IsGlobal, path, cwd);
        return new Plan(path, store, flags.Locale ?? "en", flags.IsGlobal);
    }

    public static int Run(
        IReadOnlyList<string> argv, string cwd, TextWriter stdout, TextWriter stderr)
    {
        if (argv.Contains("-h") || argv.Contains("--help"))
        {
            stdout.Write(Usage);
            return 0;
        }

        Flags flags;
        try
        {
            flags = ParseFlags(argv);
        }
        catch (InitException e)
        {
            stderr.Write("tdcv2: " + e.Message + "\n");
            stderr.Write("Run `tdcv2 init --help` for usage.\n");
            return 2;
        }

        // No console means no terminal to ask at — a pipe, a script, a CI job. That is exactly the
        // question Console.IsInputRedirected answers.
        bool interactive = !Console.IsInputRedirected && !flags.Yes;

        Plan plan;
        try
        {
            plan = interactive ? Ask(flags, cwd, stdout) : PlanFromFlags(flags, cwd);
        }
        catch (InitException e)
        {
            stderr.Write("tdcv2: " + e.Message + "\n");
            return 2;
        }

        try
        {
            WriteConfig(plan, flags.Force);
        }
        catch (Exception e) when (e is InitException or IOException)
        {
            stderr.Write("tdcv2: " + e.Message + "\n");
            return 2;
        }

        stdout.Write(
            $"Wrote {(plan.IsGlobal ? "global" : "project")} config: {plan.Path}\n");
        stdout.Write($"  data packs → {plan.PackStore}\n");
        stdout.Write($"  locale     → {plan.Locale}\n");
        stdout.Write("\n");
        stdout.Write("Next: run `tdcv2 pack` to download data packs into that folder.\n");
        return 0;
    }

    private static Plan Ask(Flags flags, string cwd, TextWriter stdout)
    {
        bool isGlobal = flags.IsGlobal;
        if (flags.PackStore is null && !flags.IsGlobal)
        {
            stdout.Write("Where should this config live?\n");
            stdout.Write("  1) This project — a tdcv2.config.json here, check it into git\n");
            stdout.Write("  2) Global — all your projects, in your home folder\n");
            isGlobal = Read(stdout, "Choice [1]: ") == "2";
        }

        string path = ConfigTarget(isGlobal, cwd);
        string suggested = flags.PackStore is not null
            ? System.IO.Path.GetFullPath(System.IO.Path.Combine(cwd, flags.PackStore))
            : DefaultPackStore(isGlobal, path, cwd);

        string typed = Read(stdout, $"Folder for downloaded data packs [{suggested}]: ");
        string store = typed.Length == 0
            ? suggested
            : System.IO.Path.GetFullPath(System.IO.Path.Combine(cwd, typed));

        string fallback = flags.Locale ?? "en";
        string locale = Read(stdout, $"Default locale [{fallback}]: ");
        return new Plan(path, store, locale.Length == 0 ? fallback : locale, isGlobal);
    }

    private static string Read(TextWriter stdout, string prompt)
    {
        stdout.Write(prompt);
        stdout.Flush();
        return Console.ReadLine()?.Trim() ?? "";
    }
}
