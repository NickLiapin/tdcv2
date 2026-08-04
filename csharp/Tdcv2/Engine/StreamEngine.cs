using System.Globalization;
using System.Text;
using Tdcv2.Distribution;
using Tdcv2.Expr;
using Tdcv2.Format;
using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Prng;
using Tdcv2.Sequence;
using Tdcv2.Stats;

namespace Tdcv2.Engine;

/// <summary>
/// The streaming engine: a row is computed from its own index, and nothing else is kept.
/// </summary>
/// <remarks>
/// <para>
/// The in-memory engine materializes every column before writing a byte, so a run costs memory
/// proportional to its size. That is the right trade for a thousand rows and impossible for a
/// billion. Here each value is a function of the row number, so memory is proportional to the width
/// of one row and a file of any length costs the same.
/// </para>
/// <para>
/// Two things make that possible, and both live in <c>Prng</c>: draws keyed by
/// <c>seed | stream | index</c> instead of taken in order, and a permutation that can be evaluated at
/// one position. The second is what keeps an exact <c>percent=</c> exact — the quota is laid out and
/// then shuffled by a bijection nobody has to materialize. The same trick carries everything that
/// divides a column into shares: <c>&lt;mix&gt;</c>, weighted packs, weighted file columns,
/// <c>repeat=</c> lengths, and the length groups of a weighted number.
/// </para>
/// <para>
/// What this engine will not do, it refuses by name rather than approximating. A weighted choice
/// inside <c>advanced_regex</c>, a percent-weighted <c>uniq</c>, a template address that interpolates
/// a field: each needs the whole column at once, and answering from one row would produce data that
/// looks right and is not. Those configs belong to another engine, and the router sends them there.
/// </para>
/// </remarks>
public sealed class StreamEngine
{
    /// <summary>A column that answers per row. <c>null</c> means the row is outside a parent filter.</summary>
    public delegate string? Column(int row);

    /// <summary>What a column has to expose to be a parent: its values, quotas, and a child's rank.</summary>
    private interface IParentCapable
    {
        bool HasValue(string value);

        int QuotaOf(string value);

        /// <summary>The child's position among the rows this parent value selected, or <c>null</c>.</summary>
        int? ChildRankAt(int row, string value);
    }

    /// <summary>The rows a sequence applies to: how many, and where a given row sits among them.</summary>
    private readonly record struct Domain(int Size, Func<int, int?> PopIndexAt);

    /// <summary>One generator's contribution: its column, whether a child may filter on it, and its flag.</summary>
    private sealed record Built(
        Column Column, IParentCapable? Parent = null, string? FlagName = null, Column? Flag = null);

    /// <summary>Raised for a config this engine cannot answer row by row; the router picks another.</summary>
    /// <remarks>
    /// An <see cref="InvalidOperationException"/> on purpose. The router is supposed to keep such a
    /// config away from here, so reaching this point is an internal gap — but a gap must degrade to
    /// a message the caller can read, not to an unhandled exception that aborts the process with a
    /// stack dump. The command line already renders this exception type.
    /// <para>
    /// The message is carried verbatim. A prefix added here would reach the user only because of
    /// which package they installed, and would land on refusals that already word themselves fully
    /// — which is how one refusal came to read four ways across the five implementations.
    /// </para>
    /// </remarks>
    public sealed class UnsupportedHere : InvalidOperationException
    {
        internal UnsupportedHere(string message)
            : base(message)
        {
        }
    }

    /// <summary>The one refusal sentence, worded as the reference words it.</summary>
    private static UnsupportedHere Unsupported(string feature, string name) =>
        new(
            $"stream mode: {feature} (\"{name}\") is not supported yet — "
                + "run without mode=\"stream\" (the in-memory engine handles it), or remove it.");

    /// <summary>Types whose value is built here and whose modifiers therefore apply here too.</summary>
    private static readonly HashSet<string> InlineTypes = new(StringComparer.Ordinal)
    {
        "text", "increment", "decrement", "timeseries", "pattern",
    };

    /// <summary>
    /// How many redraws <c>&lt;distinct&gt;</c> gets before it gives up.
    /// </summary>
    /// <remarks>
    /// A fuse, not a tuning knob. Without one, three fields over a pool of two values would loop for
    /// as long as the run lasts and look like a hang rather than the impossible request it is.
    /// </remarks>
    private const int DistinctFuse = 64;

    /// <summary>Beyond this many combinations a uniq index no longer fits a double exactly.</summary>
    private readonly Config _config;
    private readonly DataPacks _packs;
    private readonly long _nowMillis;
    private readonly string? _baseDir;
    private readonly string _seed;
    private readonly int _count;
    private readonly Dictionary<string, Column> _columns = new(StringComparer.Ordinal);

    /// <summary>Every pool, computed before anything streams.</summary>
    private IReadOnlyDictionary<string, PoolTable> _poolTables =
        new Dictionary<string, PoolTable>(StringComparer.Ordinal);
    private readonly List<string> _order = new();
    private readonly Dictionary<string, IParentCapable> _parents = new(StringComparer.Ordinal);
    private readonly bool _exactUniq;

    private StreamEngine(
        Config config, DataPacks packs, long nowMillis, string? baseDir, bool exactUniq)
    {
        _exactUniq = exactUniq;
        _config = config;
        _packs = packs;
        _nowMillis = nowMillis;
        _baseDir = baseDir;
        _seed = config.Seed;
        _count = config.Count;
    }

    /// <summary>
    /// The run as addressable records, computed on demand.
    /// </summary>
    /// <remarks>
    /// Iterating this holds one row at a time, so a caller can walk a run far larger than memory and
    /// read the same values the in-memory engine would have given them.
    /// </remarks>
    public static IRowSource Rows(
        Config config, DataPacks packs, long nowMillis, string? baseDir) =>
        Rows(config, packs, nowMillis, baseDir, false);

    /// <summary>
    /// The same, with <paramref name="exactUniq"/> deciding how a <c>uniq="true"</c> sequence is
    /// built.
    /// </summary>
    /// <remarks>
    /// False gives uniform distinct combinations, which is all this engine can promise on its own.
    /// True builds each column to its exact quota instead and verifies the result on disk — what the
    /// exact engine asks for, and the one place the two differ.
    /// </remarks>
    internal static IRowSource Rows(
        Config config, DataPacks packs, long nowMillis, string? baseDir, bool exactUniq)
    {
        var engine = new StreamEngine(config, packs, nowMillis, baseDir, exactUniq);
        engine.BuildColumns();
        return new StreamRows(engine);
    }

    /// <summary>
    /// Render straight to a sink, one record at a time.
    /// </summary>
    /// <remarks>
    /// Nothing accumulates: the caller can hand this a file writer and the run's memory stays flat
    /// however many records it produces.
    /// </remarks>
    public static void Render(
        Config config, DataPacks packs, long nowMillis, string? baseDir, TextWriter output)
    {
        var engine = new StreamEngine(config, packs, nowMillis, baseDir, false);
        engine.BuildColumns();
        engine.Write(output, 0, engine._count);
    }

    /// <summary>
    /// The same, for rows <c>[from, to)</c> alone — one shard of a run being written in parallel.
    /// </summary>
    /// <remarks>
    /// Every draw is keyed by seed, stream and row index, so row nine million is a function of its
    /// own number and needs to know nothing about row eight million. That the shards join into
    /// exactly the bytes one thread would have written is a property of the writer, not of luck:
    /// the opening and closing fixtures belong to the shards holding the first and last row, and
    /// the between-blocks delimiter is keyed to the global row number.
    /// </remarks>
    public static void RenderRows(
        Config config,
        DataPacks packs,
        long nowMillis,
        string? baseDir,
        TextWriter output,
        int from,
        int to)
    {
        var engine = new StreamEngine(config, packs, nowMillis, baseDir, false);
        engine.BuildColumns();
        engine.Write(output, from, to);
    }

    private sealed class StreamRows : IRowSource
    {
        private readonly StreamEngine _engine;

        internal StreamRows(StreamEngine engine)
        {
            _engine = engine;
            SequenceNames = engine._order.Where(n => !n.StartsWith('_')).ToArray();
        }

        public int Count => _engine._count;

        public IReadOnlyList<string> SequenceNames { get; }

        public string? Value(string column, int row) => _engine.ValueAt(column, row);

        public string Text()
        {
            var writer = new StringWriter();
            _engine.Write(writer, 0, _engine._count);
            return writer.ToString();
        }

