using System.Globalization;
using Tdcv2.Engine;
using Tdcv2.Errors;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Parser;
using Tdcv2.Validation;

namespace Tdcv2;

/// <summary>
/// Generate data from a <c>.tdc</c> config.
/// </summary>
/// <remarks>
/// <para>
/// The entry point. Point it at a file or hand it the config as a string, then take the result as
/// text or as rows:
/// </para>
/// <code>
/// var data = new Tdc("users.tdc");
/// Console.WriteLine(data);
///
/// foreach (Tdc.Row row in data.Rows())
/// {
///     Console.WriteLine(row["Gender"]);
/// }
/// </code>
/// <para>
/// Rows are the reason to use the library rather than the command line. A test that asserts on
/// <c>row["Gender"]</c> says what it means; the same test parsing CSV back out of a string spends
/// most of its lines on the parsing.
/// </para>
/// <para>
/// Text output and row output read the same generated values, so the two never disagree. Row output
/// ignores <c>&lt;block&gt;</c> and the wrappers entirely — those describe a file format, and a row
/// has no format.
/// </para>
/// </remarks>
public sealed class Tdc
{
    /// <summary>
    /// What one generated value is assumed to cost, held as a string.
    /// </summary>
    /// <remarks>
    /// A name, a number or a short date lands in the twenty-to-forty byte range once the object
    /// header is counted. The figure is shared with the other four implementations so that a config
    /// refused on one is refused on all of them.
    /// </remarks>
    private const int BytesPerCell = 40;

    /// <summary>What one rendered record is assumed to cost: its literal text plus the values in it.</summary>
    private const int BytesPerRenderedCard = 200;

    /// <summary>
    /// Warn once the estimate reaches this share of the machine's RAM.
    /// </summary>
    /// <remarks>
    /// The run will take a big part of the machine and may lean on swap if anything else is busy,
    /// but it can still finish — so it is worth saying and not worth stopping for.
    /// </remarks>
    private const double WarnRatio = 0.5;

    /// <summary>
    /// Refuse once the estimate reaches this share of the machine's RAM.
    /// </summary>
    /// <remarks>
    /// Headroom below 1.0 leaves room for the operating system, for everything else running, and
    /// for the estimate's own roughness.
    /// </remarks>
    private const double ErrorRatio = 0.9;

    private readonly Config _config;
    private readonly DataPacks _packs;
    private readonly long _nowMillis;
    private readonly string? _baseDir;
    private readonly Lazy<IRowSource> _run;

    /// <summary>
    /// Where the packs came from, kept so a parallel write can build one registry per worker.
    /// </summary>
    /// <remarks>
    /// The registry itself cannot be shared: it caches what it loads in a plain dictionary, and
    /// filling one from several threads at once is a data race. Rebuilding needs the same two
    /// inputs the constructor used, so those are what is stored rather than the result.
    /// </remarks>
    private readonly string? _packsDir;
    private readonly IReadOnlyList<string> _dataPaths;

    /// <summary>
    /// Whether the seed was invented here because nothing declared one.
    /// </summary>
    /// <remarks>
    /// Stored rather than inferred from an empty seed: once one is generated the config carries it
    /// like any other, and "is it empty" would then answer no to a question it used to answer yes
    /// to.
    /// </remarks>
    private readonly bool _seedGenerated;

    /// <summary>One record: its sequences, addressable by the names the config gave them.</summary>
    public sealed class Row
    {
        private readonly IRowSource _source;

        internal Row(IRowSource source, int index)
        {
            _source = source;
            Index = index;
        }

        /// <summary>The 0-based position of this row in the run.</summary>
        public int Index { get; }

        /// <summary>
        /// The value of one sequence on this row.
        /// </summary>
        /// <returns>
        /// <c>null</c> when the sequence does not apply here — a column declared with
        /// <c>parent="Gender.Male"</c> has no value on a female row, and an empty string would claim
        /// it had one that happened to be blank.
        /// </returns>
        public string? this[string sequence] => _source.Value(sequence, Index);

        /// <summary>Every sequence with a value here, in declaration order.</summary>
        public IReadOnlyDictionary<string, string> ToDictionary()
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string name in _source.SequenceNames)
            {
                if (_source.Value(name, Index) is { } value)
                {
                    result[name] = value;
                }
            }

