using Tdcv2.Errors;
using Tdcv2.Formatter;
using Tdcv2.Parser;

namespace Tdcv2.Cli;

/// <summary>
/// <c>tdcv2</c> — the command line.
/// </summary>
/// <remarks>
/// <para>
/// The library is the recommended way to embed TDC; this exists so that a <c>.tdc</c> file can be run
/// without writing a program around it, and so that a .NET user never needs another language's
/// toolchain to do it. The surface deliberately matches the TypeScript, Java and Python CLIs flag for
/// flag: the same config run through any of them must behave the same way, including its exit codes.
/// </para>
/// <para>
/// Exit codes: 0 fine, 1 the run failed (an invalid config), 2 the command line itself was wrong.
/// </para>
/// <para>
/// Everything is written through the two writers passed in rather than through Console directly, so
/// the whole CLI can be driven by a test without capturing a process.
/// </para>
/// </remarks>
public static class Main
{
    public const string Version = "0.1.0";

    private const string Help = @"tdcv2 — The Data Constructor

Usage:
  tdcv2 <input.tdc> [options]       Generate data from a config
  tdcv2 init [--global]             Set up a config (asks where; --yes for defaults)
  tdcv2 pack [list|add|remove <id>] Install / remove data packs (list with no args)
  tdcv2 check <input.tdc>           Validate a config without generating anything
  tdcv2 format [-w] <file.tdc>      Pretty-print a config (-w writes it in place)

Options:
  -o, --output <path>      Write generated content to <path> (default: stdout)
  --seed <seed>            Override the seed declared in <env>
  --count <n>              Override the count declared in <env>
  --locale <loc>           Override the default locale (default: en)
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Worker threads for a large streaming run. The count never
                           changes the output, only how long it takes.
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the current
directory) and the global config — { ""dataPaths"": [...], ""locale"": "".."" }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdc-v2 for the DSL reference.