        public void WriteTo(TextWriter output) => _engine.Write(output, 0, _engine._count);
    }

    // ── columns ──────────────────────────────────────────────────────────────────────────────

    private void Put(string name, Column column)
    {
        if (!_columns.ContainsKey(name))
        {
            _order.Add(name);
        }

        _columns[name] = column;
    }

    /// <summary>
    /// A pool reference as LAZY columns.
    ///
    /// A pool is small and computed before the run starts, so it never threatens the streaming
    /// engines' bounded memory: what streams is the two thousand patients, not the thirty doctors.
    /// And because the member pick is seekable by row, row 900,000 gets its doctor without the
    /// 899,999 before it existing.
    /// </summary>
    private void BuildPoolReference(SequenceSpec spec)
    {
        string poolName = (spec.Gen!.Attr("value") ?? "").Trim();
        if (!_poolTables.TryGetValue(poolName, out PoolTable? table) || table.Count < 1)
        {
            return; // unknown pool — the validator reports it
        }

        string expression = (spec.Gen.Attr("filter") ?? "").Trim();
        (string Field, string Column)? equality = expression.Length == 0
            ? null
            : Pool.ParseEqualityFilter(expression, table, _columns.ContainsKey);
        Dictionary<string, List<int>>? buckets =
            equality is null ? null : Pool.BucketByField(table, equality.Value.Field);

        int MemberAt(int row)
        {
            if (expression.Length == 0)
            {
                return Pool.PickMember(_seed, spec.Name, table, row);
            }

            List<int> eligible;
            string detail = "";
            if (equality is not null && buckets is not null)
            {
                string wanted = _columns.TryGetValue(equality.Value.Column, out Column? driver)
                    ? driver(row) ?? ""
                    : "";
                eligible = buckets.TryGetValue(wanted, out List<int>? found) ? found : new List<int>();
                detail = $" ({equality.Value.Column}=\"{wanted}\")";
            }
            else
            {
                eligible = new List<int>();
                for (int m = 0; m < table.Count; m++)
                {
                    if (Evaluate.AsCondition(expression, new StreamMemberScope(this, table, m, row)))
                    {
                        eligible.Add(m);
                    }
                }
            }

            if (eligible.Count == 0)
            {
                throw new InvalidOperationException(
                    Pool.NoCandidateMessage(poolName, expression, row, detail));
            }

            return eligible[Seekable.NextInt(_seed, Pool.RefStream(spec.Name), row, eligible.Count)];
        }

        foreach (string field in table.Fields)
        {
            IReadOnlyList<string> column =
                table.Columns.TryGetValue(field, out IReadOnlyList<string>? c)
                    ? c
                    : Array.Empty<string>();
            Put(
                spec.Name + "." + field,
                row =>
                {
                    int m = MemberAt(row);
                    return m < column.Count ? column[m] : "";
                });
        }
    }

    /// <summary>
    /// A candidate member's fields first, then the row's columns.
    /// </summary>
    private sealed class StreamMemberScope : Evaluate.IScope
    {
        private readonly StreamEngine engine;
        private readonly PoolTable table;
        private readonly int member;
        private readonly int row;

        public StreamMemberScope(StreamEngine engine, PoolTable table, int member, int row)
        {
            this.engine = engine;
            this.table = table;
            this.member = member;
            this.row = row;
        }

        public bool Has(string name) =>
            this.Field(name) is not null || this.engine._columns.ContainsKey(name);

        public string Value(string name)
        {
            string? found = this.Field(name);
            if (found is not null)
            {
                return found;
            }

            return this.engine._columns.TryGetValue(name, out Column? column)
                ? column(this.row) ?? ""
                : "";
        }

        private string? Field(string name)
        {
            string prefix = this.table.Name + ".";
            string key = name.StartsWith(prefix, StringComparison.Ordinal)
                ? name.Substring(prefix.Length)
                : name;
            return this.table.Columns.TryGetValue(key, out IReadOnlyList<string>? column)
                ? (this.member < column.Count ? column[this.member] : "")
                : null;
        }
    }

    private void BuildColumns()
    {
        // Pools are computed before anything streams — small, and off a derived seed, so the
        // bounded-memory promise is untouched and no other column moves.
        _poolTables = MemoryEngine.BuildPoolTables(
            new MemoryEngine.Ctx(
                _config,
                _packs,
                _nowMillis,
                _baseDir,
                new Dictionary<string, MemoryEngine.RowLinkPlan>(StringComparer.Ordinal)));

        Put("_count", row => (row + 1).ToString(CultureInfo.InvariantCulture));
        Put("_first", row => row == 0 ? "true" : "false");
        Put("_last", row => row == _count - 1 ? "true" : "false");
        Put("_total", row => _count.ToString(CultureInfo.InvariantCulture));

        var byName = _config.Sequences.ToDictionary(s => s.Name, StringComparer.Ordinal);

        // An env-level <uniq> builds its members together — their values are digits of one index —
        // so they are done first and skipped in the loop below.
        var envUniqMembers = new HashSet<string>(StringComparer.Ordinal);
        foreach (IReadOnlyList<string> group in _config.EnvUniqGroups)
        {
            envUniqMembers.UnionWith(BuildEnvUniq(group, byName));
        }

        foreach (SequenceSpec spec in _config.Sequences)
        {
            if (envUniqMembers.Contains(spec.Name))
            {
                continue;
            }

            if (spec.Uniq)
            {
                BuildUniq(spec);
                continue;
            }

            // A reference to a <pool>. The table was computed before the run, so only the per-row
            // PICK happens here — and it is seekable, so it costs the streaming engines nothing.
            // A reference under a parent needs the parent's materialised column to know which rows
            // exist at all, so that one goes to the in-memory engine rather than being guessed at.
            // A running total is the one construct that genuinely cannot be answered from a
            // row index: row 900,000,000 IS the sum of everything before it. That is not a gap
            // in the streaming builder, it is what "running" means — so it is refused by name
            // and the router hands the config to the in-memory engine.
            if (spec.Gen is not null && spec.Gen.Type == "running")
            {
                throw new UnsupportedHere(
                    $"a running total (\"{spec.Name}\") is the accumulation of every row before "
                    + "it, so it cannot be computed one row at a time; the in-memory engine "
                    + "handles it (run without a forced streaming engine)");
            }

            if (spec.Gen is not null && spec.Gen.Type == "pool")
            {
                if (!string.IsNullOrWhiteSpace(spec.Parent))
                {
                    throw Unsupported("a pool reference with parent=", spec.Name);
                }

                BuildPoolReference(spec);
                continue;
            }

            if (spec.IsConditional)
            {
                BuildConditional(spec);
                continue;
            }

            if (spec.IsSwitch)
            {
                BuildSwitch(spec);
                continue;
            }

            if (spec.IsComputed)
            {
                // Derived from other columns and nothing else, so it resolves per row for free.
                SequenceSpec computed = spec;
                Put(
                    spec.Name,
                    row => Compute.Compute.Evaluate(
                        (TDCParser.OpenCloseElementContext)computed.Compute!,
                        Compute.Compute.FieldsOf(name => ValueAt(name, row))));
                continue;
            }

            if (spec.IsMix)
            {
                // "#switch" is what the reference keys a top-level mix by — the construct was named
                // that before it was named <mix>, and the stream id is part of the seed contract.
                Register(spec.Name, BuildMix(spec.Name + "#switch", spec.Mix!, DomainOf(spec)));
                continue;
            }

            if (spec.IsComposed)
            {
                BuildComposed(spec);
                continue;
            }

            if (spec.IsCompound)
            {
                BuildCompound(spec);
                continue;
            }

            Register(spec.Name, BuildGen(spec.Name, spec.Gen!, DomainOf(spec)));
        }

        foreach (IReadOnlyList<string> group in _config.EnvDistinctGroups)
        {
            ApplyEnvDistinct(group, byName);
        }
    }

    /// <summary>
    /// Env-level <c>&lt;uniq&gt;</c>: the tuple of several sequences is unique across the run.
    /// </summary>
    /// <remarks>
    /// Built exactly like a compound's <c>uniq</c>, only the digits live in separate sequences. The
    /// members cannot be drawn independently and then reconciled — that is the whole-column repair
    /// this engine exists to avoid — so they are built together from one index.
    /// </remarks>
    /// <returns>The names this took over, which the ordinary loop must then leave alone.</returns>
    private IReadOnlySet<string> BuildEnvUniq(
        IReadOnlyList<string> group, IReadOnlyDictionary<string, SequenceSpec> byName)
    {
        // As with a sequence's own `uniq`: a group rearranges finished columns, so it belongs to
        // the in-memory engine and both disk engines refuse rather than answer differently.
        throw Unsupported(
            "<uniq> across sequences (a whole-column rearrangement)",
            string.Join(" × ", group));
    }

