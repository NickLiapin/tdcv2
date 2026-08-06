using System.Globalization;
using System.Text;
using Tdcv2.Date;
using Tdcv2.Distribution;
using Tdcv2.Expr;
// `Tdcv2.Distribution` is the namespace apportionment lives in and `Distribution` is the class of
// named statistical distributions. Both names are right where they are; the alias keeps the two
// apart at this one call site rather than renaming either to avoid a collision.
using Distributions = Tdcv2.Stats.Distribution;
using Tdcv2.Format;
using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Parser;
using Tdcv2.Prng;
using Tdcv2.Sequence;

namespace Tdcv2.Engine;

/// <summary>
/// The in-memory engine: every column materialised, then the block rendered row by row.
/// </summary>
/// <remarks>
/// <para>
/// One generator walks from the start of the seed, column by column in declaration order. That
/// order is the whole contract — a column drawing one value more or fewer than the reference
/// shifts every column after it, so the output is either identical or wrong, never nearly right.
/// </para>
/// <para>
/// What this port does not handle yet REFUSES rather than approximates. Compounds, conditionals,
/// mixes, switches, computes, parents, uniq and distinct all change what a column contains; a
/// port that ignored one would produce a plausible column that answers a different question,
/// which is the failure this project is built to prevent. <see cref="NotSupportedException"/> is
/// the honest answer until each is ported.
/// </para>
/// </remarks>
public static class MemoryEngine
{
    /// <summary>
    /// What every generator needs beyond its own attributes: the document it belongs to and the
    /// packs it may read.
    /// </summary>
    /// <remarks>
    /// One object rather than two more parameters on six signatures. Both travel together
    /// everywhere and neither means anything without the other.
    /// </remarks>
    internal readonly record struct Ctx(
        Config Config, DataPacks Packs, long NowMillis, string? BaseDir,
        Dictionary<string, RowLinkPlan> RowLinks,
        // The columns built so far. A `<switch>` inside a `<case>` is not a column itself and
        // never reaches the registry, so it reads its subject through this instead.
        Dictionary<string, string[]>? Columns = null)
    {
        internal int RegexMax => Config.RegexMaxLength;

        internal string? Locale => Config.Locale;
    }

    public static string Render(Config config) => Render(config, null, null, null);

    /// <summary>
    /// The same, reading packs and files from where the caller names and against a clock it pins.
    /// </summary>
    /// <remarks>
    /// The clock is a parameter because <c>value="today"</c> reads it, and a test that could not fix
    /// it would pass today and fail tomorrow. <paramref name="baseDir"/> is the config file's own
    /// folder, which is what a relative <c>src=</c> is relative to — not the process's working
    /// directory, or the same config would work from one shell and fail from another.
    /// </remarks>
    public static string Render(
        Config config, DataPacks? packs, long? nowMillis = null, string? baseDir = null) =>
        Run(config, packs, nowMillis, baseDir).Text();

    /// <summary>
    /// The same run, as something a caller can read rows out of as well as text.
    /// </summary>
    /// <remarks>
    /// Both views read the very same generated values, so the two can never disagree. The row view
    /// ignores <c>&lt;block&gt;</c> and the wrappers entirely — those describe a file format, and a
    /// row has no format.
    /// </remarks>
    public static IRowSource Run(
        Config config, DataPacks? packs, long? nowMillis = null, string? baseDir = null)
    {
        IReadOnlyDictionary<string, string[]> columns = BuildColumns(new Ctx(
            config,
            packs ?? DataPacks.Discover(),
            nowMillis ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            baseDir,
            // Shared across the whole render: two sequences naming one row key must land on the
            // same rows, whichever of them reaches the key first.
            new Dictionary<string, RowLinkPlan>(StringComparer.Ordinal)));

        return new MaterializedRows(config, columns);
    }

    /// <summary>Every column already built; text is rendered on demand from those same values.</summary>
    private sealed class MaterializedRows : IRowSource
    {
        private readonly Config _config;
        private readonly IReadOnlyDictionary<string, string[]> _columns;

        internal MaterializedRows(Config config, IReadOnlyDictionary<string, string[]> columns)
        {
            _config = config;
            _columns = columns;
            SequenceNames = columns.Keys
                .Where(name => !name.StartsWith('_'))
                .ToArray();
        }

        public int Count => _config.Count;

        public IReadOnlyList<string> SequenceNames { get; }

        public string? Value(string column, int row) =>
            _columns.TryGetValue(column, out string[]? values) && row >= 0 && row < values.Length
                ? values[row]
                : null;

        public string Text() => Emit(_config, _columns);

        public void WriteTo(TextWriter output) => output.Write(Text());
    }

    private static string Emit(
        Config config, IReadOnlyDictionary<string, string[]> columns)
    {
        Fixtures fx = config.Fixtures;
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo = EachInfo(config);
        var result = new StringBuilder();

        Emit(result, eachInfo, fx.Before, columns, 0, config.Inject);
        for (int row = 0; row < config.Count; row++)
        {
            Emit(result, eachInfo, fx.BeforeBlock, columns, row, config.Inject);

            // Drop the suppressed lines first. A delimiter belongs between the lines that
            // survive, so deciding that up front is what keeps a separator off the last one.
            var active = new List<Line>();
            foreach (Line line in config.Block)
            {
                if (line.IfExpr is null || Condition(line.IfExpr, columns, row))
                {
                    active.Add(line);
                }
            }

            for (int i = 0; i < active.Count; i++)
            {
                Emit(result, eachInfo, fx.BeforeLine, columns, row, config.Inject);
                result.Append(RenderLine(active[i], columns, row, config.Inject, eachInfo));
                Emit(result, eachInfo, fx.AfterLine, columns, row, config.Inject);
                if (i < active.Count - 1)
                {
                    Emit(result, eachInfo, fx.DelimiterLine, columns, row, config.Inject);
                }
            }

            Emit(result, eachInfo, fx.AfterBlock, columns, row, config.Inject);
            if (row < config.Count - 1)
            {
                Emit(result, eachInfo, fx.DelimiterBlock, columns, row, config.Inject);
            }
        }

        Emit(result, eachInfo, fx.After, columns, Math.Max(0, config.Count - 1), config.Inject);
        return result.ToString();
    }

    /// <summary>
    /// Compute every <c>&lt;pool&gt;</c> declared in the config, once, before any row exists.
    ///
    /// A pool is built by the ORDINARY column machinery with <c>Count</c> set to the member count
    /// instead of the row count — which is the whole reason a <c>&lt;uniq&gt;</c>, a
    /// <c>&lt;mix&gt;</c>, an <c>if=</c> or a <c>parent=</c> inside a pool behaves exactly as it
    /// does outside one, with nothing here to make it so.
    /// </summary>
    /// <summary>
    /// Publish a running total.
    ///
    /// Reads its source out of the columns rather than drawing anything: a running total
    /// consumes no randomness at all, which is why adding one leaves every other column
    /// exactly where it was.
    /// </summary>
    private static void RunningColumn(
        SequenceSpec spec, Dictionary<string, string?[]> columns, int count)
    {
        IReadOnlyDictionary<string, string> attrs = spec.Gen!.Attrs;
        string of = (attrs.GetValueOrDefault("of") ?? "").Trim();
        string? op = Accumulate.Read(attrs);
        if (op is null || !columns.TryGetValue(of, out string?[]? source))
        {
            return; // the validator reports both
        }

        string resetName = (attrs.GetValueOrDefault("reset") ?? "").Trim();
        string?[]? resetAt = resetName.Length == 0
            ? null
            : columns.GetValueOrDefault(resetName);
        string baseText = (attrs.GetValueOrDefault("base") ?? "").Trim();
        columns[spec.Name] = Accumulate.ApplyColumn(
            source.Take(count).ToArray(), op, baseText.Length == 0 ? null : baseText, resetAt);
    }

    /// <summary>
    /// Publish a statistic over the whole run: ONE value, on every row.
    /// </summary>
    /// <remarks>
    /// Reads its source out of the columns rather than drawing anything, exactly as a running
    /// total does — which is why adding one leaves every other column where it was.
    /// </remarks>
    private static void StatColumn(
        SequenceSpec spec, Dictionary<string, string?[]> columns, int count)
    {
        IReadOnlyDictionary<string, string> attrs = spec.Gen!.Attrs;
        string of = (attrs.GetValueOrDefault("of") ?? "").Trim();
        string? op = Stat.ReadOp(attrs);
        if (op is null || !columns.TryGetValue(of, out string?[]? source))
        {
            return; // the validator reports both
        }

        int? decimals;
        try
        {
            decimals = Stat.ParseDecimals(attrs);
        }
        catch (StatException)
        {
            return; // a bad decimals= is a diagnostic, not a crash
        }

        string answer = Stat.Statistic(source.Take(count).ToArray(), op, decimals);
        var column = new string?[count];
        Array.Fill(column, answer);
        columns[spec.Name] = column;
    }

