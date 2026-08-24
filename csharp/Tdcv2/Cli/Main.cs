using System.Reflection;
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
/// Exit codes: 0 fine, 1 the run failed (an invalid config, a refused preflight), 2 the command line
/// itself was wrong.
/// </para>
/// <para>
/// Everything is written through the two writers passed in rather than through Console directly, so
/// the whole CLI can be driven by a test without capturing a process.
/// </para>
/// </remarks>
public static class Main
{
    /// <summary>
    /// The version this assembly was built as, not a second copy of it.
    /// </summary>
    /// <remarks>
    /// A hand-written constant is a number that agrees with itself and with nothing else: bumping
    /// <c>Tdcv2.csproj</c> for a release left <c>tdcv2 --version</c> reporting the old one, silently.
    /// The TypeScript package had exactly this bug and it went unnoticed through a release. Asking
    /// the assembly means the two cannot drift apart again.
    /// </remarks>
    public static readonly string Version = ResolveVersion();

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
  --now <date>             Pin the clock date generators read as ""now"" —
                           YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss, always UTC.
                           Without it the run reads the real clock, so a config
                           using today / now / b_day cannot be reproduced later
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Worker threads for a large streaming run. Needs -o:
                           stdout is written by one thread. By default TDC uses
                           one per core bar one; the count never changes the
                           output, only how long it takes.
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --progress               Write <output>.progress — a small JSON status file
                           refreshed about once a second (phase, rows done,
                           percent). Needs -o. Poll it, or watch its mtime as
                           a heartbeat: not updated for minutes = not running
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the current
directory) and the global config — { ""dataPaths"": [...], ""locale"": "".."" }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdcv2 for the DSL reference.

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

    /// <summary>What to say when the config named on the command line is not there.</summary>
    /// <remarks>
    /// Byte-identical in all five: it is one command with five front ends, and a reader who
    /// hits this in one must not get less help in the next.
    /// </remarks>
    internal static string MissingConfigMessage(string file) =>
        $"tdcv2: no config file at \"{file}\"\n\n" +
        "  `tdcv2 init` writes a config and three worked examples into this folder,\n" +
        "  then prints the command that runs the first one.\n";

    private static int Generate(Args.Options options, TextWriter stdout, TextWriter stderr)
    {
        // Checked here rather than left to the reader: this is the first error a newcomer can
        // hit and it used to be the worst one in the product — a raw "Could not find file" with
        // no code, no hint and no mention of the command that would have created something to
        // run.
        if (options.Input is not null && !File.Exists(options.Input))
        {
            stderr.Write(MissingConfigMessage(options.Input));
            return 1;
        }

        StatusFile? status = null;
        if (options.Progress)
        {
            if (options.Output is null)
            {
                stderr.Write("tdcv2: --progress needs -o (the status file lives beside the output)\n");
                return 2;
            }

            status = new StatusFile(options.Output + ".progress");
        }

        Tdc data;
        try
        {
            var built = new Tdc.Options
            {
                ConfigFile = options.Input,
                OnProgress = status is null ? null : status.Report,
                Count = options.Count,
                SeedValue = options.Seed,
                Locale = options.Locale,
                NowMillis = options.Now,
                DataPaths = options.DataPaths,
                // Either of these outranks what <env> declared: a flag the user typed on this run is
                // a more recent statement of intent than a line in the file. Which of the two wins
                // when both are given is the model's rule, not the command line's.
                Engine = options.Engine,
                Mode = options.Mode,
            };
            data = new Tdc(built);

            int code = Produce(data, options, stdout, stderr);
            if (code == 0)
            {
                status?.Finish();
            }

            return code;
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
    }

    /// <summary>
    /// The <c>--progress</c> status file: one small JSON object, rewritten in place.
    /// </summary>
    /// <remarks>
    /// Written atomically (temp + rename) so a poller never reads half a JSON, and throttled to
    /// about once a second so watching costs nothing. The file itself is the heartbeat — an mtime
    /// that stops moving for minutes means the process is gone, whatever the content says. On
    /// success the last write says <c>"phase":"done"</c> with the wall-clock seconds the run took.
    /// <para>
    /// A run split across workers is counted whole: every shard reports the rows it has written
    /// and the coordinator adds them up, so the percent is the FILE's, not one worker's.
    /// </para>
    /// </remarks>
    private sealed class StatusFile
    {
        private readonly string _path;
        private readonly long _startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        private long _lastWrite;

        internal StatusFile(string path) => _path = path;

        private void Write(string payload)
        {
            string tmp = _path + ".tmp";
            try
            {
                File.WriteAllText(tmp, payload + "\n");
                File.Move(tmp, _path, overwrite: true);
            }
            catch (IOException)
            {
                // A status file nobody can write is not a reason to lose the run it describes.
            }
        }

        internal void Report(string phase, int done, int total)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            // A finished phase is always written, throttle or not: forty-four piles can finish
            // inside one second, and the throttle then dropped every report after the first —
            // leaving the file saying "1 of 44" while the run had moved on.
            if (done != total && now - _lastWrite < 1000)
            {
                return;
            }

            _lastWrite = now;
            // AwayFromZero, not the default: .NET rounds midpoints to even, so a percent
            // landing exactly on a half — 812.5 — would go to 812 where the reference's
            // Math.round gives 813. One field, two answers.
            double percent = total > 0
                ? Math.Round((double)done / total * 1000, MidpointRounding.AwayFromZero) / 10
                : 0;
            Write(
                $"{{\"phase\":\"{phase}\",\"done\":{done},\"total\":{total}," +
                $"\"percent\":{Number(percent)},\"startedAt\":{_startedAt}," +
                $"\"updatedAt\":{now},\"pid\":{Environment.ProcessId}}}");
        }

        internal void Finish()
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Write(
                $"{{\"phase\":\"done\",\"percent\":100,\"startedAt\":{_startedAt}," +
                $"\"updatedAt\":{now}," +
                $"\"elapsedSeconds\":" +
                $"{(long)Math.Round((now - _startedAt) / 1000.0, MidpointRounding.AwayFromZero)}," +
                $"\"pid\":{Environment.ProcessId}}}");
        }

        /// <summary>A whole percentage prints without its ".0", as every other runtime writes it.</summary>
        private static string Number(double value) =>
            value == Math.Round(value)
                ? ((long)value).ToString(System.Globalization.CultureInfo.InvariantCulture)
                : value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Everything after the config is built: report, seed note, preflight, write.</summary>
    /// <remarks>
    /// Split out so it sits INSIDE the caller's try rather than between two of them. It used to
    /// sit between, and the engine router throws from <c>Preflight</c> — so a plain
    /// <c>mode="nonsense"</c> escaped both catches, printed a .NET stack trace where the reference
    /// prints one line, and left the process with exit code 134 instead of 1. A script testing
    /// for failure saw a crash, not a rejected config.
    /// </remarks>
    private static int Produce(
        Tdc data, Args.Options options, TextWriter stdout, TextWriter stderr)
    {
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

        // Ask what the run will cost before starting it. A config that cannot fit says so in a
        // millisecond here and takes minutes to say so by thrashing.
        Diagnostic? budget = data.Preflight(options.Output is null);
        if (budget is not null)
        {
            ReportOne(stderr, budget, options.Input, data.Source);
            if (budget.Severity == Severity.Error)
            {
                return 1;
            }
        }

        if (options.Output is not null)
        {
            // No --jobs means "decide from the machine". The worker count never changes the
            // bytes — a shard is a range of rows and every row is a function of its own number
            // — so it is safe to pick from the hardware, unlike the engine, which follows from
            // the config.
            data.WriteFile(options.Output, options.Jobs ?? 0);
        }
        else
        {
            stdout.Write(data.ToString());
        }

        return 0;
    }

    /// <summary><c>tdcv2 check &lt;file&gt;</c> — the validator alone, for an editor or a pre-commit hook.</summary>
    private static int Check(IReadOnlyList<string> argv, TextWriter stderr)
    {
        // `--brief` prints one line per diagnostic and no source excerpt: an editor
        // listing errors in a panel wants rows, not a picture of the file.
        bool brief = argv.Contains("--brief");
        List<string> files = argv.Where(a => !a.StartsWith('-')).ToList();
        if (argv.Any(a => a.StartsWith('-') && a != "--brief") || files.Count != 1)
        {
            Fail(stderr, "usage: tdcv2 check [--brief] <input.tdc>", false);
            return 2;
        }

        Tdc data;
        try
        {
            data = new Tdc(files[0]);
        }
        catch (TdcDiagnosticException e)
        {
            Report(stderr, e.Diagnostics, files[0], e.Source, brief);
            return 1;
        }
        catch (Exception e) when (e is ArgumentException or IOException or InvalidOperationException)
        {
            Fail(stderr, e.Message, false);
            return 1;
        }

        IReadOnlyList<Diagnostic> problems = data.Diagnostics;
        Report(stderr, problems, files[0], data.Source, brief);
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
                    .Select(p => Diagnostic.ErrorAt("TDC001", p.Message, "", p.Line, p.Column))
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
        TextWriter stderr, IReadOnlyList<Diagnostic> problems, string? filename, string? source,
        bool brief = false)
    {
        if (problems.Count == 0)
        {
            return;
        }

        if (brief)
        {
            stderr.Write(string.Join("\n", problems.Select(BriefLine)) + "\n");
            return;
        }

        stderr.Write(
            DiagnosticRenderer.FormatAll(problems, source, filename ?? "<input>", false) + "\n");
    }

    /// <summary>
    /// One diagnostic on one line: code, position, message, hint after <c>::</c>.
    /// </summary>
    /// <remarks>
    /// The hint is kept because it carries the list of what IS allowed, which is the half a
    /// reader — or a model — acts on. No trailing count either, so a caller parsing rows need
    /// not skip a sentence at the end.
    /// </remarks>
    private static string BriefLine(Diagnostic d)
    {
        string code = string.IsNullOrEmpty(d.Code)
            ? (d.Severity == Severity.Warning ? "WARN" : "ERROR")
            : d.Code;
        string hint = string.IsNullOrEmpty(d.Hint) ? "" : $" :: {d.Hint}";
        return $"{code} {d.Line}:{d.Column} {d.Message}{hint}";
    }

    /// <summary>
    /// One diagnostic that did not come from validation, so without the "n errors" tally.
    /// </summary>
    /// <remarks>
    /// The tally counts a config's complaints. The preflight is a separate question asked after
    /// the config passed, and folding it into the count would report a valid config as an invalid
    /// one.
    /// </remarks>
    private static void ReportOne(
        TextWriter stderr, Diagnostic problem, string? filename, string? source) =>
        stderr.Write(
            DiagnosticRenderer.Format(problem, source, filename ?? "<input>", false) + "\n");

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

    private static string ResolveVersion()
    {
        Assembly assembly = typeof(Main).Assembly;
        string? informational = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(informational))
        {
            // A source tree compiled without the package metadata has no informational version;
            // the assembly version is still four numbers, and three of them are the release.
            return assembly.GetName().Version?.ToString(3) ?? "0+unknown";
        }

        // The SDK appends "+<commit>" when it can find one. That is build provenance, not the number
        // a user compares against npm or PyPI, and the shared CLI fixture expects a bare semver.
        int plus = informational.IndexOf('+');
        return plus < 0 ? informational : informational[..plus];
    }
}