    /// <summary>
    /// Env-level <c>&lt;distinct&gt;</c>: the named sequences differ from each other on every row.
    /// </summary>
    /// <remarks>
    /// Layered over the columns already built rather than folded into them, because the constraint is
    /// between sequences that are otherwise independent. A collision redraws on a fresh stream, in a
    /// fixed order, so every implementation repairs the same row the same way.
    /// </remarks>
    private void ApplyEnvDistinct(
        IReadOnlyList<string> group, IReadOnlyDictionary<string, SequenceSpec> byName)
    {
        var members = new List<string>();
        var genByName = new Dictionary<string, Gen>(StringComparer.Ordinal);
        foreach (string name in group)
        {
            if (!byName.TryGetValue(name, out SequenceSpec? member) || !_columns.ContainsKey(name))
            {
                continue;
            }

            if (member.IsMix)
            {
                throw Unsupported($"<distinct> member \"{name}\" is a <mix>", name);
            }

            if (member.IsSwitch)
            {
                throw Unsupported($"<distinct> member \"{name}\" is a <switch>", name);
            }

            if (member.Gen is null)
            {
                throw Unsupported($"<distinct> member \"{name}\" (must be a simple sequence)", name);
            }

            members.Add(name);
            genByName[name] = member.Gen;
        }

        if (members.Count < 2)
        {
            return;
        }

        var baseColumns = members.ToDictionary(n => n, n => _columns[n], StringComparer.Ordinal);

        var repair = new RowRepair(row =>
        {
            var values = members.ToDictionary(
                n => n, n => baseColumns[n](row), StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string name in members)
            {
                string? value = values[name];
                if (value is null)
                {
                    // An inactive row, filtered out by its parent.
                    continue;
                }

                int attempt = 0;
                while (seen.Contains(value))
                {
                    attempt++;
                    if (attempt > DistinctFuse)
                    {
                        throw new InvalidOperationException(
                            "stream mode: <distinct> across sequences: could not find a value for "
                            + $"sequence \"{name}\" different from the others after {DistinctFuse} "
                            + "attempts — its source likely has too few distinct values.");
                    }

                    value = First(
                        GenValues(
                            genByName[name],
                            Seekable.Generator(_seed, name + "#ed" + attempt, row), null));
                }

                values[name] = value;
                seen.Add(value);
            }

            return values;
        });

        foreach (string name in members)
        {
            string captured = name;
            Put(name, row => repair.At(row).GetValueOrDefault(captured));
        }
    }

    private void Register(string name, Built built)
    {
        Put(name, built.Column);
        if (built.Parent is not null)
        {
            _parents[name] = built.Parent;
        }

        if (built.FlagName is not null && built.Flag is not null)
        {
            Put(built.FlagName, built.Flag);
        }
    }

    /// <summary>
    /// A composed sequence: the body in declaration order, each part on a stream of its own.
    /// </summary>
    /// <remarks>
    /// Parts are numbered among the UNNAMED ones (<c>#p0</c>, <c>#p1</c>, …), so adding a literal
    /// between two gens moves nothing. A row outside the parent's filter has no value in any part,
    /// and the composed cell is absent rather than a string of bare literals.
    /// </remarks>
    private void BuildComposed(SequenceSpec spec)
    {
        Domain domain = DomainOf(spec);
        var parts = new List<object>();
        int unnamed = 0;

        // A named field that draws, read only when no unnamed part does. It answers the one
        // question the literals cannot — whether this row is inside the parent's filter — so the
        // ordinary path costs nothing.
        Column? witness = null;

        foreach (Item item in spec.Items!)
        {
            if (item.ConstantName is not null)
            {
                string constant = item.Text ?? "";
                Put(
                    spec.Name + "." + item.ConstantName,
                    row => domain.PopIndexAt(row) is null ? null : constant);
                continue;
            }

            if (item.Text is not null)
            {
                parts.Add(item.Text);
                continue;
            }

            if (item.Field is not null)
            {
                string fieldId = spec.Name + "." + item.Field.Name;
                Column field = BuildGen(fieldId, item.Field.Gen, domain).Column;
                Put(fieldId, field);
                witness ??= field;
                continue;
            }

            parts.Add(BuildGen($"{spec.Name}#p{unnamed++}", item.Gen!, domain).Column);
        }

        if (!MemoryEngine.ComposesOwnValue(spec.Items!))
        {
            return;
        }

        int drawn = unnamed;
        Column? applicable = witness;
        Put(spec.Name, row =>
        {
            var text = new StringBuilder();
            bool active = false;
            foreach (object part in parts)
            {
                if (part is string literal)
                {
                    text.Append(literal);
                    continue;
                }

                string? value = ((Column)part)(row);
                if (value is null)
                {
                    continue;
                }

                active = true;
                text.Append(value);
            }

            if (drawn > 0)
            {
                return active ? text.ToString() : null;
            }

            // Nothing unnamed draws here, so the value is the literals alone — constant, but still
            // absent on a row this sequence does not apply to. A named field draws for exactly
            // those rows and is asked instead.
            return applicable is not null && applicable(row) is null ? null : text.ToString();
        });
    }

    private void BuildCompound(SequenceSpec spec)
    {
        Domain domain = DomainOf(spec);
        var fields = new Dictionary<string, Column>(StringComparer.Ordinal);
        foreach (Field field in spec.Fields!)
        {
            // A field's column only: the fields of a compound are parts of one thing, and a
            // `parent=` or an `anomaly_flag=` pointing at one is not something the reference offers.
            Built built = BuildGen(spec.Name + "." + field.Name, field.Gen, domain);
            Put(spec.Name + "." + field.Name, built.Column);
            fields[field.Name] = built.Column;
        }

        ApplyDistinct(spec, fields);
    }

    /// <summary>
    /// The rows a sequence covers.
    /// </summary>
    /// <remarks>
    /// A child of <c>parent="Gender.Male"</c> exists only on the male rows, and its own draws are
    /// numbered within that subset — otherwise the values it produces would depend on how many rows
    /// the parent happened to give it, which is not knowable one row at a time.
    /// </remarks>
    private Domain DomainOf(SequenceSpec spec)
    {
        string? reference = TrimToNull(spec.Parent);
        if (reference is null)
        {
            return new Domain(_count, row => row);
        }

        int dot = reference.IndexOf('.');
        if (dot < 0)
        {
            throw Unsupported($"bare parent=\"{reference}\" (use parent=\"Name.Value\")", spec.Name);
        }

        string parentName = reference[..dot];
        string parentValue = reference[(dot + 1)..];

        if (!_parents.TryGetValue(parentName, out IParentCapable? parent))
        {
            throw Unsupported(
                $"parent \"{parentName}\" (the parent must be a finite-value <sequence> declared earlier)",
                spec.Name);
        }

        if (!parent.HasValue(parentValue))
        {
            throw new InvalidOperationException(
                $"sequence \"{spec.Name}\" filters on parent value \"{reference}\", which the "
                + "parent never produces.");
        }

        return new Domain(
            parent.QuotaOf(parentValue), row => parent.ChildRankAt(row, parentValue));
    }

    // ── one generator ────────────────────────────────────────────────────────────────────────