    internal static IReadOnlyDictionary<string, PoolTable> BuildPoolTables(Ctx ctx)
    {
        var tables = new Dictionary<string, PoolTable>(StringComparer.Ordinal);
        foreach (PoolSpec spec in ctx.Config.Pools)
        {
            if (string.IsNullOrEmpty(spec.Name) || spec.Count < 1)
            {
                continue; // the validator already said so
            }

            var inner = new Config(
                spec.Count,
                Pool.PoolSeed(ctx.Config.Seed, spec.Name),
                ctx.Config.Locale,
                ctx.Config.Inject,
                ctx.Config.RegexMaxLength,
                spec.Sequences,
                ctx.Config.Block,
                ctx.Config.Fixtures,
                ctx.Config.Mode,
                ctx.Config.Engine,
                spec.UniqGroups,
                spec.DistinctGroups);
            // The pools already built — so a MEMBER can reference one, exactly as a row does.
            // Declaration order is the whole cycle check: a pool sees only the pools above it.
            IReadOnlyDictionary<string, string[]> built = BuildColumns(
                new Ctx(
                    inner,
                    ctx.Packs,
                    ctx.NowMillis,
                    ctx.BaseDir,
                    new Dictionary<string, RowLinkPlan>(StringComparer.Ordinal)),
                tables);

            var fields = new List<string>();
            var columns = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            foreach (SequenceSpec member in spec.Sequences)
            {
                // A member that references another pool publishes ONLY `name.field` — a record
                // has no value of its own — which is why the dotted keys are matched here too.
                foreach (KeyValuePair<string, string[]> pair in built)
                {
                    if (pair.Key != member.Name
                        && !pair.Key.StartsWith(member.Name + ".", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    fields.Add(pair.Key);
                    columns[pair.Key] = pair.Value.Select(v => v ?? "").ToArray();
                }
            }

            tables[spec.Name] = new PoolTable(spec.Name, spec.Count, fields, columns);
        }

        return tables;
    }

    /// <summary>
    /// Publish one member of a pool per row, under <c>Ref.field</c> for every field it has.
    ///
    /// One pick per ROW, shared by every field: that is what makes the first name and the last
    /// name in a row belong to the same doctor. Not one pick per field, which is exactly how
    /// "Дмитрий Иванова" would get out.
    /// </summary>
    private static void PoolReference(
        SequenceSpec spec,
        Dictionary<string, string[]> columns,
        bool[] mask,
        int count,
        IReadOnlyDictionary<string, PoolTable> tables,
        string seed)
    {
        string poolName = (spec.Gen!.Attr("value") ?? "").Trim();
        if (!tables.TryGetValue(poolName, out PoolTable? table) || table.Count < 1)
        {
            return; // unknown pool — the validator reports it
        }

        string expression = (spec.Gen.Attr("filter") ?? "").Trim();
        (string Field, string Column)? equality = expression.Length == 0
            ? null
            : Pool.ParseEqualityFilter(expression, table, columns.ContainsKey);
        Dictionary<string, List<int>>? buckets =
            equality is null ? null : Pool.BucketByField(table, equality.Value.Field);

        var members = new int[count];
        for (int row = 0; row < count; row++)
        {
            if (!mask[row])
            {
                members[row] = -1;
                continue;
            }

            if (expression.Length == 0)
            {
                members[row] = Pool.PickMember(seed, spec.Name, table, row);
                continue;
            }

            List<int> eligible;
            string detail = "";
            if (equality is not null && buckets is not null)
            {
                string wanted = columns.TryGetValue(equality.Value.Column, out string[]? driver)
                    ? driver[row] ?? ""
                    : "";
                eligible = buckets.TryGetValue(wanted, out List<int>? found)
                    ? found
                    : new List<int>();
                detail = $" ({equality.Value.Column}=\"{wanted}\")";
            }
            else
            {
                eligible = new List<int>();
                for (int m = 0; m < table.Count; m++)
                {
                    if (Evaluate.AsCondition(expression, new MemberScope(columns, table, m, row)))
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

            int slot = Seekable.NextInt(
                seed, Pool.RefStream(spec.Name), row, eligible.Count);
            members[row] = eligible[slot];
        }

        foreach (string field in table.Fields)
        {
            IReadOnlyList<string> column =
                table.Columns.TryGetValue(field, out IReadOnlyList<string>? c)
                    ? c
                    : Array.Empty<string>();
            var values = new string[count];
            for (int row = 0; row < count; row++)
            {
                int m = members[row];
                values[row] = m < 0 ? null! : (m < column.Count ? column[m] : "");
            }

            columns[spec.Name + "." + field] = values;
        }
    }

    /// <summary>
    /// A candidate member's fields first, then the row's columns.
    ///
    /// A qualified <c>Pool.field</c> always means the member's field. A name that is both a field
    /// and a column is refused by the validator, so this never has to guess.
    /// </summary>
    private sealed class MemberScope : Evaluate.IScope
    {
        private readonly Dictionary<string, string[]> columns;
        private readonly PoolTable table;
        private readonly int member;
        private readonly int row;

        public MemberScope(
            Dictionary<string, string[]> columns,
            PoolTable table,
            int member,
            int row)
        {
            this.columns = columns;
            this.table = table;
            this.member = member;
            this.row = row;
        }

        public bool Has(string name) => Field(name) is not null || this.columns.ContainsKey(name);

        public string Value(string name)
        {
            string? found = this.Field(name);
            if (found is not null)
            {
                return found;
            }

            return this.columns.TryGetValue(name, out string[]? column)
                ? column[this.row] ?? ""
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

    private static IReadOnlyDictionary<string, string[]> BuildColumns(Ctx ctx) =>
        BuildColumns(ctx, null);

    /// <summary>
    /// The same, with the pools already built handed in — which is how a POOL body is
    /// materialised, so that one of its members can draw from a pool declared above it.
    /// </summary>
    private static IReadOnlyDictionary<string, string[]> BuildColumns(
        Ctx ctx, IReadOnlyDictionary<string, PoolTable>? prebuilt)
    {
        Config config = ctx.Config;
        int count = config.Count;
        var columns = new Dictionary<string, string[]>();
        // Handed to every builder below, so a nested <switch> can look its subject up. The
        // dictionary is filled as the loop runs and read only when a row is resolved, by which
        // time the subject — declared earlier, as the validator insists — is in it.
        ctx = ctx with { Columns = columns };

        // Built-ins first. They are positional, consume no randomness, and are therefore
        // identical for a given count no matter what else the config does.
        var counts = new string[count];
        var first = new string[count];
        var last = new string[count];
        var total = new string[count];
        for (int i = 0; i < count; i++)
        {
            counts[i] = (i + 1).ToString(CultureInfo.InvariantCulture);
            first[i] = i == 0 ? "true" : "false";
            last[i] = i == count - 1 ? "true" : "false";
            total[i] = count.ToString(CultureInfo.InvariantCulture);
        }

        columns["_count"] = counts;
        columns["_first"] = first;
        columns["_last"] = last;
        columns["_total"] = total;

        Sfc32 prng = Prng.Prng.Create(config.Seed);

        // Pools first, and off a DERIVED seed. A pool must be invisible to every column it does
        // not feed: adding one leaves the ids, the ages and the names exactly where they were, so
        // an old snapshot still matches.
        IReadOnlyDictionary<string, PoolTable> tables = prebuilt ?? BuildPoolTables(ctx);

        // What each finished column's exact layout gave each row, by column name. A child that
        // filters on one of them is ordered by its RANK there, not by row order.
        var layouts = new Dictionary<string, PerRow.ExactLayout>(StringComparer.Ordinal);

        foreach (SequenceSpec spec in config.Sequences)
        {
            bool[] mask = ParentMask(spec, columns, count);

            // In the order the column BUILDS them, which for a child is its rank inside the
            // parent's exact layout rather than plain row order.
            List<int> rows = PerRow.OrderedRows(spec.Parent, mask, layouts);
            int applicable = rows.Count;
            PerRow.Stream Named(string id) => new(config.Seed, id, rows);

            // A reference to a <pool>: this row gets one member, and every field of that member
            // is published under `Ref.field`. Resolved HERE, in declaration order, so a later
            // `<switch on="Doc.city">` finds the field already registered.
            if (spec.Gen is not null && spec.Gen.Type == "pool")
            {
                PoolReference(spec, columns, mask, count, tables, config.Seed);
                continue;
            }

            // A running total down a column. Resolved HERE, in declaration order, so it reads
            // a column that already exists — which is also why `of=` must name a sequence
            // declared above it.
            if (spec.Gen is not null && spec.Gen.Type == "running")
            {
                RunningColumn(spec, columns, count);
                continue;
            }

            // A statistic over the whole run. Resolved here for the same reason and by the same
            // rule: it reads a column that already exists, so `of=` has to name one above it.
            if (spec.Gen is not null && spec.Gen.Type == "stat")
            {
                StatColumn(spec, columns, count);
                continue;
            }

            // Named one by one rather than as "that shape": each is a separate piece of work,
            // and a single message would hide which one is actually holding a config up.
            if (spec.IsComputed)
            {
                // Derived, not drawn: it reads the columns already built and takes no randomness,
                // which is why declaration order alone decides what it can see.
                var derived = new string[count];
                for (int i = 0; i < count; i++)
                {
                    derived[i] = ComputeRow(spec, columns, i);
                }

                columns[spec.Name] = derived;
                continue;
            }

            if (spec.IsConditional)
            {
                columns[spec.Name] = Conditional(
                    spec, count, prng, columns, ctx, out Dictionary<string, string[]> flagCols);
                foreach (KeyValuePair<string, string[]> flag in flagCols)
                {
                    columns[flag.Key] = flag.Value;
                }
                continue;
            }

            if (spec.IsMix)
            {
                var flags = new bool[applicable];
                // The '#switch' suffix is a stable historical key: the streaming engine spells
                // it that way so a <mix> keeps the values of the <switch> it replaced.
                columns[spec.Name] = Spread(
                    rows,
                    MixValues(
                        spec.Mix!, applicable, prng, flags, ctx, Named(spec.Name + "#switch")),
                    count);

                string? flagName = spec.Mix!.Flag;
                if (!string.IsNullOrWhiteSpace(flagName))
                {
                    // The ground-truth companion: which rows took a case declared anomalous. It
                    // shares the parent mask, so the label is absent exactly where the value is.
                    columns[flagName] = Spread(
                        rows, flags.Select(on => on ? "true" : "false").ToList(), count);
                }

                continue;
            }

            if (spec.IsSwitch)
            {
                columns[spec.Name] =
                    SwitchValues(spec.SwitchSpec!, count, prng, columns, ctx, spec.Name, layouts);
                continue;
            }

            if (spec.IsComposed)
            {
                // The body in declaration order — one pass, because the order the gens draw in is
                // part of the contract and taking the named ones first would shift every column
                // after this sequence.
                var composed = new string[applicable];
                Array.Fill(composed, "");
                var built = new Dictionary<string, List<string>>(StringComparer.Ordinal);

                // `uniq="true"` on a composed value. A concatenation is unique exactly when the
                // join is injective — true when ONE part is drawn and the rest are constants,
                // because appending a constant cannot make two different draws collide. Two drawn
                // parts is the variable-width trap and the validator refuses it (TDC220), so this
                // stays null there.
                List<Item> drawnParts = spec.Items!
                    .Where(i => i.Gen is not null && i.Field is null).ToList();
                Item? uniqPart = spec.Uniq && drawnParts.Count == 1 ? drawnParts[0] : null;

                // Unnamed parts are numbered among ALL parts, literals included, because that is
                // how the streaming engine numbers them.
                int unnamed = 0;

                foreach (Item item in spec.Items!)
                {
                    if (item.ConstantName is not null)
                    {
                        // A constant costs no draw at all — that is the whole reason it exists
                        // rather than a one-value generator.
                        built[item.ConstantName] =
                            Enumerable.Repeat(item.Text ?? "", applicable).ToList();
                        continue;
                    }

                    if (item.Text is not null)
                    {
                        for (int i = 0; i < applicable; i++)
                        {
                            composed[i] += item.Text;
                        }

                        continue;
                    }

                    if (item.Field is not null)
                    {
                        built[item.Field.Name] = applicable == 0
                            ? new List<string>()
                            : ColumnValues(
                                item.Field.Gen, applicable, prng, ctx,
                                Named($"{spec.Name}.{item.Field.Name}"), null, layouts).ToList();
                        continue;
                    }

                    PerRow.Stream part = Named($"{spec.Name}#p{unnamed}");
                    unnamed++;

                    IReadOnlyList<string> drawn;
                    if (applicable == 0)
                    {
                        drawn = Array.Empty<string>();
                    }
                    else if (ReferenceEquals(item, uniqPart))
                    {
                        drawn = UniqSimple.Build(
                            spec.Name, item.Gen!, applicable, prng, ctx.Packs,
                            ctx.Config.Locale, ctx.BaseDir);
                    }
                    else
                    {
                        drawn = ColumnValues(item.Gen!, applicable, prng, ctx, part, null, layouts);
                    }
                    for (int i = 0; i < applicable; i++)
                    {
                        composed[i] += drawn[i];
                    }
                }

                if (spec.DistinctGroups is not null)
                {
                    // The groups name FIELDS, and a composed body carries its fields in `Items` —
                    // so the constraint is checked against a spec that spells them out.
                    EnforceDistinct(
                        spec with { Fields = FieldsOf(spec.Items!) }, built, applicable, prng,
                        ctx, rows);
                }

                // Only when something unnamed actually composed it. A body of nothing but named
                // items has no value of its own, and ${{Name}} stays the literal marker that says
                // you meant a field.
                if (ComposesOwnValue(spec.Items!))
                {
                    columns[spec.Name] = Spread(rows, composed, count);
                }

                foreach (KeyValuePair<string, List<string>> entry in built)
                {
                    columns[spec.Name + "." + entry.Key] = Spread(rows, entry.Value, count);
                }

                continue;
            }

            if (spec.IsCompound)
            {
                // Every field draws from the SHARED stream, in declaration order. That is what
                // keeps a compound coherent: the city and the postcode of one generated address
                // belong to the same row, not to two independent ones. Interleaving them
                // differently would still produce plausible values and pair the wrong ones.
                var produced = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                foreach (Field field in spec.Fields!)
                {
                    produced[field.Name] = applicable == 0
                        ? new List<string>()
                        : ColumnValues(
                            field.Gen, applicable, prng, ctx,
                            Named($"{spec.Name}.{field.Name}"), null, layouts).ToList();
                }

                if (spec.DistinctGroups is not null)
                {
                    EnforceDistinct(spec, produced, applicable, prng, ctx, rows);
                }

                if (spec.Uniq)
                {
                    EnforceUniqRedrawing(spec, produced, applicable, prng, ctx);
                }

                foreach (Field field in spec.Fields!)
                {
                    columns[spec.Name + "." + field.Name] =
                        Spread(rows, produced[field.Name], count);
                }

                continue;
            }

            // `common.vehicle.model.${{Brand}}` — the pack to draw from is decided by another
            // column, so the address is not known until the row is. Built here rather than in the
            // generator, because this is the only place the sibling columns exist.
            if (spec.Gen!.Type == "template" && (spec.Gen.Attr("value") ?? "").Contains("${{"))
            {
                columns[spec.Name] =
                    Spread(rows, DynamicTemplate(spec.Gen, mask, columns, prng, ctx), count);
                continue;
            }

            // A single column cannot be both proportional and unique, so — unlike the
            // compound path, which only rearranges — uniq changes the draw: without
            // replacement, one PRNG draw per pick (UniqSimple).
            if (spec.Uniq && spec.Gen!.Type is not ("increment" or "decrement"))
            {
                IReadOnlyList<string> unique =
                    applicable == 0
                        ? Array.Empty<string>()
                        : UniqSimple.Build(
                            spec.Name, spec.Gen, applicable, prng, ctx.Packs,
                            ctx.Config.Locale, ctx.BaseDir);
                columns[spec.Name] = Spread(rows, unique, count);
                continue;
            }

            var anomalyFlags = new bool[applicable];
            Repeat.Spec? repeat = Repeat.Parse(spec.Gen!.Attrs);
            PerRow.Stream stream = Named(spec.Name);
            string? anomalyFlagName = spec.Gen!.Attrs.GetValueOrDefault("anomaly_flag");
            bool flagNamed = !string.IsNullOrWhiteSpace(anomalyFlagName);

            // With `repeat` the anomaly label is a LIST parallel to the values, saying which
            // ELEMENT spiked rather than merely that one did.
            List<string>? repeatFlags = null;
            IReadOnlyList<string> values;
            if (applicable == 0)
            {
                values = Array.Empty<string>();
            }
            else if (repeat is { } r)
            {
                // A listed column lays every element of every row out at once and reads the slots
                // the length plan gave the row; anything drawn takes one sub-stream per element.
                // Which of the two is the streaming engine's own split.
                (IReadOnlyList<string> Values, double[] Percents)? listed =
                    ListedValues(spec.Gen, ctx);
                if (listed is { } l)
                {
                    values = RepeatKeyed.BuildLayout(
                        r, l.Values, l.Percents, applicable, stream,
                        ElementModifier(spec.Gen, r, stream));
                }
                else
                {
                    Gen element = new(spec.Gen.Type, Repeat.Without(spec.Gen.Attrs));
                    repeatFlags = flagNamed ? new List<string>() : null;
                    values = RepeatKeyed.BuildDraws(
                        r, applicable, stream,
                        (_, elementPrng, flag) =>
                        {
                            IReadOnlyList<string> done = Finish(
                                Generate(element, 1, elementPrng, ctx), element.Attrs,
                                elementPrng, flag);
                            return done.Count > 0 ? done[0] : "";
                        },
                        repeatFlags);
                }
            }
            else
            {
                values = ColumnValues(
                    spec.Gen!, applicable, prng, ctx, stream, anomalyFlags, layouts);
            }

            columns[spec.Name] = Spread(rows, values, count);

            if (flagNamed)
            {
                // The ground-truth companion: which rows the run chose to spike. It shares the
                // parent mask, so the label is absent exactly where the value is — a detector
                // trained on this cannot learn from a label the data never had.
                columns[anomalyFlagName!] = Spread(
                    rows,
                    repeatFlags ?? anomalyFlags.Select(on => on ? "true" : "false").ToList(),
                    count);
            }
        }

        // Both run over finished columns: a group's members must all exist before the constraint
        // between them means anything.
        EnforceEnvDistinct(ctx, columns, count, prng);
        EnforceEnvUniq(ctx, columns, count);
        ResolveHttp(ctx, columns, count);
        return columns;
    }

    /// <summary>
    /// One generator's values.
    /// </summary>
    /// <remarks>
    /// Shared with the streaming engine, which calls it with a count of one and a generator private
    /// to the row. Two copies of this dispatch would be two places for the languages to drift apart
    /// from each other and from themselves.
    /// </remarks>
    internal static IReadOnlyList<string> Generate(Gen gen, int count, Sfc32 prng, Ctx ctx)
    {
        switch (gen.Type)
        {
            case "text":
            {
                IReadOnlyList<string> list = SplitText(gen.Attr("value") ?? "");
                if (gen.Attrs.GetValueOrDefault("order") == "sequential")
                {
                    bool cycle = gen.Attrs.GetValueOrDefault("cycle") != "false";
                    var walked = new List<string>(count);
                    for (int i = 0; i < count; i++)
                    {
                        walked.Add(PickSequential(list, i, cycle));
                    }

                    return walked;
                }

                string percent = gen.Attr("percent") ?? "";
                if (percent.Length > 0)
                {
                    // Through the shared mask reader, so a partial mask like percent="50" over
                    // three values splits the remainder instead of throwing on the blanks.
                    return Hamilton.Distribute(
                        count, list, PercentMask.Expand(percent, list.Count), prng);
                }

                var picked = new List<string>(count);
                for (int i = 0; i < count; i++)
                {
                    picked.Add(list[(int)Math.Floor(prng.Next() * list.Count)]);
                }

                return picked;
            }

            case "number":
                return gen.Attrs.ContainsKey("distribution")
                    ? Distribute(gen.Attrs, count, prng)
                    : NumberGen.Generate(gen.Attrs, count, prng);
            case "pattern":
                return Pattern.PatternGen.Generate(
                    gen.Attrs, count, prng, ctx.BaseDir, ctx.Packs.DataRoots);
            case "regex":
                return RegexGen.Generate(gen.Attrs, count, ctx.RegexMax, prng);
            case "advanced_regex":
                return AdvancedRegexGen.Generate(gen.Attrs, count, ctx.RegexMax, prng);
            case "symbol":
                return SymbolGen.Generate(gen.Attrs, count, prng);
            case "http":
            {
                // Filled in a second pass, after every ordinary column exists: an http gen may read
                // another sequence through in=, and that sequence has to be there first.
                return Enumerable.Repeat("", count).ToArray();
            }

            case "template":
                return Template(gen, count, prng, ctx);
            case "date":
            {
                // The same rule over a date range: row i is the i-th step from the start. The
                // axis is arithmetic rather than a list, so a long range costs nothing to walk.
                if (gen.Attrs.GetValueOrDefault("order") == "sequential")
                {
                    DateGen.Axis axis = DateGen.DateAxis(gen.Attrs, ctx.Locale, ctx.NowMillis);
                    bool cycle = gen.Attrs.GetValueOrDefault("cycle") != "false";
                    var walked = new List<string>(count);
                    for (int i = 0; i < count; i++)
                    {
                        // An OPEN axis has no size and never wraps: row i is simply the i-th step.
                        walked.Add(axis.Size is long size
                            ? axis.At(SequentialIndex(size, i, cycle))
                            : axis.At(i));
                    }

                    return walked;
                }

                return DateGen.Generate(gen.Attrs, ctx.Locale, ctx.NowMillis, count, prng);
            }
            case "timeseries":
                return Stats.Timeseries.Generate(gen.Attrs, count, prng);
            case "file":
            {
                if (gen.Attrs.GetValueOrDefault("order") == "sequential")
                {
                    IReadOnlyList<string> rows =
                        FileGen.Load(gen.Attrs, ctx.BaseDir, ctx.Packs.DataRoots);
                    bool cycle = gen.Attrs.GetValueOrDefault("cycle") != "false";
                    var walked = new List<string>(count);
                    for (int i = 0; i < count; i++)
                    {
                        walked.Add(PickSequential(rows, i, cycle));
                    }

                    return walked;
                }

                string? rowKey = gen.Attrs.GetValueOrDefault("row")?.Trim();
                if (!string.IsNullOrEmpty(rowKey))
                {
                    return LinkedFileValues(rowKey, gen.Attrs, count, prng, ctx);
                }

                FileGen.Weighted? weighted =
                    FileGen.LoadWeighted(gen.Attrs, ctx.BaseDir, ctx.Packs.DataRoots);
                if (weighted is not null)
                {
                    // A weight is a raw count, honoured exactly: 20000 and 10000 over 30000 rows
                    // give precisely those, not "about twice as many".
                    return Hamilton.Distribute(
                        count, weighted.Values, weighted.Percents, prng);
                }

                return FileGen.Generate(
                    gen.Attrs, count, ctx.BaseDir, prng, ctx.Packs.DataRoots);
            }
            case "increment":
                return Counter.Generate(gen.Attrs, count, ascending: true);
            case "decrement":
                return Counter.Generate(gen.Attrs, count, ascending: false);
            default:
                throw new NotSupportedException(
                    $"generator type \"{gen.Type}\" is not ported to C# yet");
        }
    }

    /// <summary>
    /// <c>&lt;gen type="template" value="person.lastName"/&gt;</c> — a value out of a data pack.
    /// </summary>
    /// <remarks>
    /// Three kinds of pack answer to the same tag. A plain list is drawn from uniformly. A weighted
    /// list is laid out <em>exactly</em> rather than sampled — the counts in the file are
    /// proportions the run has to hit, so 30,000 rows from the census file hold precisely as many
    /// Smiths as the census says. And a pack marked <c>generator: tdc</c> ships a rule instead of
    /// values, because nobody can list every UUID.
    /// </remarks>
    private static IReadOnlyList<string> Template(Gen gen, int count, Sfc32 prng, Ctx ctx)
    {
        string path = gen.Attr("value") ?? "";

        // Two template paths are generators rather than packs, resolved before the registry is
        // consulted — which is why no pack file is named after either of them.
        if (path == "person.b_day")
        {
            var born = new List<string>(count);
            for (int i = 0; i < count; i++)
            {
                born.Add(DateGen.BirthDay(gen.Attrs, ctx.Locale, ctx.NowMillis, prng));
            }

            return born;
        }

        if (path == "date.range")
        {
            return DateGen.LegacyRange(gen.Attrs, ctx.Locale, ctx.NowMillis, count, prng);
        }

        DataPacks.Entry entry = ctx.Packs.Load(path, ctx.Locale);

        if (entry.IsGenerator)
        {
            return PackGenerator(entry, path, count, prng, ctx, gen.Attrs);
        }

        if (entry.Weighted)
        {
            // The same path percent= takes: an exact apportionment, not a biased draw.
            return Hamilton.Distribute(count, entry.Values, entry.Percents!, prng);
        }

        var picked = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            picked.Add(entry.Values[(int)Math.Floor(prng.Next() * entry.Values.Count)]);
        }

        return picked;
    }

    private static string ComputeRow(
        SequenceSpec spec, IReadOnlyDictionary<string, string[]> columns, int row) =>
        Tdcv2.Compute.Compute.Evaluate(
            (TDCParser.OpenCloseElementContext)spec.Compute!,
            Tdcv2.Compute.Compute.FieldsOf(
                name => columns.TryGetValue(name, out string[]? column) ? column[row] : null));




    // ── row-linked files ─────────────────────────────────────────────────────────────────────

    /// <summary>One row link's plan: which row of the file each record reads.</summary>
    internal sealed record RowLinkPlan(string SourceKey, IReadOnlyList<int> Indexes);

    /// <summary>
    /// <c>row="key"</c> — every sequence on the same key reads the same row of the file.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The first sequence to use a key draws the plan — one row index per record — and every later
    /// one follows it. That is the whole point: a city and its postcode taken from one real record
    /// are consistent, where two independent draws produce a pairing no validator would accept.
    /// </para>
    /// <para>
    /// Because only the first draws, adding a second field to an existing link consumes no further
    /// randomness and leaves every other column exactly where it was.
    /// </para>
    /// </remarks>
    /// <summary>The named <c>&lt;gen&gt;</c> fields of a composed body, in order.</summary>
    internal static IReadOnlyList<Field> FieldsOf(IReadOnlyList<Item> items) =>
        items.Where(item => item.Field is not null).Select(item => item.Field!).ToList();

    /// <summary>Whether a composed body builds a value of its own.</summary>
    /// <remarks>A body of nothing but named items — fields and constants — has none.</remarks>
    internal static bool ComposesOwnValue(IReadOnlyList<Item> items) =>
        items.Any(item => item.ConstantName is null && (item.Gen is not null || item.Text is not null));

    private static IReadOnlyList<string> LinkedFileValues(
        string rowKey, IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng, Ctx ctx)
    {
        FileGen.RowSource source = FileGen.LoadRows(attrs, ctx.BaseDir, ctx.Packs.DataRoots);

        if (!ctx.RowLinks.TryGetValue(rowKey, out RowLinkPlan? plan))
        {
            var indexes = new List<int>(count);
            FileGen.Weighted? weighted = FileGen.WeightedRows(attrs, source);
            if (weighted is not null)
            {
                // With weight=, the shared rows follow the file's counts exactly; every linked
                // field then reads those same rows.
                foreach (string index in
                         Hamilton.Distribute(count, weighted.Values, weighted.Percents, prng))
                {
                    indexes.Add(int.Parse(index, CultureInfo.InvariantCulture));
                }
            }
            else
            {
                for (int i = 0; i < count; i++)
                {
                    indexes.Add(Rand.NextInt(prng, 0, source.Rows.Count));
                }
            }

            plan = new RowLinkPlan(source.SourceKey, indexes);
            ctx.RowLinks[rowKey] = plan;
        }
        else
        {
            if (plan.SourceKey != source.SourceKey)
            {
                throw new InvalidOperationException(
                    $"sequence: row link \"{rowKey}\" cannot mix different file sources");
            }

            if (plan.Indexes.Count != count)
            {
                throw new InvalidOperationException(
                    $"sequence: row link \"{rowKey}\" cannot be reused with a different row count");
            }
        }

        return plan.Indexes.Select(index => FileGen.CellAt(source, index)).ToArray();
    }

    // ── http ─────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The second pass: fill every http column now that the ordinary ones exist.
    /// </summary>
    /// <remarks>
    /// It cannot happen in declaration order, because <c>in=</c> may name a sequence and one batch
    /// carries the whole column — the input has to be complete before the call goes out. A batch
    /// rather than a call per row is the difference between a handful of requests and a million.
    /// </remarks>
    private static void ResolveHttp(
        Ctx ctx, IReadOnlyDictionary<string, string[]> columns, int count)
    {
        foreach (SequenceSpec spec in ctx.Config.Sequences)
        {
            if (spec.Gen is null || spec.Gen.Type != "http")
            {
                continue;
            }

            IReadOnlyDictionary<string, string> attrs = spec.Gen.Attrs;
            IReadOnlyList<string>? inputs = null;
            string? inName = attrs.GetValueOrDefault("in");
            if (!string.IsNullOrWhiteSpace(inName))
            {
                columns.TryGetValue(inName, out string[]? column);
                inputs = Enumerable.Range(0, count)
                    .Select(i => column is null ? "" : column[i] ?? "")
                    .ToArray();
            }

            IReadOnlyList<string> values;
            try
            {
                values = HttpGen.Fetch(
                    attrs.GetValueOrDefault("src", ""),
                    count,
                    inputs,
                    HttpGen.SeedFor(ctx.Config.Seed, spec.Name),
                    HttpGen.OnError(attrs),
                    HttpGen.TimeoutMs(attrs.GetValueOrDefault("timeout")));
            }
            catch (HttpGen.ServiceException e)
            {
                throw new InvalidOperationException(
                    $"http service for sequence \"{spec.Name}\" at {e.Url} {e.Message}", e);
            }

            if (columns.TryGetValue(spec.Name, out string[]? target))
            {
                for (int i = 0; i < count && i < values.Count; i++)
                {
                    target[i] = values[i];
                }
            }
        }
    }

    // ── parent= ──────────────────────────────────────────────────────────────────────────────

    /// <summary>Which rows a column applies to.</summary>
    private static bool[] ParentMask(
        SequenceSpec spec, IReadOnlyDictionary<string, string[]> columns, int count)
    {
        var mask = new bool[count];
        if (spec.Parent is null)
        {
            Array.Fill(mask, true);
            return mask;
        }

        int dot = spec.Parent.IndexOf('.');
        string parentName = dot < 0 ? spec.Parent : spec.Parent[..dot];
        string? parentValue = dot < 0 ? null : spec.Parent[(dot + 1)..];

        if (!columns.TryGetValue(parentName, out string[]? parent))
        {
            throw new ArgumentException(
                $"sequence \"{spec.Name}\" references unknown parent \"{parentName}\". Parent "
                + "sequences must be declared before their children.");
        }

        for (int i = 0; i < count; i++)
        {
            mask[i] = parentValue is null ? parent[i] is not null : parentValue == parent[i];
        }

        return mask;
    }

    /// <summary>
    /// Lay dense produced values back over the full row range, leaving filtered rows null.
    /// </summary>
    /// <remarks>
    /// A null means "this row is outside the column's parent filter", which renders as empty rather
    /// than as a neighbour's value shifted up — the failure a dense array would produce silently.
    /// </remarks>
    private static string[] Spread(
        IReadOnlyList<int> rows, IReadOnlyList<string> produced, int count)
    {
        var values = new string[count];
        for (int at = 0; at < rows.Count; at++)
        {
            values[rows[at]] = at < produced.Count ? produced[at] : null!;
        }

        return values;
    }

    /// <summary>
    /// A template whose address names another column.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The row decides where its value comes from: a car's model list depends on its make, a
    /// region's cities on its country. That is the difference between data that is merely plausible
    /// per column and data that holds together across a record.
    /// </para>
    /// <para>
    /// One row at a time, necessarily — the address changes with it — and only on the rows the
    /// parent selected, so a filtered-out row draws nothing rather than drawing from whatever
    /// address an empty interpolation happens to produce.
    /// </para>
    /// </remarks>
    private static List<string> DynamicTemplate(
        Gen gen, bool[] mask, IReadOnlyDictionary<string, string[]> columns, Sfc32 prng, Ctx ctx)
    {
        string template = gen.Attr("value") ?? "";
        string? locale = gen.Attrs.GetValueOrDefault("local");
        if (string.IsNullOrWhiteSpace(locale))
        {
            locale = ctx.Locale;
        }

        var result = new List<string>();
        for (int row = 0; row < mask.Length; row++)
        {
            if (!mask[row])
            {
                continue;
            }

            string address = Interpolate.Apply(
                template, ctx.Config.Inject, new RowLookup(columns, row));
            var attrs = new Dictionary<string, string>(gen.Attrs, StringComparer.Ordinal)
            {
                ["value"] = address,
                ["local"] = locale ?? "",
            };
            IReadOnlyList<string> built = Template(
                new Gen("template", attrs), 1, prng, ctx with { Config = ctx.Config });
            result.Add(built.Count == 0 ? "" : built[0]);
        }

        return result;
    }

    // ── uniq and distinct ────────────────────────────────────────────────────────────────────

    /// <summary>How many redraws a <c>&lt;distinct&gt;</c> field gets before its source is called too small.</summary>
    private const int DistinctFuse = 100;

    /// <summary>How many independent redraws before a <c>uniq=</c> config is declared impossible.</summary>
    private const int UniqRedrawAttempts = 8;

    /// <summary>
    /// <c>&lt;distinct&gt;</c> — fields inside one group must differ from each other within a row.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Redraw on collision, field by field, in declaration order. A person's city of birth and city
    /// of residence come from the same list and are usually different; without this they coincide
    /// about as often as the list is short.
    /// </para>
    /// <para>
    /// Redrawing appends to the stream, so the result stays deterministic. The fuse is there because
    /// a one-value list can never satisfy two fields, and spinning forever would say far less than
    /// naming the problem.
    /// </para>
    /// <para>
    /// <paramref name="sharedPrng"/> is for a PACK BODY, which is a nested build with no seed of
    /// its own: there is nothing to key a repair stream by, so the replacement comes off the prng
    /// the body was handed. The reference draws exactly this distinction, and a Spanish or
    /// Portuguese full name — two given names and two surnames, each pair <c>&lt;distinct&gt;</c>
    /// — is where it shows.
    /// </para>
    /// </remarks>
    private static void EnforceDistinct(
        SequenceSpec spec, Dictionary<string, List<string>> produced, int count,
        Sfc32 prng, Ctx ctx, IReadOnlyList<int> rows, bool sharedPrng = false)
    {
        var genByField = spec.Fields!.ToDictionary(f => f.Name, f => f.Gen, StringComparer.Ordinal);

        foreach (IReadOnlyList<string> group in spec.DistinctGroups!)
        {
            List<string> fields = group
                .Where(name => produced.ContainsKey(name) && genByField.ContainsKey(name))
                .ToList();
            if (fields.Count < 2)
            {
                continue;
            }

            for (int i = 0; i < count; i++)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (string fieldName in fields)
                {
                    List<string> values = produced[fieldName];
                    Gen gen = genByField[fieldName];
                    string value = values[i];
                    int attempts = 0;
                    while (seen.Contains(value))
                    {
                        if (attempts >= DistinctFuse)
                        {
                            throw new InvalidOperationException(
                                $"<distinct> in sequence \"{spec.Name}\": could not find a value "
                                + $"for field \"{fieldName}\" different from the others after "
                                + $"{DistinctFuse} attempts — its source likely has too few "
                                + "distinct values.");
                        }

                        attempts++;

                        // Each attempt has a stream of its own, named for the field and the
                        // attempt number — the same names the streaming engine redraws under,
                        // so both engines land on the same replacement.
                        int row = i < rows.Count ? rows[i] : i;
                        Sfc32 one = sharedPrng
                            ? prng
                            : Seekable.Generator(
                                ctx.Config.Seed, $"{spec.Name}.{fieldName}#d{attempts}", row);
                        value = Generate(gen, 1, one, ctx)[0];
                    }

                    values[i] = value;
                    seen.Add(value);
                }
            }
        }
    }

    /// <summary>Thrown by the arranger alone, so the retry below can tell it from a real failure.</summary>
    private sealed class UniqInfeasible : Exception
    {
        internal readonly int Achievable;

        internal UniqInfeasible(int achievable)
            : base("uniq is infeasible") => Achievable = achievable;
    }

    /// <summary>
    /// <c>uniq="true"</c> — no two rows carry the same tuple.
    /// </summary>
    /// <remarks>
    /// The values are only rearranged, never replaced, so a declared <c>percent=</c> share comes
    /// through untouched. Uniqueness and an exact distribution are not a trade here. Checked before
    /// any output: a cheap upper bound first, then the builder's own answer.
    /// </remarks>
    private static void ArrangeUnique(
        SequenceSpec spec, Dictionary<string, List<string>> produced, int count)
    {
        var columns = new List<IReadOnlyList<string>>();
        foreach (Field field in spec.Fields!)
        {
            columns.Add(produced[field.Name]);
        }

        // Already unique as drawn? Then there is nothing to rearrange, and moving values anyway
        // would only make this engine disagree with the exact one, which checks the same thing
        // first and leaves a passing draw untouched. Cheap enough to always ask: one pass, one
        // set. NUL joins the tuple because a generated value cannot contain it, so no two
        // different tuples can join into the same key.
        var seenTuples = new HashSet<string>(StringComparer.Ordinal);
        bool collided = false;
        for (int i = 0; i < count && !collided; i++)
        {
            collided = !seenTuples.Add(string.Join(
                '\0', columns.Select(c => i < c.Count ? c[i] : "")));
        }

        if (!collided)
        {
            return;
        }

        var columnCounts = new List<IReadOnlyList<int>>();
        foreach (IReadOnlyList<string> column in columns)
        {
            columnCounts.Add(Uniq.ValueCounts(column));
        }

        // The cheap bound first: it cannot be reached, so there is no point building anything.
        int upper = Uniq.UpperBound(columnCounts);
        if (count > upper)
        {
            throw new UniqInfeasible(upper);
        }

        Uniq.Arrangement arranged = Uniq.Arrange(columns);
        if (arranged.Distinct < count)
        {
            throw new UniqInfeasible(arranged.Distinct);
        }

        for (int i = 0; i < spec.Fields.Count; i++)
        {
            produced[spec.Fields[i].Name] = arranged.Columns[i];
        }
    }

    /// <summary>
    /// <c>uniq="true"</c>, and a fresh draw when the first one happened to be unarrangeable.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The arranger may only rearrange what was drawn — that is what keeps <c>percent=</c> exact.
    /// But when nothing pins the proportions, a lopsided draw is an accident of sampling rather than
    /// something to protect, and refusing the whole run over it blames the value lists for a problem
    /// they do not have: four values by eight values over twenty rows has thirty-two combinations,
    /// and a draw of 7/6/3/4 would report "at most 19".
    /// </para>
    /// <para>
    /// This runs only where the arranger threw, so no config that works today shifts by a byte — a
    /// successful run consumes exactly the draws it always did.
    /// </para>
    /// <para>
    /// When the columns come from an exact quota, a redraw returns the same multiset in a different
    /// order and cannot help. That is detected after one attempt and reported as what it is, rather
    /// than retried seven more times for nothing.
    /// </para>
    /// </remarks>
    private static void EnforceUniqRedrawing(
        SequenceSpec spec, Dictionary<string, List<string>> produced, int count, Sfc32 prng,
        Ctx ctx)
    {
        try
        {
            ArrangeUnique(spec, produced, count);
            return;
        }
        catch (UniqInfeasible)
        {
            // Fall through to the redraw.
        }

        string firstSignature = UniqSignature(spec, produced);
        int best = 0;
        for (int attempt = 0; attempt < UniqRedrawAttempts; attempt++)
        {
            foreach (Field field in spec.Fields!)
            {
                produced[field.Name] = Finish(
                    Generate(field.Gen, count, prng, ctx), field.Gen.Attrs, prng).ToList();
            }

            // The same value frequencies mean the draw is quota-fixed: every further attempt would
            // produce this multiset again.
            bool quotaFixed = attempt == 0 && UniqSignature(spec, produced) == firstSignature;
            try
            {
                ArrangeUnique(spec, produced, count);
                return;
            }
            catch (UniqInfeasible e)
            {
                best = Math.Max(best, e.Achievable);
                if (quotaFixed)
                {
                    throw new InvalidOperationException(
                        $"uniq: sequence \"{spec.Name}\" cannot produce {count} unique "
                        + "combinations. Its values are drawn to an exact share (percent=, or a "
                        + "weighted pack), so their proportions are fixed by the config, and those "
                        + $"proportions allow at most {e.Achievable} distinct rows. Add more values "
                        + "to a field (more distinct names, wider ranges…), relax the share, or "
                        + "lower the count.");
                }
            }
        }

        throw new InvalidOperationException(
            $"uniq: sequence \"{spec.Name}\" cannot produce {count} unique combinations — "
            + $"{UniqRedrawAttempts} independent draws each topped out around {best} distinct rows. "
            + "Its fields do not hold enough distinct values between them. Add more values to a "
            + "field (more distinct names, wider ranges…) or lower the count.");
    }

    /// <summary>Per field, its value frequencies sorted — what changes when a draw is not quota-fixed.</summary>
    private static string UniqSignature(
        SequenceSpec spec, Dictionary<string, List<string>> produced) =>
        string.Join(
            "|",
            spec.Fields!.Select(f =>
            {
                List<int> counts = Uniq.ValueCounts(produced[f.Name]);
                counts.Sort();
                return string.Join(",", counts);
            }));

    /// <summary>
    /// Env-level <c>&lt;distinct&gt;</c>: the wrapped sequences differ from each other on every row.
    /// </summary>
    private static void EnforceEnvDistinct(
        Ctx ctx, IReadOnlyDictionary<string, string[]> columns, int count, Sfc32 prng)
    {
        if (ctx.Config.EnvDistinctGroups.Count == 0)
        {
            return;
        }

        var byName = ctx.Config.Sequences.ToDictionary(s => s.Name, StringComparer.Ordinal);

        foreach (IReadOnlyList<string> group in ctx.Config.EnvDistinctGroups)
        {
            List<string> members = ScalarMembers(group, byName, columns);
            if (members.Count < 2)
            {
                continue;
            }

            for (int i = 0; i < count; i++)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (string name in members)
                {
                    string[] values = columns[name];
                    string value = values[i];
                    int attempts = 0;
                    while (seen.Contains(value))
                    {
                        if (attempts >= DistinctFuse)
                        {
                            throw new InvalidOperationException(
                                "<distinct> across sequences: could not find a value for sequence "
                                + $"\"{name}\" different from the others after {DistinctFuse} "
                                + "attempts — its source likely has too few distinct values.");
                        }

                        attempts++;

                        // Named for the sequence and the attempt, exactly as the streaming
                        // engine names it, so the replacement is the same on both engines.
                        Sfc32 one = Seekable.Generator(
                            ctx.Config.Seed, $"{name}#ed{attempts}", i);
                        value = OneScalar(byName[name], one, ctx);
                    }

                    values[i] = value;
                    seen.Add(value);
                }
            }
        }
    }

    /// <summary>
    /// Env-level <c>&lt;uniq&gt;</c>: the tuple of the wrapped sequences is unique across the run.
    /// </summary>
    /// <remarks>
    /// The values are already drawn, so this rearranges rather than redraws — each column keeps the
    /// multiset it produced and only the pairings change. That is what keeps a weighted member's
    /// proportions intact while the combinations become distinct.
    /// </remarks>
    private static void EnforceEnvUniq(
        Ctx ctx, IReadOnlyDictionary<string, string[]> columns, int count)
    {
        if (ctx.Config.EnvUniqGroups.Count == 0)
        {
            return;
        }

        var byName = ctx.Config.Sequences.ToDictionary(s => s.Name, StringComparer.Ordinal);

        foreach (IReadOnlyList<string> group in ctx.Config.EnvUniqGroups)
        {
            List<string> members = ScalarMembers(group, byName, columns);
            if (members.Count < 2)
            {
                continue;
            }

            // Only the rows where every member has a value: a row one member skips has no tuple to
            // make unique, and forcing one would invent a value the config never asked for.
            var rows = new List<int>();
            for (int i = 0; i < count; i++)
            {
                if (members.All(name => columns[name][i] is not null))
                {
                    rows.Add(i);
                }
            }

            if (rows.Count == 0)
            {
                continue;
            }

            string label = string.Join(" × ", members);
            var byRow = new Dictionary<int, string[]>();

            foreach (List<int> block in PartitionRows(rows, SubjectsOf(members, byName), columns))
            {
                var grid = new List<IReadOnlyList<string>>();
                var counts = new List<IReadOnlyList<int>>();
                foreach (string name in members)
                {
                    List<string> column = block.Select(row => columns[name][row]).ToList();
                    grid.Add(column);
                    counts.Add(Uniq.ValueCounts(column));
                }

                int upper = Uniq.UpperBound(counts);
                if (block.Count > upper)
                {
                    throw new InvalidOperationException(UniqGroupMessage(label, rows.Count, upper));
                }

                Uniq.Arrangement arranged = Uniq.Arrange(grid);
                if (arranged.Distinct < block.Count)
                {
                    throw new InvalidOperationException(
                        UniqGroupMessage(label, rows.Count, arranged.Distinct));
                }

                for (int k = 0; k < block.Count; k++)
                {
                    var tuple = new string[members.Count];
                    for (int m = 0; m < members.Count; m++)
                    {
                        tuple[m] = arranged.Columns[m][k];
                    }

                    byRow[block[k]] = tuple;
                }
            }

            // Blocks are made unique on their own; two of them could still meet on the same tuple
            // when the subjects share a value (a name in both lists). Rare, but silence here would
            // be a broken promise, so it is counted and refused.
            var seen = new HashSet<string>(
                rows.Select(row => string.Join("\u0000", byRow[row])), StringComparer.Ordinal);
            if (seen.Count < rows.Count)
            {
                throw new InvalidOperationException(
                    UniqGroupMessage(label, rows.Count, seen.Count));
            }

            for (int m = 0; m < members.Count; m++)
            {
                string[] values = columns[members[m]];
                foreach (int row in rows)
                {
                    values[row] = byRow[row][m];
                }
            }
        }
    }

    private static string UniqGroupMessage(string label, int need, int available) =>
        $"uniq: group \"{label}\" cannot produce {need} unique combinations — the values drawn for "
        + $"these sequences allow at most {available} distinct rows. Add more values to a member "
        + "(more distinct names, wider ranges…) or lower the count.";

    /// <summary>
    /// The subjects the group's <c>&lt;switch&gt;</c> members are keyed by, in order, without
    /// repeats. Empty when no member is a switch, which is the ordinary case and leaves the
    /// behaviour exactly as it was.
    /// </summary>
    private static List<string> SubjectsOf(
        List<string> members, IReadOnlyDictionary<string, SequenceSpec> byName)
    {
        var subjects = new List<string>();
        foreach (string name in members)
        {
            if (byName.TryGetValue(name, out SequenceSpec? spec)
                && spec.SwitchSpec is not null
                && !subjects.Contains(spec.SwitchSpec.On, StringComparer.Ordinal))
            {
                subjects.Add(spec.SwitchSpec.On);
            }
        }

        return subjects;
    }

    /// <summary>
    /// Split the rows into blocks that may be shuffled among themselves. With no switch member
    /// there is one block holding every row — the old behaviour, bit for bit. With one, rows are
    /// grouped by the value of its subject, so male rows only ever trade with male rows.
    /// </summary>
    private static List<List<int>> PartitionRows(
        List<int> rows, List<string> subjects, IReadOnlyDictionary<string, string[]> columns)
    {
        if (subjects.Count == 0)
        {
            return new List<List<int>> { rows };
        }

        var blocks = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (int row in rows)
        {
            string key = string.Join(
                "\u0000",
                subjects.Select(s => columns.TryGetValue(s, out string[]? c) ? c[row] : string.Empty));
            if (!blocks.TryGetValue(key, out List<int>? block))
            {
                block = new List<int>();
                blocks[key] = block;
                order.Add(key);
            }

            block.Add(row);
        }

        return order.Select(k => blocks[k]).ToList();
    }

    private static List<string> ScalarMembers(
        IReadOnlyList<string> group, IReadOnlyDictionary<string, SequenceSpec> byName,
        IReadOnlyDictionary<string, string[]> columns) =>
        group
            .Where(name =>
                byName.TryGetValue(name, out SequenceSpec? spec)
                && (spec.Gen is not null || spec.IsMix || spec.IsSwitch)
                && columns.ContainsKey(name))
            .ToList();

    /// <summary>One fresh value from a sequence — what a <c>&lt;distinct&gt;</c> collision redraws.</summary>
    private static string OneScalar(SequenceSpec spec, Sfc32 prng, Ctx ctx)
    {
        if (spec.Gen is not null)
        {
            IReadOnlyList<string> built =
                Finish(Generate(spec.Gen, 1, prng, ctx), spec.Gen.Attrs, prng);
            return built.Count == 0 ? "" : built[0];
        }

        if (spec.IsMix)
        {
            IReadOnlyList<string> built = MixValues(spec.Mix!, 1, prng, new bool[1], ctx, null);
            return built.Count == 0 ? "" : built[0];
        }

        return "";
    }

    /// <summary>Pack bodies parse once per address and are then reused; a pack does not change mid-run.</summary>
    private static readonly Dictionary<string, object> PackBodies = new(StringComparer.Ordinal);

    /// <summary>
    /// A pack that ships a rule rather than a list.
    /// </summary>
    /// <remarks>
    /// Only the lone-<c>&lt;gen&gt;</c> shape is ported. The composed shape — local sequences
    /// feeding an output template, which is how an identifier with a check digit is written as
    /// editable data — needs the compute layer, and refuses by name until that is here.
    /// </remarks>
    /// <summary>
    /// Attributes on a <c>&lt;gen type="template"&gt;</c> that steer the CALL rather than
    /// parameterise the pack behind it. Everything else may replace a same-named local sequence.
    /// </summary>
    private static readonly IReadOnlySet<string> ReservedTemplateAttrs =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "type", "value", "local", "name", "if", "comment", "anomaly", "anomaly_factor",
            "anomaly_flag", "missing", "missing_as", "mask", "case", "order", "cycle",
        };

    private static IReadOnlyList<string> PackGenerator(
        DataPacks.Entry entry,
        string path,
        int count,
        Sfc32 prng,
        Ctx ctx,
        IReadOnlyDictionary<string, string>? callerAttrs = null)
    {
        object body;
        lock (PackBodies)
        {
            if (!PackBodies.TryGetValue(path, out body!))
            {
                string source = entry.Generator!;
                // A body holding <sequence> or <data> is composed; anything else is a lone <gen>.
                body = source.Contains("<sequence") || source.Contains("<data")
                    ? ConfigBuilder.ParsePackBody(source)
                    : ConfigBuilder.ParseGenTag(source);
                PackBodies[path] = body;
            }
        }

        if (body is Gen packGen)
        {
            return Generate(packGen, count, prng, ctx);
        }

        var pack = (ConfigBuilder.PackGenerator)body;
        var local = new Dictionary<string, string[]>(StringComparer.Ordinal);
        foreach (SequenceSpec spec in pack.Sequences)
        {
            // A caller attribute whose name matches this local sequence replaces it with a
            // constant column: `<gen type="template" value="common.internet.email"
            // domain="example.test"/>` is how a pack is parameterised. It draws nothing, so the
            // rest of the body's deterministic stream is exactly where it would otherwise be.
            if (callerAttrs is not null
                && !ReservedTemplateAttrs.Contains(spec.Name)
                && callerAttrs.TryGetValue(spec.Name, out string? overridden))
            {
                var constant = new string[count];
                Array.Fill(constant, overridden);
                local[spec.Name] = constant;
                continue;
            }

            foreach ((string name, string[] values) in MaterializeLocal(spec, count, prng, ctx, local))
            {
                local[name] = values;
            }
        }

        if (pack.Validate is not null)
        {
            EnforceValid(pack, local, count, prng, ctx);
        }

        var rendered = new List<string>(count);
        for (int row = 0; row < count; row++)
        {
            rendered.Add(Interpolate.Apply(pack.Output, ctx.Config.Inject, new RowLookup(local, row)));
        }

        return rendered;
    }

    /// <summary>
    /// One local sequence of a pack body, as the column or columns it contributes.
    /// </summary>
    /// <remarks>
    /// A COMPOUND sequence contributes one column per field, named <c>sequence.field</c> — the same
    /// shape it has in a config, because the reference runs a pack body through the very sequence
    /// builder a config goes through. Every <c>.tdc</c> pack that ships is written this way.
    /// </remarks>
    private static List<(string Name, string[] Values)> MaterializeLocal(
        SequenceSpec spec, int count, Sfc32 prng, Ctx ctx,
        IReadOnlyDictionary<string, string[]> local)
    {
        var produced = new List<(string, string[])>();
        if (spec.IsComputed)
        {
            var values = new string[count];
            for (int i = 0; i < count; i++)
            {
                values[i] = ComputeRow(spec, local, i);
            }

            produced.Add((spec.Name, values));
            return produced;
        }

        if (spec.Fields is not null)
        {
            // Declaration order off the shared prng: a pack body is a nested build with no stream
            // of its own, so the fields of one row draw one after another rather than each keying
            // itself — which is what pairs a given name with the surname beside it.
            var byField = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (Field field in spec.Fields)
            {
                IReadOnlyList<string> drawn = Generate(field.Gen, count, prng, ctx);
                byField[field.Name] = Finish(drawn, field.Gen.Attrs, prng).ToList();
            }

            // After every field exists, never during: a group's members must all be there before
            // the constraint between them means anything.
            if (spec.DistinctGroups is not null)
            {
                EnforceDistinct(spec, byField, count, prng, ctx, Array.Empty<int>(), true);
            }

            foreach (Field field in spec.Fields)
            {
                produced.Add((spec.Name + "." + field.Name, byField[field.Name].ToArray()));
            }

            return produced;
        }

        IReadOnlyList<string> single = Generate(spec.Gen!, count, prng, ctx);
        produced.Add((spec.Name, Finish(single, spec.Gen!.Attrs, prng).ToArray()));
        return produced;
    }

    /// <summary>How many redraws a <c>&lt;valid&gt;</c> constraint gets before the pack is called impossible.</summary>
    private const int ValidFuse = 100;

    /// <summary>
    /// Reject and redraw until the pack's <c>&lt;valid&gt;</c> predicate holds.
    /// </summary>
    /// <remarks>
    /// Some identifiers have combinations that were never issued — a region code that does not
    /// exist, a date inside a national ID that never happened. Redrawing appends to the stream, so
    /// the result stays deterministic; the fuse is there because a constraint no draw can satisfy
    /// would otherwise hang the run rather than report itself.
    /// </remarks>
    private static void EnforceValid(
        ConfigBuilder.PackGenerator pack, Dictionary<string, string[]> local, int count,
        Sfc32 prng, Ctx ctx)
    {
        for (int row = 0; row < count; row++)
        {
            int attempts = 0;
            while (!Holds(pack, local, row))
            {
                if (++attempts > ValidFuse)
                {
                    throw new InvalidOperationException(
                        $"pack generator: <valid> still fails after {ValidFuse} attempts — the "
                        + "constraint may be impossible");
                }

                foreach (SequenceSpec spec in pack.Sequences)
                {
                    if (spec.IsComputed)
                    {
                        local[spec.Name][row] = ComputeRow(spec, local, row);
                        continue;
                    }

                    foreach ((string name, string[] values) in
                        MaterializeLocal(spec, 1, prng, ctx, local))
                    {
                        local[name][row] = values[0];
                    }
                }
            }
        }
    }

    private static bool Holds(
        ConfigBuilder.PackGenerator pack, IReadOnlyDictionary<string, string[]> local, int row) =>
        Tdcv2.Compute.Compute.EvaluatePredicate(
            pack.Validate!,
            Tdcv2.Compute.Compute.FieldsOf(
                name => local.TryGetValue(name, out string[]? column) ? column[row] : null));

    /// <summary>
    /// A conditional sequence: the first branch whose condition holds wins.
    /// </summary>
    /// <remarks>
    /// Every branch is generated in full, for every row, even though at most one value survives on
    /// each. That is not waste to be optimised away — the draws a branch takes are part of the
    /// stream, so generating only the winning branch would make the whole run depend on which
    /// branch happened to win, and two engines would stop agreeing.
    /// </remarks>
    private static string[] Conditional(
        SequenceSpec spec, int count, Sfc32 prng, IReadOnlyDictionary<string, string[]> columns,
        Ctx ctx, out Dictionary<string, string[]> extraColumns)
    {
        extraColumns = new Dictionary<string, string[]>();
        if (count == 0)
        {
            return Array.Empty<string>();
        }

        // Each branch draws under its OWN stream — `Name#if0`, `Name#if1` — the ids the
        // streaming engine gives them. They used to take the run's shared PRNG, which made a
        // branch's values depend on how many draws the columns before it had made, so the same
        // config and seed produced different data here than when streaming.
        var built = new List<IReadOnlyList<string>>();
        var flagNames = new List<string?>();
        var flags = new List<bool[]>();
        for (int b = 0; b < spec.Branches!.Count; b++)
        {
            Gen gen = spec.Branches[b].Gen;
            var spiked = new bool[count];
            built.Add(ColumnValues(
                gen, count, prng, ctx,
                new PerRow.Stream(ctx.Config.Seed, spec.Name + "#if" + b, null), spiked));
            string declared = (gen.Attrs.TryGetValue("anomaly_flag", out string? f) ? f : "").Trim();
            flagNames.Add(declared.Length == 0 ? null : declared);
            flags.Add(spiked);
        }

        // One column per DISTINCT name: branches sharing anomaly_flag="IsOutlier" share the
        // column, which is the point of writing it on each branch.
        var flagColumns = new Dictionary<string, string[]>();
        foreach (string? name in flagNames)
        {
            if (name is not null && !flagColumns.ContainsKey(name))
            {
                flagColumns[name] = new string[count];
            }
        }

        var result = new string[count];
        for (int i = 0; i < count; i++)
        {
            int winner = -1;
            for (int b = 0; b < spec.Branches.Count; b++)
            {
                string? condition = spec.Branches[b].IfExpr;
                if (condition is null || Condition(condition, columns, i))
                {
                    winner = b;
                    break;
                }
            }

            // No branch matched: the row is not covered, so neither the value nor any claim
            // about it exists — every flag column stays null here, masked like the value.
            result[i] = winner < 0 ? null! : built[winner][i];
            if (winner < 0)
            {
                continue;
            }

            foreach (string name in flagColumns.Keys)
            {
                // A covered row always has an answer. "false" — not empty — when the branch
                // that produced it cannot spike at all, because "no outlier" is the truth about
                // that row and a detector scored against the column needs it stated.
                bool spiked = flagNames[winner] == name && flags[winner][i];
                flagColumns[name][i] = spiked ? "true" : "false";
            }
        }

        extraColumns = flagColumns;
        return result;
    }

    /// <summary>
    /// Evaluate an <c>if</c> against one row.
    /// </summary>
    /// <remarks>
    /// A column that has no value on this row reads as empty rather than as missing, so a
    /// condition on a child column is false on the rows its parent did not select — which is what
    /// a config expects when it asks about a field that only some records have.
    /// </remarks>
    private static bool Condition(
        string expression, IReadOnlyDictionary<string, string[]> columns, int row) =>
        Evaluate.AsCondition(expression, new RowScope(columns, row));

    private sealed class RowScope : Evaluate.IScope
    {
        private readonly IReadOnlyDictionary<string, string[]> _columns;
        private readonly int _row;

        internal RowScope(IReadOnlyDictionary<string, string[]> columns, int row)
        {
            _columns = columns;
            _row = row;
        }

        public bool Has(string name) => _columns.ContainsKey(name);

        public string Value(string name) =>
            _columns.TryGetValue(name, out string[]? column) && _row < column.Length
                ? column[_row] ?? ""
                : "";
    }

    /// <summary>
    /// A <c>&lt;mix&gt;</c>: several ways to build one value, apportioned exactly over the run.
    /// </summary>
    /// <remarks>
    /// Which rows take which case is decided first, by the same apportionment percent= uses, and
    /// each case then builds values only for the rows that chose it. Building every case for
    /// every row would be simpler and would take a different number of draws.
    /// </remarks>
    private static IReadOnlyList<string> MixValues(
        Mix mix, int count, Sfc32 prng, bool[]? flags, Ctx ctx, PerRow.Stream? stream)
    {
        IReadOnlyList<Case> cases = mix.Cases;
        if (cases.Count == 0)
        {
            return Enumerable.Repeat("", count).ToArray();
        }

        double[] percents;
        if (string.IsNullOrWhiteSpace(mix.Percent))
        {
            percents = Enumerable.Repeat(100.0 / cases.Count, cases.Count).ToArray();
        }
        else
        {
            percents = PercentMask.Expand(mix.Percent!, cases.Count);
        }

        var result = new string[count];
        Array.Fill(result, "");

        // An inline mix inside a pack generator body has nothing to key by, so the older
        // arrangement stands there.
        if (stream is null)
        {
            IReadOnlyList<int> selected = Hamilton.Distribute(
                count, Enumerable.Range(0, cases.Count).ToArray(), percents, prng);
            if (flags is not null)
            {
                for (int i = 0; i < count; i++)
                {
                    flags[i] = cases[selected[i]].Anomaly;
                }
            }

            for (int c = 0; c < cases.Count; c++)
            {
                var taken = new List<int>();
                for (int i = 0; i < count; i++)
                {
                    if (selected[i] == c)
                    {
                        taken.Add(i);
                    }
                }

                if (taken.Count == 0)
                {
                    continue;
                }

                IReadOnlyList<string> drawn = CaseValues(cases[c], taken.Count, prng, ctx, null);
                for (int i = 0; i < taken.Count; i++)
                {
                    result[taken[i]] = drawn[i];
                }
            }

            return result;
        }

        // Which case a row takes is the same exact layout a weighted list gets: a quota per case,
        // permuted over the rows. So the choice follows from the row alone, and the shares still
        // come out to the digit over the whole run.
        int[] counts = Hamilton.CountsPerValue(
            count, percents, Prng.Prng.Create($"{stream.Seed}|{stream.Id}|pct"));
        int layoutKey = Permute.Key(stream.Seed, stream.Id);

        // Case c owns slots [cumLo[c], cumLo[c] + counts[c]).
        var cumLo = new int[counts.Length];
        int acc = 0;
        for (int c = 0; c < counts.Length; c++)
        {
            cumLo[c] = acc;
            acc += counts[c];
        }

        // The permutation both ways. The streaming engine asks "which slot is this row?";
        // building a case's body needs the reverse, "which row holds slot s?".
        var slotOf = new int[count];
        var positionOfSlot = new int[count];
        for (int i = 0; i < count; i++)
        {
            int slot = Permute.Apply(i, count, layoutKey);
            slotOf[i] = slot;
            positionOfSlot[slot] = i;
        }

        int CaseOfSlot(int slot)
        {
            for (int c = 0; c < counts.Length; c++)
            {
                if (slot < cumLo[c] + counts[c])
                {
                    return c;
                }
            }

            return counts.Length - 1;
        }

        for (int c = 0; c < cases.Count; c++)
        {
            int quota = counts[c];
            if (quota == 0)
            {
                continue;
            }

            var positions = new int[quota];
            var caseRows = new int[quota];
            for (int local = 0; local < quota; local++)
            {
                positions[local] = positionOfSlot[cumLo[c] + local];
                caseRows[local] = stream.RowAt(positions[local]);
            }

            IReadOnlyList<string> drawn = CaseValues(
                cases[c], quota, prng, ctx, new PerRow.Stream(
                    stream.Seed, $"{stream.Id}#c{c}", caseRows));
            for (int local = 0; local < quota; local++)
            {
                result[positions[local]] = drawn[local];
            }
        }

        if (flags is not null)
        {
            // The label reads the same slot-to-case mapping the value did, so the two cannot
            // disagree on a row — which is the whole point of a ground-truth column.
            for (int i = 0; i < count; i++)
            {
                flags[i] = cases[CaseOfSlot(slotOf[i])].Anomaly;
            }
        }

        return result;
    }

    /// <summary>A case body: its pieces concatenated, each built for the rows that chose it.</summary>
    private static IReadOnlyList<string> CaseValues(
        Case caseSpec, int count, Sfc32 prng, Ctx ctx, PerRow.Stream? stream)
    {
        var parts = new System.Text.StringBuilder[count];
        for (int i = 0; i < count; i++)
        {
            parts[i] = new System.Text.StringBuilder();
        }

        // Parts are numbered among ALL of them, literals included: the streaming engine numbers
        // them off the same list, and a different count here would key the same part under a
        // different name.
        for (int p = 0; p < caseSpec.Parts.Count; p++)
        {
            CasePart part = caseSpec.Parts[p];
            PerRow.Stream? sub = stream?.Named($"{stream.Id}#p{p}");
            IReadOnlyList<string> values;
            if (part.Text is not null)
            {
                values = Enumerable.Repeat(part.Text, count).ToArray();
            }
            else if (part.Gen is not null)
            {
                values = ColumnValues(part.Gen, count, prng, ctx, sub);
            }
            else if (part.Mix is not null)
            {
                values = MixValues(part.Mix, count, prng, null, ctx, sub);
            }
            else
            {
                values = NestedSwitchValues(part.SwitchSpec!, count, prng, ctx, sub);
            }

            for (int i = 0; i < count; i++)
            {
                parts[i].Append(values[i]);
            }
        }

        return parts.Select(b => b.ToString()).ToArray();
    }

    /// <summary>
    /// A switch: look the subject's value up in the table.
    /// </summary>
    /// <remarks>
    /// An entry is built over THE ROWS THAT CHOSE IT, exactly as a mix builds a case over the
    /// rows it won. Every entry used to be built over the whole run and the values that landed
    /// on rows belonging to another branch were dropped, so a <c>&lt;mix percent="20,80"&gt;</c>
    /// inside <c>&lt;case is="Male"&gt;</c> apportioned its 20% across all the rows rather than
    /// across the men. Measured over 100 runs of 10 rows split 5/5: 0, 1 or 2 survivors, and 23
    /// runs with none at all, where the config plainly asked for one man in five.
    /// <para>
    /// A row with no match and no default is empty — which is a value, not a failure: a country
    /// with no currency listed simply has none here.
    /// </para>
    /// </remarks>
    private static string[] SwitchValues(
        Switch spec, int count, Sfc32 prng, IReadOnlyDictionary<string, string[]> columns,
        Ctx ctx, string name, Dictionary<string, PerRow.ExactLayout> layouts)
    {
        // Group the rows by branch BEFORE generating: the subject's whole column is already here.
        columns.TryGetValue(spec.On, out string[]? subject);
        var entryRows = new List<List<int>>(spec.Entries.Count);
        for (int e = 0; e < spec.Entries.Count; e++)
        {
            entryRows.Add(new List<int>());
        }

        var fallbackRows = new List<int>();
        for (int i = 0; i < count; i++)
        {
            string key = subject is null ? "" : subject[i] ?? "";
            int picked = -1;
            for (int e = 0; e < spec.Entries.Count; e++)
            {
                if (spec.Entries[e].Keys.Contains(key))
                {
                    picked = e;
                    break;
                }
            }

            (picked < 0 ? fallbackRows : entryRows[picked]).Add(i);
        }

        var result = new string[count];

        // A branch no row chose draws nothing: a quota over zero rows is not a quota.
        //
        // `ranked` is the rows in the order the STREAMING engine numbers them; null when they
        // cannot be numbered, and then the branch is built over the whole run and read at the
        // row — which is what the streaming engine does with such a branch, and the two must
        // agree.
        void Place(Case body, List<int> rows, List<int>? ranked, string streamId)
        {
            if (rows.Count == 0)
            {
                return;
            }

            if (ranked is null)
            {
                if (!CaseCarriesPercent(body))
                {
                    // The streaming engines cannot number the rows of a multi-key branch or of
                    // <default>, so they build those over the whole run and read the row they
                    // want. This engine has to do the same or the two would answer differently
                    // on a config neither of them refuses.
                    IReadOnlyList<string> whole = CaseValues(
                        body, count, prng, ctx, new PerRow.Stream(ctx.Config.Seed, streamId, null));
                    foreach (int row in rows)
                    {
                        result[row] = whole[row];
                    }

                    return;
                }

                // It declares a share, so the streaming engines refuse it and the router sends
                // the whole config here: no other engine will ever produce this column, and it
                // is free to be exact. The quota goes over the branch's OWN rows, in row order.
                IReadOnlyList<string> exact = CaseValues(
                    body, rows.Count, prng, ctx,
                    new PerRow.Stream(ctx.Config.Seed, streamId, rows.ToArray()));
                for (int local = 0; local < rows.Count; local++)
                {
                    result[rows[local]] = exact[local];
                }

                return;
            }

            IReadOnlyList<string> values = CaseValues(
                body, ranked.Count, prng, ctx,
                new PerRow.Stream(ctx.Config.Seed, streamId, ranked.ToArray()));
            for (int local = 0; local < ranked.Count; local++)
            {
                result[ranked[local]] = values[local];
            }
        }

        for (int e = 0; e < spec.Entries.Count; e++)
        {
            SwitchEntry entry = spec.Entries[e];
            Place(
                entry.Value, entryRows[e],
                RankedBranchRows(spec.On, entry.Keys, entryRows[e], layouts),
                $"{name}#sw{e}");
        }

        if (spec.Fallback is not null)
        {
            // <default> holds the rows no entry matched — a complement, which no layout
            // enumerates.
            Place(spec.Fallback, fallbackRows, null, $"{name}#swdef");
        }

        return result;
    }

    /// <summary>A <c>&lt;switch&gt;</c> written inside a <c>&lt;case&gt;</c> — the nested form.</summary>
    /// <remarks>
    /// It looks its subject up over THE ROWS OF THE BRANCH IT SITS IN. <c>stream</c> already
    /// carries those rows and this part's name, so position <c>i</c> here is the same cell the
    /// streaming engine resolves at the absolute row.
    /// <para>
    /// A branch of a nested switch is never RANKED: its rows are an intersection of two
    /// partitions — the enclosing branch's and the inner subject's — and the streaming engines
    /// cannot number an intersection one row at a time. A branch that declares a share is refused
    /// there, the router sends the config here, and the quota goes over the branch's own rows.
    /// One that declares none is built over the enclosing branch's rows, which is what the
    /// streaming engines do.
    /// </para>
    /// </remarks>
    private static IReadOnlyList<string> NestedSwitchValues(
        Switch spec, int count, Sfc32 prng, Ctx ctx, PerRow.Stream? stream)
    {
        string streamId = stream?.Id ?? "";
        string[]? subject = null;
        ctx.Columns?.TryGetValue(spec.On, out subject);

        var entryPositions = new List<List<int>>();
        for (int e = 0; e < spec.Entries.Count; e++)
        {
            entryPositions.Add(new List<int>());
        }

        var fallbackPositions = new List<int>();
        for (int i = 0; i < count; i++)
        {
            int row = stream?.RowAt(i) ?? i;
            string key = subject is null || row >= subject.Length || subject[row] is null
                ? ""
                : subject[row];
            int picked = -1;
            for (int e = 0; e < spec.Entries.Count; e++)
            {
                if (spec.Entries[e].Keys.Contains(key))
                {
                    picked = e;
                    break;
                }
            }

            (picked < 0 ? fallbackPositions : entryPositions[picked]).Add(i);
        }

        var result = new string[count];
        Array.Fill(result, "");

        void Place(Case body, List<int> positions, string id)
        {
            if (positions.Count == 0)
            {
                return;
            }

            if (!CaseCarriesPercent(body))
            {
                IReadOnlyList<string> whole = CaseValues(
                    body, count, prng, ctx, new PerRow.Stream(ctx.Config.Seed, id, stream?.Rows));
                foreach (int i in positions)
                {
                    result[i] = whole[i];
                }

                return;
            }

            var rows = positions.Select(i => stream?.RowAt(i) ?? i).ToArray();
            IReadOnlyList<string> values = CaseValues(
                body, positions.Count, prng, ctx, new PerRow.Stream(ctx.Config.Seed, id, rows));
            for (int local = 0; local < positions.Count; local++)
            {
                result[positions[local]] = values[local];
            }
        }

        for (int e = 0; e < spec.Entries.Count; e++)
        {
            Place(spec.Entries[e].Value, entryPositions[e], $"{streamId}#sw{e}");
        }

        if (spec.Fallback is not null)
        {
            Place(spec.Fallback, fallbackPositions, $"{streamId}#swdef");
        }

        return result;
    }

    /// <summary>
    /// A switch branch's rows in the order the STREAMING engine numbers them, or <c>null</c>
    /// when it cannot number them at all.
    /// </summary>
    /// <remarks>
    /// A branch keyed <c>Male</c> of <c>&lt;switch on="Gender"&gt;</c> is the same subset as
    /// <c>parent="Gender.Male"</c>, and both engines must lay a quota over it the same way. That
    /// order is NOT row order: it is the rank inside the subject's exact layout, which is what
    /// <c>OrderedRows</c> computes for a child and what the streaming engine's
    /// <c>ChildRankAt</c> hands out. Ordering by row instead put the right COUNT of values on
    /// the wrong rows, and the two engines disagreed on a config neither of them refused.
    /// <para>
    /// <c>null</c> for a multi-key entry (<c>US|CA|MX</c>): its rows are a union of subsets, and
    /// ranks across a union do not compose from the per-value ranks.
    /// </para>
    /// </remarks>
    /// <summary>
    /// Does this <c>&lt;case&gt;</c> body declare a share the denominator has to be right for?
    /// </summary>
    private static bool CaseCarriesPercent(Case body) =>
        body.Parts.Any(part =>
            (part.Mix is not null && !string.IsNullOrWhiteSpace(part.Mix.Percent))
            || (part.Gen is not null && !string.IsNullOrWhiteSpace(part.Gen.Attr("percent"))));

    private static List<int>? RankedBranchRows(
        string on, IReadOnlyList<string> keys, List<int> rows,
        Dictionary<string, PerRow.ExactLayout> layouts)
    {
        if (keys.Count != 1 || !layouts.TryGetValue(on, out PerRow.ExactLayout? plan))
        {
            return null;
        }

        int vi = -1;
        for (int i = 0; i < plan.Values.Count; i++)
        {
            if (plan.Values[i] == keys[0])
            {
                vi = i;
                break;
            }
        }

        if (vi < 0)
        {
            return null;
        }

        int lo = plan.CumHi[vi] - plan.Counts[vi];
        var ordered = new List<int>(Enumerable.Repeat(-1, rows.Count));
        foreach (int row in rows)
        {
            if (!plan.SlotByRow.TryGetValue(row, out int slot))
            {
                return null;
            }

            int rank = slot - lo;
            if (rank < 0 || rank >= ordered.Count)
            {
                return null;
            }

            ordered[rank] = row;
        }

        return ordered.Contains(-1) ? null : ordered;
    }

    /// <summary>
    /// A column drawn from a named distribution.
    /// </summary>
    /// <remarks>
    /// Every row takes the SAME number of uniforms, however the distribution is shaped. That is
    /// not an implementation detail: a variable draw count would make a row depend on the rows
    /// before it, and the streaming engines could not then compute row nine million on its own.
    /// </remarks>
    private static IReadOnlyList<string> Distribute(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng)
    {
        Distributions.Spec spec = Distributions.Parse(attrs);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            var uniforms = new double[spec.Draws];
            for (int d = 0; d < spec.Draws; d++)
            {
                uniforms[d] = Seekable.OpenUnit(prng.Next());
            }

            result.Add(Distributions.Format(Distributions.Sample(spec, uniforms), spec));
        }

        return result;
    }

    /// <summary>What a finished value still goes through: the mask and the case transform.</summary>
    /// <summary>
    /// The passes that run over a finished column, in this order: outliers, then blanks, then
    /// formatting.
    /// </summary>
    /// <remarks>
    /// The order is the contract. Spiking after blanking would multiply an empty string, and
    /// formatting before either would format a value that is about to be replaced.
    /// </remarks>
    /// <summary>
    /// One generator's finished values for a whole column, keyed the way the streaming engine
    /// keys them.
    /// </summary>
    /// <remarks>
    /// Three shapes, and which one applies is the streaming engine's own split: a LISTED column
    /// — a <c>text</c> list, a weighted file column, a weighted pack — is laid out exactly over
    /// the rows and permuted, never picked per row; an independent generator is built ROW BY ROW
    /// off <c>(seed, streamId, row)</c>, with the modifiers applied inside that loop so
    /// <c>anomaly=</c> spends the row's own draw; everything else keeps the older shape.
    /// <para>Without a <paramref name="stream"/> — an inline generator, a nested pack body — all
    /// three collapse to the last, which is what those callers want.</para>
    /// </remarks>
    private static IReadOnlyList<string> ColumnValues(
        Gen gen,
        int count,
        Sfc32 prng,
        Ctx ctx,
        PerRow.Stream? stream,
        bool[]? anomalyFlags = null,
        Dictionary<string, PerRow.ExactLayout>? layouts = null)
    {
        if (stream is null)
        {
            return Finish(Generate(gen, count, prng, ctx), gen.Attrs, prng, anomalyFlags);
        }

        (IReadOnlyList<string> Values, double[] Percents)? listed = ListedValues(gen, ctx);
        if (listed is { } list)
        {
            string[] laid = PerRow.ExactTextLayout(
                list.Values, list.Percents, count, stream, layouts);
            return FinishKeyed(laid, gen, prng, anomalyFlags, stream);
        }

        // Two types the streaming engine builds INLINE: the value follows the position, and only
        // the one draw that perturbs it is keyed by the row.
        if (gen.Type == "timeseries")
        {
            return FinishKeyed(
                TimeseriesKeyed(gen.Attrs, count, stream), gen, prng, anomalyFlags, stream);
        }

        if (gen.Type == "pattern")
        {
            return FinishKeyed(
                PatternKeyed(gen.Attrs, count, ctx, stream), gen, prng, anomalyFlags, stream);
        }

        // A weighted choice inside an advanced_regex — `(?%{RU:70|US:20|DE:10})` — is a quota
        // over the column like any other share. Decided one row at a time it awards every row to
        // the largest share: 100% RU, not 70/20/10.
        bool weighted = WeightedTemplatePack(gen, ctx) is not null
            || (gen.Type == "advanced_regex"
                && AdvancedRegexGen.HasWeightedChoice(gen.Attr("value") ?? ""));
        if (PerRow.PerRowBuildable(gen, count, weighted, PackNeedsWholeColumn(gen, ctx)))
        {
            var built = new List<string>(count);
            for (int i = 0; i < count; i++)
            {
                Sfc32 rowPrng = PerRow.RowGenerator(stream, stream.RowAt(i));
                var one = new bool[1];
                IReadOnlyList<string> done = Finish(
                    Generate(gen, 1, rowPrng, ctx), gen.Attrs, rowPrng, one);
                built.Add(done.Count > 0 ? done[0] : "");
                if (anomalyFlags is not null)
                {
                    anomalyFlags[i] = one[0];
                }
            }

            return built;
        }

        return FinishKeyed(
            Generate(gen, count, prng, ctx), gen, prng, anomalyFlags, stream);
    }

    /// <summary>
    /// <see cref="Finish"/>, with the two modifier draws taken from the column's own
    /// <c>#anom</c> and <c>#miss</c> streams when the type is one the streaming engine builds
    /// inline.
    /// </summary>
    private static IReadOnlyList<string> FinishKeyed(
        IReadOnlyList<string> values,
        Gen gen,
        Sfc32 prng,
        bool[]? anomalyFlags,
        PerRow.Stream stream) =>
        PerRow.InlineAnomalyTypes.Contains(gen.Type)
            ? FinishWith(values, gen.Attrs, prng, anomalyFlags, stream)
            : Finish(values, gen.Attrs, prng, anomalyFlags);

    /// <summary>
    /// <see cref="Finish"/>, with the anomaly and missing draws taken from a stream rather than
    /// in order.
    /// </summary>
    private static IReadOnlyList<string> FinishWith(
        IReadOnlyList<string> values,
        IReadOnlyDictionary<string, string> attrs,
        Sfc32 prng,
        bool[]? anomalyFlags,
        PerRow.Stream stream)
    {
        var result = new List<string>(values);

        Imperfections.Anomaly? anomaly = Imperfections.ParseAnomaly(attrs);
        if (anomaly is { } a)
        {
            for (int i = 0; i < result.Count; i++)
            {
                bool selected = a.Probability > 0
                    && PerRow.PurposeDraw(stream, "#anom", stream.RowAt(i)) < a.Probability;
                if (anomalyFlags is not null && i < anomalyFlags.Length)
                {
                    anomalyFlags[i] = selected;
                }

                if (selected)
                {
                    result[i] = Imperfections.Spike(result[i], a.Factor);
                }
            }
        }

        Imperfections.Missing? missing = Imperfections.ParseMissing(attrs);
        if (missing is { } m && m.Probability > 0)
        {
            for (int i = 0; i < result.Count; i++)
            {
                if (PerRow.PurposeDraw(stream, "#miss", stream.RowAt(i)) < m.Probability)
                {
                    result[i] = m.Token;
                }
            }
        }

        return FormatValues(result, attrs);
    }

    /// <summary>
    /// The value list and the shares a column lays out, when its values are LISTED.
    /// </summary>
    private static (IReadOnlyList<string> Values, double[] Percents)? ListedValues(Gen gen, Ctx ctx)
    {
        if (gen.Attrs.GetValueOrDefault("order") == "sequential")
        {
            return null;
        }

        if (gen.Attrs.ContainsKey("weight"))
        {
            // `row=` links whole rows of the file; the choice is not this column's.
            if (!string.IsNullOrWhiteSpace(gen.Attrs.GetValueOrDefault("row")))
            {
                return null;
            }

            FileGen.Weighted? weighted =
                FileGen.LoadWeighted(gen.Attrs, ctx.BaseDir, ctx.Packs.DataRoots);
            return weighted is null ? null : (weighted.Values, weighted.Percents);
        }

        (IReadOnlyList<string> Values, double[] Percents)? pack = WeightedTemplatePack(gen, ctx);
        if (pack is not null)
        {
            return pack;
        }

        if (gen.Type != "text")
        {
            return null;
        }

        IReadOnlyList<string> values = SplitText(gen.Attr("value") ?? "");
        return (values, PerRow.SharesOf(gen.Attr("percent"), values.Count));
    }

    /// <summary>
    /// A <c>&lt;gen type="template"&gt;</c> pointing at a pack that carries its own shares.
    /// </summary>
    /// <remarks>
    /// A synthetic address (<c>person.b_day</c> and its kind) is resolved inside the generator
    /// and has no pack file behind it, so asking the registry would throw rather than answer.
    /// </remarks>
    private static (IReadOnlyList<string> Values, double[] Percents)? WeightedTemplatePack(
        Gen gen, Ctx ctx)
    {
        if (gen.Type != "template")
        {
            return null;
        }

        string path = gen.Attr("value") ?? "";
        if (path.Length == 0 || !ctx.Packs.Exists(path, ctx.Locale))
        {
            return null;
        }

        DataPacks.Entry entry = ctx.Packs.Load(path, ctx.Locale);
        return entry.Weighted && entry.Percents is not null
            ? (entry.Values, entry.Percents)
            : null;
    }

    /// <summary>
    /// Whether a pack GENERATOR apportions a share over the whole column. Its values are
    /// computed rather than listed, so there is no list to lay out.
    /// </summary>
    private static bool PackNeedsWholeColumn(Gen gen, Ctx ctx)
    {
        if (gen.Type != "template")
        {
            return false;
        }

        string path = gen.Attr("value") ?? "";
        return path.Length != 0
            && ctx.Packs.Exists(path, ctx.Locale)
            && ctx.Packs.NeedsWholeColumn(path, ctx.Locale);
    }

    /// <summary>
    /// <c>&lt;gen type="timeseries" noise=…&gt;</c> keyed by the row.
    /// </summary>
    /// <remarks>
    /// The value follows the POSITION — a series read at a point of the run — while the noise
    /// follows the ROW, on the dedicated <c>:ts</c> stream the streaming engine uses. Same two
    /// names, same two uniforms, same series.
    /// </remarks>
    private static IReadOnlyList<string> TimeseriesKeyed(
        IReadOnlyDictionary<string, string> attrs, int count, PerRow.Stream stream)
    {
        Stats.Timeseries.Spec spec = Stats.Timeseries.Parse(attrs);
        bool noisy = spec.HasNoise;
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            double z = 0;
            if (noisy)
            {
                double[] u = Seekable.Uniforms(
                    stream.Seed, $"{stream.Id}:ts", stream.RowAt(i), 2);
                z = Stats.Timeseries.StandardNormal(u[0], u[1]);
            }

            result.Add(Distributions.ToFixed(Stats.Timeseries.ValueAt(spec, i, z), spec.Decimals));
        }

        return result;
    }