";

    /// <summary>Run the CLI. Returns the exit code rather than exiting, so tests can drive it.</summary>
    public static int Run(IReadOnlyList<string> argv, TextWriter stdout, TextWriter stderr)
    {
        // init and pack take the working directory as their subject rather than a file, which is
        // why they are dispatched by name here instead of going through the option parser.
        if (argv.Count > 0 && argv[0] == "init")
        {
            return Init.Run(
                argv.Skip(1).ToList(), Directory.GetCurrentDirectory(), stdout, stderr);
        }

        if (argv.Count > 0 && argv[0] == "pack")
        {
            return Pack.Run(
                argv.Skip(1).ToList(), Directory.GetCurrentDirectory(), stdout, stderr);
        }

        if (argv.Count > 0 && argv[0] == "check")
        {
            return Check(argv.Skip(1).ToList(), stderr);
        }

        if (argv.Count > 0 && argv[0] == "format")
        {
            return Format(argv.Skip(1).ToList(), stdout, stderr);
        }

        Args.Options options;
        try
        {
            options = Args.Parse(argv);
        }
        catch (Args.UsageException e)
        {
            Fail(stderr, e.Message, true);
            return 2;
        }

        if (options.Help)
        {
            stdout.Write(Help);
            return 0;
        }

        if (options.Version)
        {
            stdout.Write("tdcv2 " + Version + "\n");
            return 0;
        }

        if (options.Input is null)
        {
            Fail(stderr, "input file is required", true);
            return 2;
        }

        return Generate(options, stdout, stderr);
    }

    private static int Generate(Args.Options options, TextWriter stdout, TextWriter stderr)
    {
        Tdc data;
        try
        {
            var built = new Tdc.Options
            {
                ConfigFile = options.Input,
                Count = options.Count,
                SeedValue = options.Seed,
                Locale = options.Locale,
                DataPaths = options.DataPaths,
            };
            data = new Tdc(built);
        }
        catch (TdcDiagnosticException e)
        {
            Report(stderr, e.Diagnostics, options.Input, e.Source);
            return 1;
        }
        catch (Exception e) when (e is ArgumentException or IOException or InvalidOperationException)
        {
            Fail(stderr, e.Message, false);
            return 1;
        }

        Report(stderr, data.Diagnostics, options.Input, data.Source);

        // A run with no seed anywhere gets a random one. Print it, or the output cannot be
        // reproduced — which is the one promise the whole library is built to keep.
        Tdc.Seed seed = data.SeedInfo;
        if (seed.Generated)
        {
            Note(
                stderr,
                $"no seed specified — using random seed \"{seed.Value}\". Re-run with --seed "
                + $"\"{seed.Value}\" to reproduce this exact output.");
        }

        try
        {
            if (options.Output is not null)
            {
                data.WriteFile(options.Output);
            }
            else
            {
                stdout.Write(data.ToString());
            }
        }
        catch (Exception e) when (e is ArgumentException or IOException or InvalidOperationException)
        {
            Fail(stderr, e.Message, false);
            return 1;
        }

        return 0;
    }

    /// <summary><c>tdcv2 check &lt;file&gt;</c> — the validator alone, for an editor or a pre-commit hook.</summary>
    private static int Check(IReadOnlyList<string> argv, TextWriter stderr)
    {
        List<string> files = argv.Where(a => !a.StartsWith('-')).ToList();
        if (files.Count != argv.Count || files.Count != 1)
        {
            Fail(stderr, "usage: tdcv2 check <input.tdc>", false);
            return 2;
        }

        Tdc data;
        try
        {
            data = new Tdc(files[0]);
        }
        catch (TdcDiagnosticException e)
        {
            Report(stderr, e.Diagnostics, files[0], e.Source);
            return 1;
        }
        catch (Exception e) when (e is ArgumentException or IOException or InvalidOperationException)
        {
            Fail(stderr, e.Message, false);
            return 1;
        }

        IReadOnlyList<Diagnostic> problems = data.Diagnostics;
        Report(stderr, problems, files[0], data.Source);
        if (problems.Count == 0)
        {
            stderr.Write($"tdcv2: {files[0]} is valid\n");
        }

        return 0;
    }

    /// <summary>
    /// <c>tdcv2 format [-w] &lt;file.tdc&gt;</c> — pretty-print a config.
    /// </summary>
    /// <remarks>
    /// Prints to stdout by default; <c>-w</c> overwrites the file. A file with a syntax error is
    /// reported and left alone: reformatting something that cannot be parsed would be a guess about
    /// what the author meant.
    /// </remarks>
    private static int Format(IReadOnlyList<string> argv, TextWriter stdout, TextWriter stderr)
    {
        bool write = false;
        var files = new List<string>();
        foreach (string arg in argv)
        {
            if (arg is "-w" or "--write")
            {
                write = true;
            }
            else if (arg is "-h" or "--help")
            {
                stdout.Write("Usage: tdcv2 format [-w|--write] <file.tdc>\n");
                return 0;
            }
            else if (arg.StartsWith('-'))
            {
                Fail(stderr, "format: unknown option: " + arg, false);
                return 2;
            }
            else
            {
                files.Add(arg);
            }
        }

        if (files.Count != 1)
        {
            Fail(stderr, "format: a .tdc file is required", false);
            return 2;
        }

        string source;
        try
        {
            source = File.ReadAllText(files[0]);
        }
        catch (IOException e)
        {
            Fail(stderr, $"format: cannot read {files[0]}: {e.Message}", false);
            return 1;
        }

        // Never format a file we cannot fully parse — report the syntax error instead.
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(source);
        if (!parsed.Ok)
        {
            Report(
                stderr,
                parsed.Problems
                    .Select(p => Diagnostic.Error("TDC001", p.Message, "", p.Line, p.Column))
                    .ToList(),
                files[0],
                source);
            return 1;
        }

        string formatted = TdcFormatter.Format(source);
        if (!write)
        {
            stdout.Write(formatted);
            return 0;
        }

        try
        {
            if (formatted != source)
            {
                // Write beside the file and rename over it: a crash mid-write
                // must not leave the user's config truncated.
                string tmp = files[0] + ".tmp";
                File.WriteAllText(tmp, formatted);
                File.Move(tmp, files[0], overwrite: true);
                Note(stderr, "formatted " + files[0]);
            }
            else
            {
                Note(stderr, files[0] + " is already formatted");
            }
        }
        catch (IOException e)
        {
            Fail(stderr, $"format: cannot write {files[0]}: {e.Message}", false);
            return 1;
        }

        return 0;
    }

    /// <summary>Diagnostics to stderr, so they stay out of a piped or redirected run's data.</summary>
    private static void Report(
        TextWriter stderr, IReadOnlyList<Diagnostic> problems, string? filename, string? source)
    {
        if (problems.Count == 0)
        {
            return;
        }

        stderr.Write(
            DiagnosticRenderer.FormatAll(problems, source, filename ?? "<input>", false) + "\n");
    }

    internal static void Fail(TextWriter stderr, string message, bool usage)
    {
        stderr.Write("tdcv2: " + message + "\n");
        if (usage)
        {
            stderr.Write("Run `tdcv2 --help` for usage.\n");
        }
    }

    internal static void Note(TextWriter stderr, string message) =>
        stderr.Write("tdcv2: " + message + "\n");
}