            return result;
        }

        /// <summary>
        /// The same row with compound sequences nested.
        /// </summary>
        /// <remarks>
        /// A compound is one thing with parts, so it reads as one entry holding a map rather than as
        /// several sibling entries whose shared prefix the caller has to notice:
        /// <c>row.Nested()["Address"]</c> gives the whole address, keyed by field.
        /// </remarks>
        public IReadOnlyDictionary<string, object> Nested()
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, string> entry in ToDictionary())
            {
                int dot = entry.Key.IndexOf('.');
                if (dot < 0)
                {
                    result[entry.Key] = entry.Value;
                    continue;
                }

                string parent = entry.Key[..dot];
                string field = entry.Key[(dot + 1)..];
                if (result.TryGetValue(parent, out object? existing)
                    && existing is Dictionary<string, string> group)
                {
                    group[field] = entry.Value;
                }
                else
                {
                    result[parent] = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        [field] = entry.Value,
                    };
                }
            }

            return result;
        }

        public override string ToString() =>
            "{" + string.Join(", ", ToDictionary().Select(e => $"{e.Key}={e.Value}")) + "}";
    }

    /// <summary>What <see cref="SeedInfo"/> reports: the seed used, and whether the config supplied it.</summary>
    public readonly record struct Seed(string Value, bool Generated);

    /// <summary>Everything a run can be told, for the cases the constructors do not cover.</summary>
    public sealed class Options
    {
        public string? ConfigFile { get; set; }

        public string? ConfigString { get; set; }

        public int? Count { get; set; }

        public string? SeedValue { get; set; }

        public string? Locale { get; set; }

        /// <summary>
        /// The clock, for <c>value="today"</c> and for a birth date's age window.
        /// </summary>
        /// <remarks>
        /// A parameter so a test can pin it; without that a test asserting on a generated date would
        /// pass today and fail tomorrow.
        /// </remarks>
        public long? NowMillis { get; set; }

        /// <summary>Where the data packs live. Defaults to the ones this build can discover.</summary>
        public string? PacksDir { get; set; }

        /// <summary>
        /// Extra folders an <c>@data/…</c> source may name, highest priority last.
        /// </summary>
        /// <remarks>
        /// Layered ON TOP of the discovered packs rather than replacing them: a config that adds one
        /// folder for its own CSVs must not lose every bundled locale by doing so.
        /// </remarks>
        public IReadOnlyList<string> DataPaths { get; set; } = Array.Empty<string>();

        /// <summary>
        /// What a relative <c>src=</c> is relative to.
        /// </summary>
        /// <remarks>
        /// With a config file it defaults to that file's folder. With a config string there is no
        /// file to be relative to, so the caller says where — and if they do not, the working
        /// directory is the only honest answer left.
        /// </remarks>
        public string? BaseDir { get; set; }

        /// <summary>
        /// Run on one named engine — 1 in memory, 2 streaming, 3 exact on disk.
        /// </summary>
        /// <remarks>
        /// Overrides everything the config says and refuses rather than falling back when the named
        /// engine cannot do what the config asks. That is what makes it useful for a benchmark and
        /// wrong for ordinary use.
        /// </remarks>
        public int? Engine { get; set; }

        /// <summary>
        /// <c>memory</c> or <c>disk</c> — how much of the run may be held at once.
        /// </summary>
        /// <remarks>
        /// A constraint rather than a choice: the router picks the fastest engine that can honour
        /// it, so a config that turns out to need the whole column still renders correctly. Beaten
        /// by <see cref="Engine"/>, and beats whatever <c>&lt;env&gt;</c> declared.
        /// </remarks>
        public string? Mode { get; set; }
    }

    /// <summary>A config file, everything else from <c>&lt;env&gt;</c>.</summary>
    public Tdc(string configFile)
        : this(new Options { ConfigFile = configFile })
    {
    }

    public Tdc(Options options)
    {
        if (options.ConfigFile is null == (options.ConfigString is null))
        {
            throw new ArgumentException(
                "Tdc needs exactly one of ConfigFile and ConfigString");
        }

        Source = options.ConfigString ?? File.ReadAllText(options.ConfigFile!);

        TdcParserFacade.Result parsed = TdcParserFacade.Parse(Source);
        if (!parsed.Ok)
        {
            // Thrown as diagnostics rather than as prose so that a caller can render the offending
            // line instead of only quoting the message.
            throw new TdcDiagnosticException(
                parsed.Problems
                    .Select(p => Diagnostic.Error("TDC001", p.Message, "", p.Line, p.Column))
                    .ToList(),
                Source);
        }

        _baseDir = options.BaseDir
            ?? (options.ConfigFile is not null
                ? Path.GetDirectoryName(Path.GetFullPath(options.ConfigFile))
                : null);

        // A pack directory named outright wins; otherwise the project's own tdcv2.config.json is
        // consulted, so a pack downloaded by any implementation is found by this one. Searched from
        // the CONFIG FILE's folder, not from the shell: a .tdc file belongs to the project it sits
        // in, and running it from one directory up must not quietly lose that project's packs.
        _packsDir = options.PacksDir;
        _dataPaths = options.DataPaths;
        _packs = PacksForWorker();

        // Validate before building. A config the reference refuses must be refused here too, or the
        // two implementations disagree about which configs are legal — which is a portability bug
        // even when every value either of them produces is right.
        Diagnostics = Validator.Validate(parsed.Tree, _baseDir, _packs);
        if (Diagnostic.HasErrors(Diagnostics))
        {
            throw new TdcDiagnosticException(Diagnostics, Source);
        }

        // The project config's `locale` is the fallback for a config that declares none — the same
        // file the packs came from, so a project that installed `ru` and wrote it down gets Russian
        // without repeating itself in every .tdc.
        _config = ConfigBuilder
            .Build(
                parsed.Tree,
                ProjectConfig.Load(_baseDir ?? Directory.GetCurrentDirectory()).Locale)
            .Override(options.Count, options.SeedValue, options.Locale)
            .WithEngineSelection(
                options.Engine?.ToString(CultureInfo.InvariantCulture), TrimToNull(options.Mode));

        // Nothing named a seed, so one is invented — and USED, which is the whole point. Leaving it
        // empty would make every seedless run produce the same bytes while SeedInfo reported a
        // random seed of "", advice that reproduces nothing. Randomness here is the reference's
        // behaviour: a seedless run is a different sample each time, and the seed reported beside it
        // is how you get that sample back. Shaped like the reference's String(Math.random()) so the
        // value looks the same whichever implementation printed it.
        _seedGenerated = _config.Seed.Length == 0;
        if (_seedGenerated)
        {
            _config = _config.Override(
                null, Random.Shared.NextDouble().ToString("R", CultureInfo.InvariantCulture), null);
        }

        // Read once, here, rather than per value: a run that straddled midnight would otherwise put
        // two different dates in one file from one "today".
        _nowMillis = options.NowMillis ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Generated once and kept: asking for text and then for rows must not run the generator
        // twice, which would be both slow and — with a generated seed — a different answer.
        _run = new Lazy<IRowSource>(
            () => Engines.Run(_config, _packs, _nowMillis, _baseDir),
            LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>
    /// The config text this run was built from.
    /// </summary>
    /// <remarks>
    /// Exposed because a diagnostic names a line, and showing that line is what makes the complaint
    /// act on rather than look up.
    /// </remarks>
    public string Source { get; }

    /// <summary>
    /// Anything the config was warned about but not refused for.
    /// </summary>
    /// <remarks>
    /// Errors are thrown from the constructor, so whatever is left here is worth saying and not
    /// worth stopping for.
    /// </remarks>
    public IReadOnlyList<Diagnostic> Diagnostics { get; }

    /// <summary>The number of records this run produces.</summary>
    public int Count => _config.Count;

    /// <summary>
    /// The seed in effect.
    /// </summary>
    /// <remarks>
    /// <c>Generated</c> is true when the config named no seed, in which case one was invented and
    /// this is the only record of it — worth logging, since re-running without it produces a
    /// different sample.
    /// </remarks>
    public Seed SeedInfo => new(_config.Seed, _seedGenerated);

    /// <summary>
    /// Which engine this config runs on: 1 in memory, 2 streaming, 3 exact on disk.
    /// </summary>
    /// <remarks>
    /// Worth exposing because it explains the run's memory profile, and because a config that asked
    /// for disk mode and got engine 1 back is being told something useful — it uses a feature that
    /// has to see the whole column.
    /// </remarks>
    public int Engine => EngineRouter.Resolve(_config, _packs);

    /// <summary>
    /// What this run is likely to cost in memory, or <c>null</c> when the answer is "not much".
    /// </summary>
    /// <remarks>
    /// <para>
    /// Worth asking before a large run rather than after: a config that will not fit says so in a
    /// millisecond here, and takes minutes to say so by thrashing. The estimate is deliberately
    /// crude — a cell is assumed to cost about forty bytes and a rendered record about two hundred —
    /// because the decision it informs is "is this the right order of magnitude", not "how many
    /// bytes exactly".
    /// </para>
    /// <para>
    /// It is measured against the machine's TOTAL memory rather than what the operating system calls
    /// free. Modern systems keep RAM busy with caches they hand back the moment a process asks for
    /// it, so the free figure reads far below what a run can actually have and would refuse jobs
    /// that run perfectly well. What bounds a run is what fits in physical memory before it thrashes.
    /// </para>
    /// </remarks>
    /// <param name="materialized">
    /// Whether the whole output will be held as one string, as <see cref="ToString"/> does. A run
    /// written straight to a file does not pay that.
    /// </param>
    public Diagnostic? Preflight(bool materialized = true)
    {
        // A streaming engine holds one row, not the run, so its cost does not grow with count.
        bool streaming = Engine != 1;
        long slots = 4; // _count, _first, _last, _total
        foreach (SequenceSpec spec in _config.Sequences)
        {
            slots += spec.IsCompound && spec.Fields is not null ? spec.Fields.Count : 1;
        }

        long cells = streaming ? slots : (long)_config.Count * slots;
        long estimated = cells * BytesPerCell;
        if (!streaming && materialized)
        {
            estimated += (long)_config.Count * BytesPerRenderedCard;
        }

        long total = TotalMemory();
        double ratio = total > 0 ? (double)estimated / total : double.PositiveInfinity;
        if (ratio < WarnRatio)
        {
            return null;
        }

        long estimatedMb = (estimated + (1024 * 1024) - 1) / (1024 * 1024);
        long totalMb = total / (1024 * 1024);
        return ratio >= ErrorRatio
            ? Diagnostic.Error(
                "TDC201",
                $"estimated memory need (~{estimatedMb} MB) exceeds this machine's RAM "
                + $"({totalMb} MB) — run will likely thrash or crash",
                "Reduce count, split the generation into smaller batches, or switch to disk mode "
                + "(mode=\"disk\") which is bounded-memory.",
                1,
                0)
            : Diagnostic.Warning(
                "TDC200",
                $"estimated memory need (~{estimatedMb} MB) is a large share of this machine's RAM "
                + $"({totalMb} MB) — may lean on swap and slow down",
                "This will still run; for very large datasets mode=\"disk\" keeps memory flat "
                + "regardless of count.",
                1,
                0);
    }

    /// <summary>The whole output as one string.</summary>
    public override string ToString() => _run.Value.Text();

    /// <summary>
    /// Write the output to a file, replacing whatever is there.
    /// </summary>
    /// <remarks>
    /// One thread, because a caller who did not ask for several should not silently get them. The
    /// overload below is where that is asked for.
    /// </remarks>
    public void WriteFile(string target) => WriteFile(target, 1);

    /// <summary>
    /// The same, across <paramref name="workers"/> threads.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Zero means "decide from the machine". The worker count never changes the bytes — a shard is
    /// a range of rows and every row is a function of its own number — so it is a speed knob and
    /// nothing else, unlike the engine, which has to be chosen from the config.
    /// </para>
    /// <para>
    /// It applies only to the streaming engine and only to a run big enough to pay for the threads;
    /// anything else writes on one thread, which is a slower answer and never a wrong one.
    /// </para>
    /// </remarks>
    public void WriteFile(string target, int workers)
    {
        bool canSplit = ParallelWrite.CanSplit(_config, _packs);
        int resolved = ParallelWrite.ResolveWorkers(
            workers <= 0 ? null : workers, canSplit, _config.Count);
        if (resolved <= 1)
        {
            using var writer = new StreamWriter(target, append: false);
            _run.Value.WriteTo(writer);
            return;
        }

        ParallelWrite.WriteFile(
            _config, PacksForWorker, _nowMillis, _baseDir, target, resolved, _config.Count);
    }

    /// <summary>The records one at a time, without building a list of them.</summary>
    public IEnumerable<Row> Rows()
    {
        IRowSource source = _run.Value;
        for (int i = 0; i < source.Count; i++)
        {
            yield return new Row(source, i);
        }
    }

    /// <summary>One record by position.</summary>
    public Row this[int index]
    {
        get
        {
            IRowSource source = _run.Value;
            if (index < 0 || index >= source.Count)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(index), $"row {index} is outside a run of {source.Count}");
            }

            return new Row(source, index);
        }
    }

    /// <summary>The declared sequences, in declaration order.</summary>
    public IReadOnlyList<string> SequenceNames => _run.Value.SequenceNames;

    private static string? TrimToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>This machine's RAM, or zero when the runtime will not say.</summary>
    /// <remarks>
    /// The garbage collector's own figure, which is the machine's physical memory — or the
    /// container's limit where there is one, which is the number that actually bounds the run.
    /// </remarks>
    private static long TotalMemory() => GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;

    /// <summary>A registry of its own for one worker, built from the inputs this run was given.</summary>
    private DataPacks PacksForWorker() =>
        _packsDir is not null
            ? new DataPacks(_packsDir)
            : DataPacks.ForProject(_baseDir ?? Directory.GetCurrentDirectory(), _dataPaths);
}