    /// <summary>
    /// <c>&lt;gen type="pattern"&gt;</c> keyed by the row.
    /// </summary>
    /// <remarks>
    /// As with timeseries: the curve is read at the POSITION, and the one draw that places the
    /// value inside its band is keyed by the ROW on the streaming engine's <c>:pat</c> stream.
    /// </remarks>
    private static IReadOnlyList<string> PatternKeyed(
        IReadOnlyDictionary<string, string> attrs, int count, Ctx ctx, PerRow.Stream stream)
    {
        Pattern.PatternGen gen = Pattern.PatternGen.Of(attrs, ctx.BaseDir, ctx.Packs.DataRoots);
        bool draws = gen.Draws;
        double denom = count > 1 ? count - 1 : 1;
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            double u = draws
                ? Seekable.Uniforms(stream.Seed, $"{stream.Id}:pat", stream.RowAt(i), 1)[0]
                : 0;
            result.Add(gen.ValueAt(i / denom, u, 1 / denom));
        }

        return result;
    }

    /// <summary>
    /// <c>anomaly=</c>, <c>missing=</c> and the formatting layer for ONE element of a repeating
    /// LISTED column.
    /// </summary>
    /// <remarks>
    /// The two probability draws come off the row's <c>#anom</c> and <c>#miss</c> streams with a
    /// budget of the row's maximum length, so element k always gets the same uniform however
    /// long its row turned out to be.
    /// </remarks>
    private static Func<int, string, int, string>? ElementModifier(
        Gen gen, Repeat.Spec spec, PerRow.Stream stream)
    {
        Imperfections.Anomaly? anomaly = Imperfections.ParseAnomaly(gen.Attrs);
        Imperfections.Missing? missing = Imperfections.ParseMissing(gen.Attrs);
        string? mask = gen.Attrs.GetValueOrDefault("mask");
        string? kase = gen.Attrs.GetValueOrDefault("case");
        bool hasAnomaly = anomaly is { Probability: > 0 };
        bool hasMissing = missing is { Probability: > 0 };
        bool hasFormat = mask is not null || (kase is not null && Transforms.IsCaseTransform(kase));
        if (!hasAnomaly && !hasMissing && !hasFormat)
        {
            return null;
        }

        int budget = Math.Max(1, spec.Max);
        Func<int, int, double>? anomalyAt =
            hasAnomaly ? RepeatKeyed.ElementUniforms(stream, "#anom", budget) : null;
        Func<int, int, double>? missingAt =
            hasMissing ? RepeatKeyed.ElementUniforms(stream, "#miss", budget) : null;

        return (row, value, k) =>
        {
            string result = value;
            if (anomalyAt is not null && anomalyAt(row, k) < anomaly!.Value.Probability)
            {
                result = Imperfections.Spike(result, anomaly.Value.Factor);
            }

            if (missingAt is not null && missingAt(row, k) < missing!.Value.Probability)
            {
                result = missing.Value.Token;
            }

            if (mask is not null)
            {
                result = Mask.Apply(mask, result);
            }

            if (kase is not null && Transforms.IsCaseTransform(kase))
            {
                result = Transforms.ApplyCase(kase, result);
            }

            return result;
        };
    }

    internal static IReadOnlyList<string> Finish(
        IReadOnlyList<string> values, IReadOnlyDictionary<string, string> attrs, Sfc32 prng,
        bool[]? anomalyFlags = null)
    {
        var result = new List<string>(values);

        Imperfections.Anomaly? anomaly = Imperfections.ParseAnomaly(attrs);
        if (anomaly is not null)
        {
            Imperfections.ApplyAnomaly(result, anomaly.Value, prng, anomalyFlags);
        }

        Imperfections.Missing? missing = Imperfections.ParseMissing(attrs);
        if (missing is not null)
        {
            Imperfections.ApplyMissing(result, missing.Value, prng);
        }

        return FormatValues(result, attrs);
    }

    /// <summary>
    /// <c>case=</c> and <c>mask=</c>, which reach the same code the <c>|upper</c> and
    /// <c>|mask:</c> filters do so the three ways of asking cannot drift apart.
    /// </summary>
    private static IReadOnlyList<string> FormatValues(
        List<string> result, IReadOnlyDictionary<string, string> attrs)
    {
        string? mask = attrs.GetValueOrDefault("mask");
        string? kase = attrs.GetValueOrDefault("case");
        if (mask is null && kase is null)
        {
            return result;
        }

        for (int i = 0; i < result.Count; i++)
        {
            string v = mask is null ? result[i] : Mask.Apply(mask, result[i]);
            result[i] = kase is null ? v : Transforms.ApplyCase(kase, v);
        }

        return result;
    }

    /// <summary>
    /// Element <c>index mod N</c>, or a refusal once the data runs out under <c>cycle="false"</c>.
    /// </summary>
    /// <remarks>
    /// Looping is the default because a short list walked over many rows is the ordinary case —
    /// twelve months across a year of daily records. <c>cycle="false"</c> is for when running out is
    /// a mistake worth hearing about rather than something to paper over by starting again.
    /// </remarks>
    /// <summary>
    /// Which of <c>size</c> positions row <c>index</c> reads, wrapping unless
    /// <c>cycle="false"</c>.
    /// </summary>
    /// <remarks>
    /// Split out of <see cref="PickSequential"/> because a walked date range has positions without
    /// having a list: its values are computed from an index, and only this part applies.
    /// </remarks>
    internal static long SequentialIndex(long size, long index, bool cycle)
    {
        if (size <= 0)
        {
            return 0;
        }

        if (!cycle && index >= size)
        {
            throw new InvalidOperationException(
                $"order=\"sequential\" cycle=\"false\": the source has only {size} "
                + $"values, so row {index + 1} has none — shorten count= or lengthen the source");
        }

        return index % size;
    }

    internal static string PickSequential(IReadOnlyList<string> list, int index, bool cycle) =>
        list.Count == 0 ? "" : list[(int)SequentialIndex(list.Count, index, cycle)];

    internal static IReadOnlyList<string> SplitText(string value) =>
        value.Split(',').Select(p => p.Trim()).ToArray();

    private static void Emit(
        StringBuilder to, IReadOnlyDictionary<string, Repeat.Spec> eachInfo,
        IReadOnlyList<Line> lines,
        IReadOnlyDictionary<string, string[]> columns, int row, string? inject)
    {
        foreach (Line line in lines)
        {
            to.Append(RenderLine(line, columns, row, inject, eachInfo));
        }
    }

    /// <summary>
    /// One line — or, with <c>each="NAME"</c>, one line per element of that list.
    /// </summary>
    /// <remarks>
    /// Returns the text with its newline already attached, because a line with <c>each</c> may
    /// produce several and a list with nothing in it must produce none at all: a customer with no
    /// orders leaves no blank row behind.
    /// </remarks>
    private static string RenderLine(
        Line line, IReadOnlyDictionary<string, string[]> columns, int row, string? inject,
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo)
    {
        var text = new StringBuilder();
        foreach (DataPart part in line.Parts)
        {
            if (part.IfExpr is null || Condition(part.IfExpr, columns, row))
            {
                text.Append(part.Text);
            }
        }

        string template = text.ToString();
        string? listName = line.Each?.Trim();
        if (string.IsNullOrEmpty(listName))
        {
            return Interpolate.Apply(template, inject, new RowLookup(columns, row)) + "\n";
        }

        Repeat.Spec? spec = eachInfo.TryGetValue(listName, out Repeat.Spec found) ? found : null;
        string cell = columns.TryGetValue(listName, out string[]? column) && column[row] is not null
            ? column[row]
            : "";
        IReadOnlyList<string> elements =
            Repeat.Split(cell, spec?.Separator ?? Repeat.DefaultSeparator);

        // Lanes: two repeating sequences write into the same child table, so each gets its own
        // slice of every card's key block rather than sharing one counter.
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
                    template, inject,
                    new ElementLookup(columns, row, listName, elements[k], k + 1, lane, stride)))
                .Append('\n');
        }

        return result.ToString();
    }

    /// <summary>
    /// The repeating sequences, indexed by name.
    /// </summary>
    /// <remarks>A name that is not here is not a list, so <c>each=</c> on it walks nothing.</remarks>
    private static IReadOnlyDictionary<string, Repeat.Spec> EachInfo(Config config)
    {
        var result = new Dictionary<string, Repeat.Spec>(StringComparer.Ordinal);
        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.Gen is not null && Repeat.Parse(spec.Gen.Attrs) is { } repeat)
            {
                result[spec.Name] = repeat;
            }
        }

        return result;
    }

    /// <summary>
    /// The row's view with one element of a list substituted for the list itself, plus the two
    /// positional built-ins <c>_item</c> and <c>_item_id</c>.
    /// </summary>
    /// <remarks>
    /// Shallow on purpose: every other column still resolves per record, which is exactly what makes
    /// a foreign key on the repeated line point at the right parent on every emitted row.
    /// </remarks>
    private sealed class ElementLookup : Interpolate.ILookup
    {
        private readonly RowLookup _base;
        private readonly Dictionary<string, string> _overlay;

        internal ElementLookup(
            IReadOnlyDictionary<string, string[]> columns, int row, string listName, string element,
            int position, int lane, int stride)
        {
            _base = new RowLookup(columns, row);
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

    private sealed class RowLookup : Interpolate.ILookup
    {
        private readonly IReadOnlyDictionary<string, string[]> _columns;
        private readonly int _row;

        internal RowLookup(IReadOnlyDictionary<string, string[]> columns, int row)
        {
            _columns = columns;
            _row = row;
        }

        public bool Has(string name) => _columns.ContainsKey(name);

        public string Value(string name)
        {
            string[] column = _columns[name];
            return _row < column.Length ? column[_row] : "";
        }
    }
}