    private Built BuildGen(string streamId, Gen gen, Domain domain)
    {
        IReadOnlyDictionary<string, string> attrs = gen.Attrs;
        string type = gen.Type;

        if (type == "advanced_regex"
            && AdvancedRegexGen.HasWeightedChoice(attrs.GetValueOrDefault("value", "")))
        {
            // Its shares are exact over a whole column; a per-row draw would send every row to the
            // largest branch and look plausible doing it.
            throw Unsupported("advanced_regex weighted choice \"(?%{…})\"", streamId);
        }

        if (type == "http")
        {
            // A network call is not a draw: neither reproducible from a row index nor
            // answerable synchronously, which is what a lazy per-row resolver needs.
            throw new UnsupportedHere(
                $"<gen type=\"http\"> (\"{streamId}\") is a network call, so it is neither reproducible nor answerable one row at a time; the in-memory engine handles it (run without a forced streaming engine)");
        }

        if (type == "template" && attrs.GetValueOrDefault("value", "").Contains("${{"))
        {
            throw new UnsupportedHere(
                $"template value \"{attrs.GetValueOrDefault("value", "")}\" interpolates a field; "
                + "the in-memory engine resolves it per row");
        }

        // An empty subset — a parent value with no rows of its own. Always inactive.
        if (domain.Size == 0)
        {
            return new Built(_ => null);
        }

        string? weightColumn = type == "file" ? TrimToNull(attrs.GetValueOrDefault("weight")) : null;
        if (weightColumn is not null && TrimToNull(attrs.GetValueOrDefault("row")) is not null)
        {
            throw new UnsupportedHere(
                "weight= combined with row= needs an exact quota over the whole file; the in-memory "
                + "engine handles it (run without a forced streaming engine)");
        }

        FileGen.Weighted? weightedPack = WeightedTemplatePack(gen);

        Repeat.Spec? repeat = Repeat.Parse(attrs);
        Modifier? mod = ModifierFor(streamId, attrs, repeat is { } rs ? rs.Max : 1);

        // The lengths of a repeating cell are themselves an exact quota, planned before any value
        // exists so a row's slice follows from its own position rather than from its predecessors.
        RepeatPlan? repeatPlan = repeat is { } spec2
            ? PlanRepeat(spec2, domain.Size, streamId)
            : null;
        int repeatKey = Permute.Key(_seed, streamId + "#replen");
        Func<int, int?> repeatPosAt = row =>
        {
            int? r = domain.PopIndexAt(row);
            return r is null ? null : Permute.Apply(r.Value, domain.Size, repeatKey);
        };

        // order="sequential": row r takes element r mod N. Index-based, so it needs no draw.
        if ((type == "text" || type == "file")
            && attrs.GetValueOrDefault("order") == "sequential"
            && weightColumn is null)
        {
            IReadOnlyList<string> list = type == "file"
                ? FileGen.Load(attrs, _baseDir, _packs.DataRoots)
                : MemoryEngine.SplitText(attrs.GetValueOrDefault("value", ""));
            bool cycle = attrs.GetValueOrDefault("cycle") != "false";
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                return r is null ? null : MemoryEngine.PickSequential(list, r.Value, cycle);
            }));
        }

        if (type is "increment" or "decrement")
        {
            long start = LongAttr(attrs.GetValueOrDefault("value"), 0);
            long step = LongAttr(attrs.GetValueOrDefault("step"), 1);
            bool up = type == "increment";
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                return r is null
                    ? null
                    : (up ? start + (step * r.Value) : start - (step * r.Value))
                        .ToString(CultureInfo.InvariantCulture);
            }));
        }

        if (type == "timeseries")
        {
            Timeseries.Spec spec = Timeseries.Parse(attrs);
            bool noisy = spec.HasNoise;
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                if (r is null)
                {
                    return null;
                }

                double z = 0;
                if (noisy)
                {
                    double[] u = Seekable.Uniforms(_seed, streamId + ":ts", row, 2);
                    z = Timeseries.StandardNormal(u[0], u[1]);
                }

                return Stats.Distribution.ToFixed(
                    Timeseries.ValueAt(spec, r.Value, z), spec.Decimals);
            }));
        }

        if (type == "pattern")
        {
            Pattern.PatternGen drawing =
                Pattern.PatternGen.Of(attrs, _baseDir, _packs.DataRoots);
            double denom = domain.Size > 1 ? domain.Size - 1 : 1;
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                if (r is null)
                {
                    return null;
                }

                double u = drawing.Draws
                    ? Seekable.Uniforms(_seed, streamId + ":pat", row, 1)[0]
                    : 0;
                return drawing.ValueAt(r.Value / denom, u, 1 / denom);
            }));
        }

        // A row-linked file: every field on the key must land on the same record for a given row,
        // and a different one per row. The in-memory engine plans that for the whole column; here
        // the index is re-derived from a stream keyed by the LINK, so the fields agree without one.
        if (type == "file" && weightColumn is null
            && TrimToNull(attrs.GetValueOrDefault("row")) is { } rowKey)
        {
            FileGen.RowSource source = FileGen.LoadRows(attrs, _baseDir, _packs.DataRoots);
            string linkStream = "filerowlink|" + rowKey;
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                if (r is null)
                {
                    return null;
                }

                int index = Seekable.NextInt(_seed, linkStream, row, source.Rows.Count);
                return FileGen.CellAt(source, index);
            }));
        }

        // An exact quota: text, a weighted file column, or a weighted pack. All three say what
        // share of the run each value takes, and all three honour it the same way.
        if (type == "text" || weightColumn is not null || weightedPack is not null)
        {
            IReadOnlyList<string> values;
            double[] percents;
            if (weightColumn is not null)
            {
                FileGen.Weighted weighted =
                    FileGen.LoadWeighted(attrs, _baseDir, _packs.DataRoots)!;
                values = weighted.Values;
                percents = weighted.Percents;
            }
            else if (weightedPack is not null)
            {
                values = weightedPack.Values;
                percents = weightedPack.Percents;
            }
            else
            {
                values = MemoryEngine.SplitText(attrs.GetValueOrDefault("value", ""));
                string? percentAttr = attrs.GetValueOrDefault("percent");
                percents = !string.IsNullOrEmpty(percentAttr)
                    ? PercentMask.Expand(percentAttr, values.Count)
                    : Evenly(values.Count);
            }

            return QuotaColumn(
                streamId, values, percents, domain, repeat, repeatPlan, repeatPosAt, mod);
        }

        // `length="2,10-12" percent="85,15"`: which length group a row gets is an exact quota over
        // the column, so it cannot come from the row's own draw — an apportionment over a single
        // cell always awards it to the largest share, turning 85/15 into 100/0. Plan the groups,
        // map the row into one, and let the digits still come from its own seekable draw.
        IReadOnlyList<NumberGen.LengthChoice>? lengthChoices =
            NumberGen.WeightedLengthChoices(attrs);
        if (lengthChoices is not null)
        {
            double[] percents =
                PercentMask.Expand(attrs.GetValueOrDefault("percent", ""), lengthChoices.Count);
            int[] cumHi = Cumulative(
                Hamilton.CountsPerValue(
                    domain.Size, percents, Prng.Prng.Create(_seed + "|" + streamId + "|lenpct")));
            int key = Permute.Key(_seed, streamId + "#lenpct");
            return new Built(Wrap(mod, row =>
            {
                int? r = domain.PopIndexAt(row);
                if (r is null)
                {
                    return null;
                }

                NumberGen.LengthChoice group =
                    lengthChoices[RunFor(cumHi, Permute.Apply(r.Value, domain.Size, key))];
                var pinned = new Gen(type, NumberGen.PinLength(attrs, group));
                return First(GenValues(pinned, Seekable.Generator(_seed, streamId, row), null));
            }));
        }

        // With `repeat`, each element of the cell is an independent draw on a stream of its own, so
        // the cell is reproducible without the row ever knowing what its neighbours produced.
        if (repeat is { } r2)
        {
            var single = new Gen(type, Repeat.Without(attrs));
            RepeatPlan plan = repeatPlan!;
            Column column = row =>
            {
                int? p = repeatPosAt(row);
                if (p is null)
                {
                    return null;
                }

                var parts = new List<string>();
                for (int k = 0; k < plan.LengthAt(p.Value); k++)
                {
                    parts.Add(First(
                        GenValues(
                            single, Seekable.Generator(_seed, streamId + "#e" + k, row), null)));
                }

                return Repeat.Join(parts, r2);
            };

            string? repeatFlag = TrimToNull(attrs.GetValueOrDefault("anomaly_flag"));
            if (repeatFlag is null || Imperfections.ParseAnomaly(attrs) is null)
            {
                return new Built(column);
            }

            // With `repeat` the flag is a LIST parallel to the values: one boolean could not say
            // which element of the batch was the one that spiked.
            return new Built(column, null, repeatFlag, row =>
            {
                int? p = repeatPosAt(row);
                if (p is null)
                {
                    return null;
                }

                var flags = new List<string>();
                for (int k = 0; k < plan.LengthAt(p.Value); k++)
                {
                    var spiked = new bool[1];
                    GenValues(single, Seekable.Generator(_seed, streamId + "#e" + k, row), spiked);
                    flags.Add(spiked[0] ? "true" : "false");
                }

                return string.Join(r2.Separator, flags);
            });
        }

        // Everything else draws independently, from a generator private to the row. Those types
        // apply their own modifiers inside, so this path must not wrap them again.
        Column plain = row =>
        {
            int? r = domain.PopIndexAt(row);
            return r is null
                ? null
                : First(GenValues(gen, Seekable.Generator(_seed, streamId, row), null));
        };
        return new Built(plain, null, AnomalyFlagName(attrs), AnomalyFlagColumn(streamId, gen, domain));
    }

    /// <summary>The companion column named by <c>anomaly_flag=</c>, or <c>null</c> when there is none.</summary>
    private static string? AnomalyFlagName(IReadOnlyDictionary<string, string> attrs) =>
        Imperfections.ParseAnomaly(attrs) is null
            ? null
            : TrimToNull(attrs.GetValueOrDefault("anomaly_flag"));

    /// <summary>
    /// The flag that marks which rows were spiked.
    /// </summary>
    /// <remarks>
    /// It has to agree with the value on every row, so it is decided exactly the way the value's own
    /// outlier was: the seekable draw for the types built here, and a re-run of the row's own build
    /// for the types that draw independently. Deciding it any other way would give a flag that is
    /// right on average and wrong per row, which is worse than no flag at all.
    /// </remarks>
    private Column? AnomalyFlagColumn(string streamId, Gen gen, Domain domain)
    {
        Imperfections.Anomaly? anomaly = Imperfections.ParseAnomaly(gen.Attrs);
        if (anomaly is null || TrimToNull(gen.Attrs.GetValueOrDefault("anomaly_flag")) is null)
        {
            return null;
        }

        bool inline = InlineTypes.Contains(gen.Type);
        double p = anomaly.Value.Probability;
        return row =>
        {
            if (domain.PopIndexAt(row) is null)
            {
                return null;
            }

            if (inline)
            {
                return Seekable.Uniforms(_seed, streamId + "#anom", row, 1)[0] < p
                    ? "true" : "false";
            }

            var spiked = new bool[1];
            GenValues(gen, Seekable.Generator(_seed, streamId, row), spiked);
            return spiked[0] ? "true" : "false";
        };
    }

    /// <summary>
    /// One row's worth of an independently-drawn generator.
    /// </summary>
    /// <remarks>
    /// The values and the modifiers come off the same generator, in that order, because that is the
    /// order the in-memory engine takes them in. Splitting them across two streams would give a
    /// different column for the same seed, which is the one thing neither engine may do.
    /// </remarks>
    private IReadOnlyList<string> GenValues(Gen gen, Sfc32 prng, bool[]? flagsOut)
    {
        var ctx = new MemoryEngine.Ctx(
            _config, _packs, _nowMillis, _baseDir,
            new Dictionary<string, MemoryEngine.RowLinkPlan>(StringComparer.Ordinal));

        Repeat.Spec? repeat = Repeat.Parse(gen.Attrs);
        if (repeat is null)
        {
            return MemoryEngine.Finish(
                MemoryEngine.Generate(gen, 1, prng, ctx), gen.Attrs, prng,
                flagsOut ?? new bool[1]);
        }

        return Repeat.Build(
            repeat.Value, 1, prng,
            slots => MemoryEngine.Finish(
                MemoryEngine.Generate(gen, slots, prng, ctx), gen.Attrs, prng, new bool[slots]));
    }

    /// <summary>A <c>&lt;gen type="template"&gt;</c> pointing at a pack that carries its own shares.</summary>
    private FileGen.Weighted? WeightedTemplatePack(Gen gen)
    {
        if (gen.Type != "template")
        {
            return null;
        }

        string address = gen.Attrs.GetValueOrDefault("value", "");
        string? locale = LocaleOf(gen.Attrs);

        // A synthetic address (person.b_day and its kind) is resolved inside the generator and has
        // no pack file behind it, so asking the registry for it would throw rather than answer.
        if (address.Length == 0 || !_packs.Exists(address, locale))
        {
            return null;
        }

        DataPacks.Entry entry = _packs.Load(address, locale);
        return entry.Weighted ? new FileGen.Weighted(entry.Values, entry.Percents!) : null;
    }

    /// <summary>
    /// A column whose values are apportioned exactly, resolved one row at a time.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The counts are computed once — the same apportionment the in-memory engine uses — and laid out
    /// as contiguous runs of slots. A row asks the permutation which slot it owns and looks up the
    /// run that contains it. No row needs to know about any other, and the totals still come out
    /// exactly as declared.
    /// </para>
    /// <para>
    /// With <c>repeat=</c> the quota is planned over ELEMENTS rather than rows, because a row holding
    /// three values consumes three of them.
    /// </para>
    /// </remarks>
    private Built QuotaColumn(
        string streamId, IReadOnlyList<string> values, double[] percents, Domain domain,
        Repeat.Spec? repeat, RepeatPlan? repeatPlan, Func<int, int?> repeatPosAt, Modifier? mod)
    {
        int slotCount = repeatPlan?.TotalSlots ?? domain.Size;
        int[] counts = Hamilton.CountsPerValue(
            slotCount, percents, Prng.Prng.Create(_seed + "|" + streamId + "|pct"));
        int[] cumHi = Cumulative(counts);
        int key = Permute.Key(_seed, streamId);

        // The slot a row's k-th element owns, or null when the row is filtered out.
        int? SlotAt(int row, int k)
        {
            if (repeatPlan is null)
            {
                int? r = domain.PopIndexAt(row);
                return r is null ? null : Permute.Apply(r.Value, slotCount, key);
            }

            int? p = repeatPosAt(row);
            return p is null
                ? null
                : Permute.Apply(repeatPlan.SlotStartAt(p.Value) + k, slotCount, key);
        }

        Column column;
        if (repeat is { } r2)
        {
            column = row =>
            {
                int? p = repeatPosAt(row);
                if (p is null)
                {
                    return null;
                }

                var parts = new List<string>();
                for (int k = 0; k < repeatPlan!.LengthAt(p.Value); k++)
                {
                    int? slot = SlotAt(row, k);
                    string raw = slot is null ? "" : values[RunFor(cumHi, slot.Value)];
                    parts.Add(mod is null ? raw : NullToEmpty(mod(row, raw, k)));
                }

                return Repeat.Join(parts, r2);
            };
        }
        else
        {
            column = Wrap(mod, row =>
            {
                int? slot = SlotAt(row, 0);
                return slot is null ? null : values[RunFor(cumHi, slot.Value)];
            });
        }

        // A finite set of values with known quotas is exactly what a child can filter on — unless
        // the cell holds a LIST, in which case parent="Name.value" has nothing coherent to match.
        bool repeating = repeat is not null;
        var parent = new QuotaParent(values, counts, cumHi, repeating, SlotAt);
        return new Built(column, parent, null, null);
    }

    private sealed class QuotaParent : IParentCapable
    {
        private readonly IReadOnlyList<string> _values;
        private readonly int[] _counts;
        private readonly int[] _cumHi;
        private readonly bool _repeating;
        private readonly Func<int, int, int?> _slotAt;

        internal QuotaParent(
            IReadOnlyList<string> values, int[] counts, int[] cumHi, bool repeating,
            Func<int, int, int?> slotAt)
        {
            _values = values;
            _counts = counts;
            _cumHi = cumHi;
            _repeating = repeating;
            _slotAt = slotAt;
        }

        public bool HasValue(string value) => !_repeating && _values.Contains(value);

        public int QuotaOf(string value)
        {
            int i = IndexOf(value);
            return i < 0 ? 0 : _counts[i];
        }

        public int? ChildRankAt(int row, string value)
        {
            int? slot = _slotAt(row, 0);
            int i = IndexOf(value);
            if (slot is null || i < 0)
            {
                return null;
            }

            int lo = i == 0 ? 0 : _cumHi[i - 1];
            // Its rank inside the run is its position among the rows that share this value.
            return slot.Value >= lo && slot.Value < _cumHi[i] ? slot.Value - lo : null;
        }

        private int IndexOf(string value)
        {
            for (int i = 0; i < _values.Count; i++)
            {
                if (_values[i] == value)
                {
                    return i;
                }
            }

            return -1;
        }
    }

    // ── mix, switch, conditional ─────────────────────────────────────────────────────────────

    /// <summary>
    /// <c>&lt;mix&gt;</c>: several ways to build one value, in stated proportions.
    /// </summary>
    /// <remarks>
    /// The same shape as a weighted text column — the shares are apportioned over the run and the
    /// row's slot decides its case — with one addition: each case gets a domain of its own, so a
    /// generator inside it is numbered within the rows that chose that case. Without that, two cases
    /// drawing from the same pack would take the same values in the same order.
    /// </remarks>
    private Built BuildMix(string streamId, Mix mix, Domain domain)
    {
        IReadOnlyList<Case> cases = mix.Cases;
        string? flagName = TrimToNull(mix.Flag);

        if (domain.Size == 0 || cases.Count == 0)
        {
            Column empty = row => domain.PopIndexAt(row) is null ? null : "";
            Column flag = row => domain.PopIndexAt(row) is null ? null : "false";
            return new Built(empty, null, flagName, flagName is null ? null : flag);
        }

        double[] percents = !string.IsNullOrEmpty(mix.Percent)
            ? PercentMask.Expand(mix.Percent, cases.Count)
            : Evenly(cases.Count);
        int[] counts = Hamilton.CountsPerValue(
            domain.Size, percents, Prng.Prng.Create(_seed + "|" + streamId + "|pct"));
        int[] cumHi = Cumulative(counts);
        int key = Permute.Key(_seed, streamId);

        int? SlotAt(int row)
        {
            int? r = domain.PopIndexAt(row);
            return r is null ? null : Permute.Apply(r.Value, domain.Size, key);
        }

        var resolvers = new List<Func<int, string>>();
        for (int c = 0; c < cases.Count; c++)
        {
            int index = c;
            int lo = index == 0 ? 0 : cumHi[index - 1];
            var caseDomain = new Domain(
                counts[index],
                row =>
                {
                    int? slot = SlotAt(row);
                    return slot is not null && slot >= lo && slot < cumHi[index]
                        ? slot - lo
                        : null;
                });
            resolvers.Add(CaseResolver(cases[c], streamId + "#c" + c, caseDomain));
        }

        Column column = row =>
        {
            int? slot = SlotAt(row);
            return slot is null ? null : resolvers[RunFor(cumHi, slot.Value)](row);
        };

        if (flagName is null)
        {
            return new Built(column);
        }

        return new Built(column, null, flagName, row =>
        {
            int? slot = SlotAt(row);
            return slot is null
                ? null
                : cases[RunFor(cumHi, slot.Value)].Anomaly ? "true" : "false";
        });
    }

    /// <summary>A case body assembled from its pieces: literal text, a generator, or a nested mix.</summary>
    private Func<int, string> CaseResolver(Case caseSpec, string streamId, Domain domain)
    {
        var parts = new List<Column>();
        for (int p = 0; p < caseSpec.Parts.Count; p++)
        {
            CasePart part = caseSpec.Parts[p];
            if (part.Text is not null)
            {
                string text = part.Text;
                parts.Add(_ => text);
            }
            else if (part.Gen is not null)
            {
                parts.Add(BuildGen(streamId + "#p" + p, part.Gen, domain).Column);
            }
            else
            {
                // A nested mix contributes its value only; `flag=` is a top-level idea.
                parts.Add(BuildMix(streamId + "#p" + p, part.Mix!, domain).Column);
            }
        }

        return row =>
        {
            var result = new StringBuilder();
            foreach (Column part in parts)
            {
                result.Append(NullToEmpty(part(row)));
            }

            return result.ToString();
        };
    }

    private void BuildConditional(SequenceSpec spec)
    {
        // Over every row, and without the parent mask — matching the reference. A conditional
        // already says which rows it applies to through its own conditions.
        var full = new Domain(_count, row => row);
        var branches = new List<Column>();
        for (int b = 0; b < spec.Branches!.Count; b++)
        {
            branches.Add(BuildGen(spec.Name + "#if" + b, spec.Branches[b].Gen, full).Column);
        }

        Put(spec.Name, row =>
        {
            for (int b = 0; b < spec.Branches.Count; b++)
            {
                string? condition = spec.Branches[b].IfExpr;
                if (condition is null || Condition(condition, row))
                {
                    return branches[b](row);
                }
            }

            return null;
        });
    }

    /// <summary>The rows that chose one branch, numbered within themselves, or <c>null</c>.</summary>
    /// <remarks>
    /// Every branch used to get the whole run, which made a <c>&lt;mix percent="20,80"&gt;</c>
    /// inside <c>&lt;case is="Male"&gt;</c> apportion its 20% over ALL the rows; the ones that
    /// landed on female rows were then discarded. The subset was never out of reach — a branch of
    /// <c>&lt;switch on="Gender"&gt;</c> keyed <c>Male</c> wants exactly the domain
    /// <c>parent="Gender.Male"</c> already gets.
    /// <para>
    /// One key only. A multi-key entry (<c>US|CA|MX</c>) is the union of subsets, and ranks across
    /// a union do not compose from the per-value ranks — the interleaving is what decides them.
    /// Refused rather than approximated.
    /// </para>
    /// </remarks>
    private Domain? BranchDomain(string on, IReadOnlyList<string> keys)
    {
        if (keys.Count != 1)
        {
            return null;
        }

        string key = keys[0];
        if (!_parents.TryGetValue(on, out IParentCapable? parent) || !parent.HasValue(key))
        {
            return null;
        }

        return new Domain(parent.QuotaOf(key), row => parent.ChildRankAt(row, key));
    }

    /// <summary>Does this branch declare a share that the domain has to be right for?</summary>
    private static bool CarriesPercent(Case? body) =>
        body is not null && body.Parts.Any(part =>
            (part.Mix is not null && !string.IsNullOrWhiteSpace(part.Mix.Percent))
            || (part.Gen is not null
                && !string.IsNullOrWhiteSpace(part.Gen.Attr("percent"))));

    private void BuildSwitch(SequenceSpec spec)
    {
        Switch sw = spec.SwitchSpec!;
        var full = new Domain(_count, row => row);
        var entries = new List<Func<int, string>>();
        for (int e = 0; e < sw.Entries.Count; e++)
        {
            SwitchEntry entry = sw.Entries[e];
            Domain? domain = BranchDomain(sw.On, entry.Keys);
            if (domain is null && CarriesPercent(entry.Value))
            {
                // Cannot be resolved lazily over the right subset, and resolving it over the
                // wrong one is what this change exists to stop. Refuse, and the run falls back
                // to the in-memory engine, which can.
                throw Unsupported(
                    $"a percentage inside <case is=\"{string.Join("|", entry.Keys)}\"> of "
                    + $"<switch on=\"{sw.On}\">",
                    spec.Name);
            }

            entries.Add(CaseResolver(entry.Value, spec.Name + "#sw" + e, domain ?? full));
        }

        if (CarriesPercent(sw.Fallback))
        {
            // <default> holds the rows no entry matched — a complement, which IParentCapable
            // does not enumerate. Same refusal, same fallback.
            throw Unsupported(
                $"a percentage inside <default> of <switch on=\"{sw.On}\">", spec.Name);
        }

        Func<int, string>? fallback = sw.Fallback is null
            ? null
            : CaseResolver(sw.Fallback, spec.Name + "#swdef", full);

        Put(spec.Name, row =>
        {
            string key = NullToEmpty(ValueAt(sw.On, row));
            for (int e = 0; e < sw.Entries.Count; e++)
            {
                if (sw.Entries[e].Keys.Contains(key))
                {
                    return entries[e](row);
                }
            }

            return fallback?.Invoke(row);
        });
    }

    // ── distinct ─────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// <c>&lt;distinct&gt;</c>: fields of one record that must not repeat each other.
    /// </summary>
    /// <remarks>
    /// Two independent draws from the same pool collide about as often as chance says they should,
    /// which reads as a bug in a record where a person cannot be their own manager. The repair is per
    /// row and needs nothing else: a colliding field redraws on a fresh stream until it differs, and
    /// every implementation redraws in the same order on the same streams.
    /// </remarks>
    private void ApplyDistinct(SequenceSpec spec, IReadOnlyDictionary<string, Column> fields)
    {
        if (spec.DistinctGroups is null)
        {
            return;
        }

        var groups = new List<List<string>>();
        foreach (IReadOnlyList<string> group in spec.DistinctGroups)
        {
            List<string> present = group.Where(fields.ContainsKey).ToList();
            if (present.Count >= 2)
            {
                groups.Add(present);
            }
        }

        if (groups.Count == 0)
        {
            return;
        }

        var genByField = spec.Fields!.ToDictionary(f => f.Name, f => f.Gen, StringComparer.Ordinal);

        // One row's repair, remembered: the fields of a row are asked for one after another, so a
        // single-entry memo turns N lookups into one repair rather than N.
        var repair = new RowRepair(row =>
        {
            var values = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, Column> entry in fields)
            {
                values[entry.Key] = entry.Value(row);
            }

            foreach (List<string> group in groups)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (string fieldName in group)
                {
                    string? value = values[fieldName];
                    if (value is null)
                    {
                        // An inactive row, filtered out by its parent.
                        continue;
                    }

                    Gen? gen = genByField.GetValueOrDefault(fieldName);
                    int attempt = 0;
                    while (seen.Contains(value) && gen is not null)
                    {
                        attempt++;
                        if (attempt > DistinctFuse)
                        {
                            throw new InvalidOperationException(
                                $"stream mode: <distinct> in sequence \"{spec.Name}\": could not "
                                + $"find a value for field \"{fieldName}\" different from the "
                                + $"others after {DistinctFuse} attempts — its source likely has "
                                + "too few distinct values.");
                        }

                        string key = spec.Name + "." + fieldName + "#d" + attempt;
                        value = First(GenValues(gen, Seekable.Generator(_seed, key, row), null));
                    }

                    values[fieldName] = value;
                    seen.Add(value);
                }
            }

            return values;
        });

        foreach (string fieldName in groups.SelectMany(g => g).Distinct(StringComparer.Ordinal))
        {
            string captured = fieldName;
            Put(spec.Name + "." + fieldName, row => repair.At(row).GetValueOrDefault(captured));
        }
    }

    /// <summary>One row's repaired values, kept for as long as that row is the one being asked about.</summary>
    private sealed class RowRepair
    {
        private readonly Func<int, Dictionary<string, string?>> _compute;
        private int _cachedRow = -1;
        private Dictionary<string, string?> _cached = new(StringComparer.Ordinal);

        internal RowRepair(Func<int, Dictionary<string, string?>> compute) => _compute = compute;

        internal Dictionary<string, string?> At(int row)
        {
            if (row != _cachedRow)
            {
                _cached = _compute(row);
                _cachedRow = row;
            }

            return _cached;
        }
    }

    // ── uniq ─────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// <c>uniq="true"</c>: no two records share the same combination.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The in-memory engine draws and then repairs collisions, which needs to see every row. Here the
    /// combination space is treated as a number instead: the fields are the digits of a mixed-radix
    /// counter, and the permutation turns row <c>i</c> into a distinct index in it. No two rows can
    /// collide because no two indices can, and nothing has to be remembered.
    /// </para>
    /// <para>
    /// The price is that the combinations come out uniform. Exact percentages and uniqueness at the
    /// same time need the whole column, so a percent-weighted uniq is refused here rather than
    /// quietly delivered as an even split.
    /// </para>
    /// </remarks>
    private void BuildUniq(SequenceSpec spec)
    {
        if (!_exactUniq)
        {
            // A group REARRANGES whole columns so each keeps its multiset — a promise about the
            // finished column, which no engine can keep a row at a time. This one could only
            // offer something else (a mixed-radix bijection over the combination space, uniform
            // over combinations, ignoring the values actually drawn), and one seed would then
            // mean two datasets. It says so instead. The router sends every uniq to the exact
            // engine; this is the backstop for a forced one.
            throw Unsupported("uniq (a whole-column rearrangement)", spec.Name);
        }

        if (!spec.IsCompound || spec.Fields!.Count == 0)
        {
            throw Unsupported("uniq on a simple sequence (a whole-column draw)", spec.Name);
        }

        if (TrimToNull(spec.Parent) is not null)
        {
            throw Unsupported("uniq combined with a parent", spec.Name);
        }

        BuildExactUniq(spec);
    }

    /// <summary>
    /// The exact-engine version: each column built to its declared shares, then verified distinct.
    /// </summary>
    /// <remarks>
    /// Where the streaming version trades exact percentages for uniqueness, this one keeps both — at
    /// the cost of a pass over the run to check, and a repair when the check finds collisions. See
    /// <see cref="ExactUniq"/> for why that stays affordable.
    /// </remarks>
    private void BuildExactUniq(SequenceSpec spec)
    {
        var fields = new List<ExactUniq.Field>();
        foreach (Field field in spec.Fields!)
        {
            Gen gen = field.Gen;
            if (gen.Type != "text")
            {
                throw Unsupported(
                    $"uniq field \"{field.Name}\" of type \"{gen.Type}\" (only text lists)",
                    spec.Name);
            }

            List<string> values = MemoryEngine
                .SplitText(gen.Attrs.GetValueOrDefault("value", ""))
                .Distinct(StringComparer.Ordinal)
                .ToList();
            if (values.Count == 0)
            {
                throw Unsupported(
                    $"uniq field \"{field.Name}\" with an empty value list",
                    spec.Name);
            }

            string? percentAttr = gen.Attrs.GetValueOrDefault("percent");
            double[] percents = !string.IsNullOrEmpty(percentAttr)
                ? PercentMask.Expand(percentAttr, values.Count)
                : Evenly(values.Count);
            fields.Add(new ExactUniq.Field(spec.Name + "." + field.Name, values, percents));
        }

        IReadOnlyDictionary<string, ExactUniq.Resolver> built = ExactUniq.Arrange(
            fields, _count, _seed, $"\"{spec.Name}\"", _baseDir ?? Path.GetTempPath());
        foreach (KeyValuePair<string, ExactUniq.Resolver> entry in built)
        {
            ExactUniq.Resolver resolver = entry.Value;
            Put(entry.Key, row => resolver(row));
        }
    }

    // ── repeat planning ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Where each row's values sit in one flat run of slots.
    /// </summary>
    /// <remarks>
    /// The lengths are an exact quota decided before any value exists, so a row's slice follows from
    /// its own position rather than from a running total over the rows before it. That is what lets
    /// this engine answer row nine million without having built the first eight.
    /// </remarks>
    private sealed class RepeatPlan
    {
        private readonly Repeat.Spec _spec;
        private readonly int[] _rowCumLo;
        private readonly int[] _slotOffset;

        internal RepeatPlan(Repeat.Spec spec, int totalSlots, int[] rowCumLo, int[] slotOffset)
        {
            _spec = spec;
            TotalSlots = totalSlots;
            _rowCumLo = rowCumLo;
            _slotOffset = slotOffset;
        }

        internal int TotalSlots { get; }

        /// <summary>How many values the row at permuted position <c>p</c> keeps.</summary>
        internal int LengthAt(int p) => _spec.Min + GroupOf(p);

        /// <summary>The first slot the row at permuted position <c>p</c> owns.</summary>
        internal int SlotStartAt(int p)
        {
            int j = GroupOf(p);
            return _slotOffset[j] + ((p - _rowCumLo[j]) * (_spec.Min + j));
        }

        private int GroupOf(int p)
        {
            int lo = 0;
            int hi = _rowCumLo.Length - 1;
            while (lo < hi)
            {
                int mid = (int)(((uint)(lo + hi + 1)) >> 1);
                if (p >= _rowCumLo[mid])
                {
                    lo = mid;
                }
                else
                {
                    hi = mid - 1;
                }
            }

            return lo;
        }
    }

    private RepeatPlan PlanRepeat(Repeat.Spec spec, int rowCount, string streamId)
    {
        int groups = spec.Max - spec.Min + 1;
        var percents = new double[groups];
        Array.Fill(percents, 100.0 / groups);
        int[] counts = Hamilton.CountsPerValue(
            rowCount, percents, Prng.Prng.Create(_seed + "|" + streamId + "|replen"));

        var rowCumLo = new int[groups];
        var slotOffset = new int[groups];
        int rowAcc = 0;
        int slotAcc = 0;
        for (int j = 0; j < groups; j++)
        {
            rowCumLo[j] = rowAcc;
            slotOffset[j] = slotAcc;
            int c = j < counts.Length ? counts[j] : 0;
            rowAcc += c;
            slotAcc += c * (spec.Min + j);
        }

        return new RepeatPlan(spec, slotAcc, rowCumLo, slotOffset);
    }

    // ── writing ──────────────────────────────────────────────────────────────────────────────

    private void Write(TextWriter output, int from, int to)
    {
        Fixtures fx = _config.Fixtures;
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo = EachInfo();

        if (from == 0)
        {
            Emit(output, fx.Before, 0);
        }

        for (int row = from; row < to; row++)
        {
            Emit(output, fx.BeforeBlock, row);

            var active = new List<Line>();
            foreach (Line line in _config.Block)
            {
                if (line.IfExpr is null || Condition(line.IfExpr, row))
                {
                    active.Add(line);
                }
            }

            for (int i = 0; i < active.Count; i++)
            {
                Emit(output, fx.BeforeLine, row);
                output.Write(RenderLine(active[i], row, eachInfo));
                Emit(output, fx.AfterLine, row);
                if (i < active.Count - 1)
                {
                    Emit(output, fx.DelimiterLine, row);
                }
            }

            Emit(output, fx.AfterBlock, row);
            if (row < _count - 1)
            {
                Emit(output, fx.DelimiterBlock, row);
            }
        }

        if (to == _count)
        {
            Emit(output, fx.After, _count - 1);
        }
    }

    private IReadOnlyDictionary<string, Repeat.Spec> EachInfo()
    {
        var result = new Dictionary<string, Repeat.Spec>(StringComparer.Ordinal);
        foreach (SequenceSpec spec in _config.Sequences)
        {
            if (spec.Gen is not null && Repeat.Parse(spec.Gen.Attrs) is { } repeat)
            {
                result[spec.Name] = repeat;
            }
        }

        return result;
    }

    private void Emit(TextWriter output, IReadOnlyList<Line> lines, int row)
    {
        var none = new Dictionary<string, Repeat.Spec>(StringComparer.Ordinal);
        foreach (Line line in lines)
        {
            output.Write(RenderLine(line, row, none));
        }
    }

    private string RenderLine(
        Line line, int row, IReadOnlyDictionary<string, Repeat.Spec> eachInfo)
    {
        var text = new StringBuilder();
        foreach (DataPart part in line.Parts)
        {
            if (part.IfExpr is null || Condition(part.IfExpr, row))
            {
                text.Append(part.Text);
            }
        }

        string template = text.ToString();
        string? listName = TrimToNull(line.Each);
        if (listName is null)
        {
            return Interpolate.Apply(template, _config.Inject, new StreamLookup(this, row)) + "\n";
        }

        Repeat.Spec? spec = eachInfo.TryGetValue(listName, out Repeat.Spec found) ? found : null;
        IReadOnlyList<string> elements = Repeat.Split(
            NullToEmpty(ValueAt(listName, row)), spec?.Separator ?? Repeat.DefaultSeparator);

        int lane = 0;
        int stride = 0;
        foreach (KeyValuePair<string, Repeat.Spec> entry in eachInfo)
        {
            if (entry.Key == listName)
            {
                lane = stride;
            }

            stride += entry.Value.Max;
        }

        if (stride == 0)
        {
            stride = elements.Count;
        }

        var result = new StringBuilder();
        for (int k = 0; k < elements.Count; k++)
        {
            result
                .Append(Interpolate.Apply(
                    template, _config.Inject,
                    new StreamElementLookup(
                        this, row, listName, elements[k], k + 1, lane, stride)))
                .Append('\n');
        }

        return result.ToString();
    }

    // ── row access ───────────────────────────────────────────────────────────────────────────

    private string? ValueAt(string name, int row) =>
        _columns.TryGetValue(name, out Column? column) ? column(row) : null;

    private sealed class StreamLookup : Interpolate.ILookup
    {
        private readonly StreamEngine _engine;
        private readonly int _row;

        internal StreamLookup(StreamEngine engine, int row)
        {
            _engine = engine;
            _row = row;
        }

        public bool Has(string name) => _engine._columns.ContainsKey(name);

        public string Value(string name) => NullToEmpty(_engine.ValueAt(name, _row));
    }

    private sealed class StreamElementLookup : Interpolate.ILookup
    {
        private readonly StreamLookup _base;
        private readonly Dictionary<string, string> _overlay;

        internal StreamElementLookup(
            StreamEngine engine, int row, string listName, string element, int position, int lane,
            int stride)
        {
            _base = new StreamLookup(engine, row);
            _overlay = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [listName] = element,
                ["_item"] = position.ToString(CultureInfo.InvariantCulture),
                ["_item_id"] = Repeat.ItemKey(row + 1, position, lane, stride)
                    .ToString(CultureInfo.InvariantCulture),
            };
        }

        public bool Has(string name) => _overlay.ContainsKey(name) || _base.Has(name);

        public string Value(string name) =>
            _overlay.TryGetValue(name, out string? v) ? v : _base.Value(name);
    }

    private bool Condition(string expression, int row) =>
        Evaluate.AsCondition(expression, new StreamScope(this, row));

    private sealed class StreamScope : Evaluate.IScope
    {
        private readonly StreamEngine _engine;
        private readonly int _row;

        internal StreamScope(StreamEngine engine, int row)
        {
            _engine = engine;
            _row = row;
        }

        public bool Has(string name) => _engine._columns.ContainsKey(name);

        public string Value(string name) => NullToEmpty(_engine.ValueAt(name, _row));
    }

    // ── modifiers ────────────────────────────────────────────────────────────────────────────

    /// <summary>The per-row passes an inline-built value still needs: outliers, blanks, formatting.</summary>
    private delegate string? Modifier(int row, string? value, int element);

    private Modifier? ModifierFor(
        string streamId, IReadOnlyDictionary<string, string> attrs, int elementDraws)
    {
        Imperfections.Anomaly? anomaly = Imperfections.ParseAnomaly(attrs);
        Imperfections.Missing? missing = Imperfections.ParseMissing(attrs);
        bool hasAnomaly = anomaly is { Probability: > 0 };
        bool hasMissing = missing is { Probability: > 0 };
        string? mask = attrs.GetValueOrDefault("mask");
        string? caseName = attrs.GetValueOrDefault("case");
        bool hasFormat = mask is not null
            || (caseName is not null && Transforms.IsCaseTransform(caseName));

        if (!hasAnomaly && !hasMissing && !hasFormat)
        {
            return null;
        }

        return (row, value, element) =>
        {
            if (value is null)
            {
                return null;
            }

            string result = value;
            // Each modifier draws on a stream of its own, so adding one never disturbs the values.
            // With `repeat` a row needs one draw per element, so the row's draws are pulled at once
            // and indexed — asking for one draw and asking for the first of many give the same
            // number.
            if (hasAnomaly
                && Seekable.Uniforms(_seed, streamId + "#anom", row, elementDraws)[element]
                    < anomaly!.Value.Probability)
            {
                result = Imperfections.Spike(result, anomaly.Value.Factor);
            }

            if (hasMissing
                && Seekable.Uniforms(_seed, streamId + "#miss", row, elementDraws)[element]
                    < missing!.Value.Probability)
            {
                result = missing.Value.Token;
            }

            if (mask is not null)
            {
                result = Mask.Apply(mask, result);
            }

            if (caseName is not null && Transforms.IsCaseTransform(caseName))
            {
                result = Transforms.ApplyCase(caseName, result);
            }

            return result;
        };
    }

    private static Column Wrap(Modifier? mod, Column column) =>
        mod is null ? column : row => mod(row, column(row), 0);

    // ── small helpers ────────────────────────────────────────────────────────────────────────

    /// <summary>Which run of the cumulative bounds holds this slot — binary search, for wide columns.</summary>
    private static int RunFor(int[] cumHi, int slot)
    {
        int lo = 0;
        int hi = cumHi.Length - 1;
        while (lo < hi)
        {
            int mid = (int)(((uint)(lo + hi)) >> 1);
            if (slot < cumHi[mid])
            {
                hi = mid;
            }
            else
            {
                lo = mid + 1;
            }
        }

        return lo;
    }

    private static int[] Cumulative(int[] counts)
    {
        var result = new int[counts.Length];
        int acc = 0;
        for (int i = 0; i < counts.Length; i++)
        {
            acc += counts[i];
            result[i] = acc;
        }

        return result;
    }

    private string? LocaleOf(IReadOnlyDictionary<string, string> attrs)
    {
        string? local = attrs.GetValueOrDefault("local");
        return string.IsNullOrWhiteSpace(local) ? _config.Locale : local;
    }

    private static double[] Evenly(int n)
    {
        var result = new double[n];
        Array.Fill(result, 100.0 / n);
        return result;
    }

    private static string First(IReadOnlyList<string> values) =>
        values.Count == 0 ? "" : values[0];

    private static long LongAttr(string? raw, long fallback) =>
        string.IsNullOrWhiteSpace(raw)
            ? fallback
            : long.Parse(raw.Trim(), CultureInfo.InvariantCulture);

    private static string NullToEmpty(string? value) => value ?? "";

    private static string? TrimToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
