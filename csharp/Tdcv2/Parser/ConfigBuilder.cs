using Antlr4.Runtime.Tree;
using Tdcv2.Model;

namespace Tdcv2.Parser;

/// <summary>Turns a parse tree into the <see cref="Config"/> the engine reads.</summary>
public static class ConfigBuilder
{
    private const int DefaultCount = 10;
    private const string DefaultLocale = "en";
    private const string DefaultInject = "${{%}}";

    /// <summary>The cap on what one regex generator may expand to, when nothing says otherwise.</summary>
    public const int DefaultRegexMaxLength = 32;

    /// <summary>The whole config, as the engines need it.</summary>
    /// <param name="defaultLocale">
    /// Fills in for a config that declares no <c>&lt;env local="…"&gt;</c> — it comes from the
    /// project's <c>tdcv2.config.json</c>, and it is a DEFAULT, never an override. Letting it beat
    /// what the config declares would make a config that says <c>local="ru"</c> produce English
    /// wherever a config file existed, which <c>init</c> always writes.
    /// </param>
    public static Config Build(
        TDCParser.DocumentContext document, string? defaultLocale = null)
    {
        TDCParser.OpenCloseElementContext? tdc = FindElement(document, "tdc")
            ?? throw new ArgumentException("document has no <tdc> root element");

        TDCParser.OpenCloseElementContext? env = FindElement(tdc.content(), "env");
        IReadOnlyDictionary<string, string> envAttrs =
            env is null ? new Dictionary<string, string>() : Attributes(env.attr());

        // regex_max_length sits on <tdc>, not <env>: it is a safety limit for the whole document
        // rather than a property of one run's data.
        int regexMaxLength = ParseMaxLength(Attributes(tdc.attr()).GetValueOrDefault("regex_max_length"));

        int count = DefaultCount;
        if (envAttrs.TryGetValue("count", out string? rawCount))
        {
            count = int.Parse(rawCount.Trim(), System.Globalization.CultureInfo.InvariantCulture);
        }

        var sequences = new List<SequenceSpec>();
        IReadOnlyList<Line> before = Array.Empty<Line>();
        IReadOnlyList<Line> after = Array.Empty<Line>();
        IReadOnlyList<Line> beforeBlock = Array.Empty<Line>();
        IReadOnlyList<Line> afterBlock = Array.Empty<Line>();
        IReadOnlyList<Line> delimiterBlock = Array.Empty<Line>();
        IReadOnlyList<Line> beforeLine = Array.Empty<Line>();
        IReadOnlyList<Line> afterLine = Array.Empty<Line>();
        IReadOnlyList<Line> delimiterLine = Array.Empty<Line>();

        var envUniq = new List<IReadOnlyList<string>>();
        var envDistinct = new List<IReadOnlyList<string>>();
        var pools = new List<PoolSpec>();

        if (env is not null)
        {
            foreach (TDCParser.ElementContext child in env.content().element())
            {
                TDCParser.OpenCloseElementContext open = child.openCloseElement();
                if (open is null)
                {
                    continue;
                }

                switch (open.name.Text)
                {
                    case "sequence":
                        sequences.Add(Sequence(open));
                        break;

                    case "pool":
                        pools.Add(Pool(open));
                        break;

                    // <uniq> and <distinct> around whole sequences, rather than around the fields
                    // of one. The wrapper says what must hold between them; its children are
                    // ordinary sequences.
                    case "uniq":
                    {
                        IReadOnlyList<string> group = WrappedSequences(open, sequences);
                        if (group.Count >= 2)
                        {
                            envUniq.Add(group);
                        }

                        break;
                    }

                    case "distinct":
                    {
                        IReadOnlyList<string> group = WrappedSequences(open, sequences);
                        if (group.Count >= 2)
                        {
                            envDistinct.Add(group);
                        }

                        break;
                    }

                    case "mix":
                        sequences.Add(MixSequence(open));
                        break;
                    case "switch":
                        sequences.Add(SwitchSequence(open));
                        break;
                    case "before":
                        before = Lines(open.content());
                        break;
                    case "after":
                        after = Lines(open.content());
                        break;
                    case "before_block":
                        beforeBlock = Lines(open.content());
                        break;
                    case "after_block":
                        afterBlock = Lines(open.content());
                        break;
                    case "delimiter_block":
                        delimiterBlock = Lines(open.content());
                        break;
                    case "before_line":
                        beforeLine = Lines(open.content());
                        break;
                    case "after_line":
                        afterLine = Lines(open.content());
                        break;
                    case "delimiter_line":
                        delimiterLine = Lines(open.content());
                        break;
                    default:
                        // Anything else in <env> is not modelled yet. Silence here is a known gap,
                        // not a decision that it is unimportant — the fixtures that use it will
                        // surface it.
                        break;
                }
            }
        }

        TDCParser.OpenCloseElementContext? block = FindElement(tdc.content(), "block")
            ?? throw new ArgumentException("<tdc> has no <block> child — nothing to render");

        return new Config(
            count,
            envAttrs.GetValueOrDefault("seed") ?? "",
            envAttrs.GetValueOrDefault("local")
                ?? (string.IsNullOrWhiteSpace(defaultLocale) ? DefaultLocale : defaultLocale),
            envAttrs.GetValueOrDefault("inject") ?? DefaultInject,
            regexMaxLength,
            sequences,
            Lines(block.content()),
            new Fixtures(
                before, after, beforeBlock, afterBlock, delimiterBlock, beforeLine, afterLine,
                delimiterLine),
            envAttrs.GetValueOrDefault("mode"),
            envAttrs.GetValueOrDefault("engine"),
            envUniq,
            envDistinct,
            pools);
    }

    /// <summary>
    /// A <c>&lt;pool&gt;</c>, read with the very same walk its enclosing <c>&lt;env&gt;</c> gets.
    ///
    /// That is the whole design in one method: nothing here knows what a member is, because a
    /// member of a pool is a member of an <c>&lt;env&gt;</c>. Lenient about a missing name or an
    /// unreadable count — the validator is what says so, and declaring the failure twice lets
    /// the two drift apart.
    /// </summary>
    private static PoolSpec Pool(TDCParser.OpenCloseElementContext node)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(node.attr());
        int count = int.TryParse(
            (attrs.GetValueOrDefault("count") ?? "").Trim(),
            out int parsed)
            ? parsed
            : 0;

        var sequences = new List<SequenceSpec>();
        var uniq = new List<IReadOnlyList<string>>();
        var distinct = new List<IReadOnlyList<string>>();
        foreach (TDCParser.ElementContext child in node.content().element())
        {
            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            if (inner is null)
            {
                continue;
            }

            switch (inner.name.Text)
            {
                case "sequence":
                    sequences.Add(Sequence(inner));
                    break;
                case "mix":
                    sequences.Add(MixSequence(inner));
                    break;
                case "switch":
                    sequences.Add(SwitchSequence(inner));
                    break;
                case "uniq":
                {
                    IReadOnlyList<string> group = WrappedSequences(inner, sequences);
                    if (group.Count >= 2)
                    {
                        uniq.Add(group);
                    }

                    break;
                }

                case "distinct":
                {
                    IReadOnlyList<string> group = WrappedSequences(inner, sequences);
                    if (group.Count >= 2)
                    {
                        distinct.Add(group);
                    }

                    break;
                }
            }
        }

        return new PoolSpec(
            attrs.GetValueOrDefault("name") ?? "",
            count,
            sequences,
            uniq,
            distinct);
    }

    /// <summary>A positive <c>regex_max_length</c>, or the default when the attribute is absent.</summary>
    public static int ParseMaxLength(string? raw)
    {
        if (raw is null)
        {
            return DefaultRegexMaxLength;
        }

        if (!int.TryParse(raw.Trim(), System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out int value) || value <= 0)
        {
            throw new ArgumentException($"regex_max_length must be a positive integer, got \"{raw}\"");
        }

        return value;
    }

    /// <summary>
    /// The sequences inside an env-level <c>&lt;uniq&gt;</c> or <c>&lt;distinct&gt;</c>, declared
    /// as they go.
    /// </summary>
    /// <remarks>
    /// Wrapping changes what must hold between them, not what they are, so each is built exactly
    /// as it would have been on its own and the wrapper keeps only the names.
    /// </remarks>
    private static IReadOnlyList<string> WrappedSequences(
        TDCParser.OpenCloseElementContext wrapper, List<SequenceSpec> sequences)
    {
        var names = new List<string>();
        foreach (TDCParser.ElementContext inner in wrapper.content().element())
        {
            TDCParser.OpenCloseElementContext open = inner.openCloseElement();
            if (open is null)
            {
                continue;
            }

            // A <mix> is a member like any other: a group rearranges whole columns between
            // rows, and a mix keeps its value multiset whatever the order, so its percentages
            // survive the move. A <switch> joins too, but the group may only move its value
            // between rows that share a subject.
            SequenceSpec spec;
            if (open.name.Text == "sequence")
            {
                spec = Sequence(open);
            }
            else if (open.name.Text == "mix")
            {
                spec = MixSequence(open);
            }
            else if (open.name.Text == "switch")
            {
                spec = SwitchSequence(open);
            }
            else
            {
                continue;
            }

            sequences.Add(spec);
            if (!string.IsNullOrEmpty(spec.Name))
            {
                names.Add(spec.Name);
            }
        }

        return names;
    }

    /// <summary>A standalone <c>&lt;mix name="…"&gt;</c> in <c>&lt;env&gt;</c> is a sequence.</summary>
    /// <summary>One <c>&lt;gen&gt;</c> as a body item: a field when named, a drawn part otherwise.</summary>
    private static Item ItemOf(IReadOnlyDictionary<string, string> attrs, ref int unnamed)
    {
        var gen = new Gen(attrs.GetValueOrDefault("type") ?? "", attrs);
        string? fieldName = attrs.GetValueOrDefault("name");
        if (!string.IsNullOrEmpty(fieldName))
        {
            return new Item(Field: new Field(fieldName, gen));
        }

        unnamed++;
        return new Item(Gen: gen);
    }

    private static SequenceSpec MixSequence(TDCParser.OpenCloseElementContext element)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(element.attr());
        return new SequenceSpec(
            attrs.GetValueOrDefault("name") ?? "",
            attrs.GetValueOrDefault("parent"),
            null,
            Mix: MixOf(element));
    }

    private static Mix MixOf(TDCParser.OpenCloseElementContext element)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(element.attr());
        var cases = new List<Case>();
        foreach (TDCParser.ElementContext child in element.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "case")
            {
                cases.Add(CaseSpec(open));
            }
        }

        return new Mix(attrs.GetValueOrDefault("percent"), attrs.GetValueOrDefault("flag"), cases);
    }

    /// <summary>A case body: literal text, generators and nested mixes, concatenated in order.</summary>
    private static Case CaseSpec(TDCParser.OpenCloseElementContext element)
    {
        var parts = new List<CasePart>();
        foreach (TDCParser.ElementContext child in element.content().element())
        {
            if (child.dataElement() is TDCParser.DataWithBodyContext body)
            {
                parts.Add(new CasePart(
                    PairedData.Restore(body.dataContent().GetText()), null, null));
                continue;
            }

            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                IReadOnlyDictionary<string, string> genAttrs = Attributes(self.attr());
                parts.Add(new CasePart(
                    null, new Gen(genAttrs.GetValueOrDefault("type") ?? "", genAttrs), null));
                continue;
            }

            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "mix")
            {
                parts.Add(new CasePart(null, null, MixOf(open)));
            }
        }

        return new Case(parts, Attributes(element.attr()).GetValueOrDefault("anomaly") == "true");
    }

    private static SequenceSpec SwitchSequence(TDCParser.OpenCloseElementContext element)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(element.attr());
        var entries = new List<SwitchEntry>();
        Case? fallback = null;

        foreach (TDCParser.ElementContext child in element.content().element())
        {
            TDCParser.MapElementContext mapEl = child.mapElement();
            if (mapEl is not null)
            {
                entries.AddRange(MapEntries(MapText(mapEl)));
                continue;
            }

            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null)
            {
                continue;
            }

            switch (open.name.Text)
            {
                case "case":
                {
                    IReadOnlyList<string> keys =
                        SplitKeys(Attributes(open.attr()).GetValueOrDefault("is") ?? "");
                    if (keys.Count > 0)
                    {
                        entries.Add(new SwitchEntry(keys, CaseSpec(open)));
                    }

                    break;
                }

                case "default":
                    fallback = CaseSpec(open);
                    break;
                default:
                    // Nothing else is meaningful inside a <switch>; the validator names it.
                    break;
            }
        }

        return new SequenceSpec(
            attrs.GetValueOrDefault("name") ?? "",
            attrs.GetValueOrDefault("parent"),
            null,
            SwitchSpec: new Switch(attrs.GetValueOrDefault("on") ?? "", entries, fallback));
    }

    /// <summary>The raw body of a <c>&lt;map&gt;</c>; a self-closing one carries none.</summary>
    private static string MapText(TDCParser.MapElementContext element) =>
        element is TDCParser.MapWithBodyContext body ? body.mapContent().GetText() : "";

    /// <summary>
    /// A compact <c>&lt;map&gt;</c> table: comma-separated rows of <c>KEYS:VALUE</c>.
    /// </summary>
    /// <remarks>
    /// Split on the <em>first</em> colon only, so a value may contain colons — a time of day or a
    /// namespaced identifier survives on the right-hand side.
    /// </remarks>
    private static IReadOnlyList<SwitchEntry> MapEntries(string text)
    {
        var result = new List<SwitchEntry>();
        foreach (string rawRow in text.Split(','))
        {
            string row = rawRow.Trim();
            if (row.Length == 0)
            {
                continue;
            }

            int colon = row.IndexOf(':');
            if (colon < 0)
            {
                continue;
            }

            IReadOnlyList<string> keys = SplitKeys(row[..colon]);
            if (keys.Count == 0)
            {
                continue;
            }

            string value = row[(colon + 1)..].Trim();
            result.Add(new SwitchEntry(
                keys, new Case(new[] { new CasePart(value, null, null) }, false)));
        }

        return result;
    }

    /// <summary><c>US|CA|MX</c> — any one of them selects the entry.</summary>
    private static IReadOnlyList<string> SplitKeys(string raw) =>
        raw.Split('|').Select(k => k.Trim()).Where(k => k.Length > 0).ToArray();

    private static SequenceSpec Sequence(TDCParser.OpenCloseElementContext element)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(element.attr());
        string name = attrs.GetValueOrDefault("name") ?? "";
        string? parent = attrs.GetValueOrDefault("parent");

        var gens = new List<IReadOnlyDictionary<string, string>>();
        var distinctGroups = new List<IReadOnlyList<string>>();
        // The body in source order, kept beside `gens` so the ordinary shapes are read exactly as
        // they were and only a body that composes takes the new path.
        var items = new List<Item>();
        bool sawData = false;
        int unnamedGens = 0;

        foreach (TDCParser.ElementContext child in element.content().element())
        {
            if (child.dataElement() is TDCParser.DataWithBodyContext data)
            {
                sawData = true;
                string text = PairedData.Restore(data.dataContent().GetText());
                string? constantName = Attributes(data.attr()).GetValueOrDefault("name");
                if (!string.IsNullOrEmpty(constantName))
                {
                    items.Add(new Item(Text: text, ConstantName: constantName));
                }
                else if (text.Length > 0)
                {
                    items.Add(new Item(Text: text));
                }

                continue;
            }

            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                IReadOnlyDictionary<string, string> genAttrs = Attributes(self.attr());
                items.Add(ItemOf(genAttrs, ref unnamedGens));
                gens.Add(genAttrs);
                continue;
            }

            // A <distinct> wrapper holds gens that must differ from each other within one row. Its
            // children are ordinary fields of the compound; the wrapper only records the constraint.
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "distinct")
            {
                var group = new List<string>();
                foreach (TDCParser.ElementContext inner in open.content().element())
                {
                    TDCParser.SelfClosingElementContext innerGen = inner.selfClosingElement();
                    if (innerGen is not null && innerGen.name.Text == "gen")
                    {
                        IReadOnlyDictionary<string, string> genAttrs = Attributes(innerGen.attr());
                        items.Add(ItemOf(genAttrs, ref unnamedGens));
                        gens.Add(genAttrs);
                        string? fieldName = genAttrs.GetValueOrDefault("name");
                        if (!string.IsNullOrEmpty(fieldName))
                        {
                            group.Add(fieldName);
                        }
                    }
                }

                // A group of one carries no constraint — there is nothing for it to differ from.
                if (group.Count >= 2)
                {
                    distinctGroups.Add(group);
                }
            }
        }

        // A <compute> sequence derives its value instead of drawing one, so it has no <gen> at all.
        // This is how a check digit lives as editable pack data rather than as engine code.
        TDCParser.OpenCloseElementContext? compute = FindElement(element.content(), "compute");
        if (compute is not null)
        {
            return new SequenceSpec(name, parent, null, Compute: compute);
        }

        if (gens.Count == 0)
        {
            throw new ArgumentException($"sequence \"{name}\" has no <gen> child");
        }

        // Conditional is checked first, so a branch written as `<gen if="...">` is not asked for a
        // name it has no use for.
        if (gens.Any(g => g.ContainsKey("if")))
        {
            var branches = new List<Branch>();
            foreach (IReadOnlyDictionary<string, string> g in gens)
            {
                var genAttrs = new Dictionary<string, string>(g.ToDictionary(e => e.Key, e => e.Value));
                // `if` is the branch's condition, not a setting the generator should see.
                genAttrs.Remove("if", out string? condition);
                branches.Add(new Branch(
                    condition, new Gen(genAttrs.GetValueOrDefault("type") ?? "", genAttrs)));
            }

            return new SequenceSpec(name, parent, null, Branches: branches);
        }

        // Composed when the body is not simply one unnamed gen or a set of named ones: the unnamed
        // gens and the literals build the sequence's own value and the named ones stay fields beside
        // it. Checked before compound, because a body with both readings is the composed one — that
        // is where ${{Name}} gets a value.
        if (sawData || (unnamedGens > 0 && gens.Count > 1))
        {
            return new SequenceSpec(
                name, parent, null, Items: items,
                DistinctGroups: distinctGroups.Count == 0 ? null : distinctGroups,
                Uniq: attrs.GetValueOrDefault("uniq") == "true");
        }

        // Compound when there is more than one gen, or when the only one is named — the second case
        // lets a one-field compound be written deliberately.
        if (gens.Count > 1 || gens[0].ContainsKey("name"))
        {
            var fields = new List<Field>();
            foreach (IReadOnlyDictionary<string, string> g in gens)
            {
                string? fieldName = g.GetValueOrDefault("name");
                if (string.IsNullOrEmpty(fieldName))
                {
                    continue;
                }

                fields.Add(new Field(fieldName, new Gen(g.GetValueOrDefault("type") ?? "", g)));
            }

            return new SequenceSpec(
                name,
                parent,
                null,
                Fields: fields,
                DistinctGroups: distinctGroups.Count == 0 ? null : distinctGroups,
                Uniq: attrs.GetValueOrDefault("uniq") == "true");
        }

        IReadOnlyDictionary<string, string> only = gens[0];
        // `uniq` travels to the simple shape too — a draw without replacement
        // (Engine/UniqSimple.cs); dropping it silently was the bug that made
        // 100 "unique" names repeat.
        return new SequenceSpec(
            name,
            parent,
            new Gen(only.GetValueOrDefault("type") ?? "", only),
            Uniq: attrs.GetValueOrDefault("uniq") == "true");
    }

    /// <summary>Every <c>&lt;line&gt;</c> under a container, each flattened to its data text.</summary>
    private static IReadOnlyList<Line> Lines(TDCParser.ContentContext? content)
    {
        var result = new List<Line>();
        if (content is null)
        {
            return result;
        }

        foreach (TDCParser.ElementContext child in content.element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null || open.name.Text != "line")
            {
                continue;
            }

            var parts = new List<DataPart>();
            foreach (TDCParser.ElementContext inner in open.content().element())
            {
                if (inner.dataElement() is TDCParser.DataWithBodyContext body)
                {
                    IReadOnlyDictionary<string, string> dataAttrs = Attributes(body.attr());
                    parts.Add(new DataPart(
                        PairedData.Restore(body.dataContent().GetText()),
                        dataAttrs.GetValueOrDefault("if"),
                        dataAttrs.GetValueOrDefault("name"),
                        dataAttrs.GetValueOrDefault("type")));
                }
            }

            IReadOnlyDictionary<string, string> lineAttrs = Attributes(open.attr());
            result.Add(new Line(
                parts, lineAttrs.GetValueOrDefault("if"), lineAttrs.GetValueOrDefault("each")));
        }

        return result;
    }


    /// <summary>
    /// A pack whose body is a lone <c>&lt;gen&gt;</c> tag rather than a list of values.
    /// </summary>
    /// <remarks>
    /// Some things cannot be listed — every UUID, every account number — so the pack ships the rule
    /// that makes one instead. It is written in the same language a config is, and parsed by the
    /// same grammar, so a pack author needs no second dialect.
    /// </remarks>
    public static Gen ParseGenTag(string source)
    {
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(source);
        if (!parsed.Ok)
        {
            throw new ArgumentException(
                "pack generator did not parse: " + string.Join("; ", parsed.Problems));
        }

        foreach (TDCParser.ElementContext element in parsed.Tree.element())
        {
            TDCParser.SelfClosingElementContext self = element.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                IReadOnlyDictionary<string, string> attrs = Attributes(self.attr());
                return new Gen(attrs.GetValueOrDefault("type", ""), attrs);
            }
        }

        throw new ArgumentException($"pack generator body has no <gen> tag: {source}");
    }

    /// <summary>
    /// A composed pack generator: local sequences, an output template, and an optional
    /// <c>&lt;valid&gt;</c> predicate.
    /// </summary>
    /// <remarks>
    /// This is how an identifier with a check digit is expressed as editable data rather than as
    /// engine code: the pack declares the parts, computes the digit, and names the shape they join
    /// into.
    /// </remarks>
    public sealed record PackGenerator(
        IReadOnlyList<SequenceSpec> Sequences,
        string Output,
        TDCParser.OpenCloseElementContext? Validate);

    public static PackGenerator ParsePackBody(string body)
    {
        // Wrapped in a document before parsing, exactly as the reference does, so a pack is written
        // in the same language as a config and read by the same grammar.
        TdcParserFacade.Result parsed =
            TdcParserFacade.Parse("<tdc><env count=\"1\">" + body + "</env></tdc>");
        if (!parsed.Ok)
        {
            throw new ArgumentException(
                "pack generator did not parse: " + string.Join("; ", parsed.Problems));
        }

        TDCParser.OpenCloseElementContext? tdc = FindElement(parsed.Tree, "tdc");
        TDCParser.OpenCloseElementContext? env =
            tdc is null ? null : FindElement(tdc.content(), "env");
        if (env is null)
        {
            throw new ArgumentException("pack generator body did not parse");
        }

        var sequences = new List<SequenceSpec>();
        string? output = null;
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "sequence")
            {
                string? refused = WholeColumnDeclaration(open);
                if (refused is not null)
                {
                    throw new ArgumentException(refused);
                }

                sequences.Add(Sequence(open));
                continue;
            }

            if (child.dataElement() is TDCParser.DataWithBodyContext withBody)
            {
                output = PairedData.Restore(withBody.dataContent().GetText());
            }
        }

        if (output is null)
        {
            throw new ArgumentException(
                "a composed pack generator needs a <data>...</data> output template");
        }

        return new PackGenerator(sequences, output, FindElement(env.content(), "valid"));
    }

    /// <summary>
    /// Whole-COLUMN declarations, which a pack body cannot honour.
    /// </summary>
    /// <remarks>
    /// A pack describes how to build ONE value and is asked for one per row. These two say
    /// something about the column as a whole — which values may repeat across rows, and in what
    /// order they come out — and answering that needs the row count and every other row, neither of
    /// which a pack has. Worse, one pack can be drawn from by several sequences in one config, so
    /// there is no single column for the pack to be speaking about.
    /// <para>
    /// <c>&lt;distinct&gt;</c> is deliberately NOT here. It reads like a sibling of <c>uniq=</c> and
    /// is not one: it constrains fields against each other WITHIN one row, which is exactly what a
    /// pack can answer on its own — and five shipped full-name packs rely on it to keep a person's
    /// two surnames from coming out the same.
    /// </para>
    /// </remarks>
    private static readonly string[] WholeColumnAttrs = { "uniq", "order" };

    /// <summary>Why this pack sequence is refused, or null when there is nothing wrong.</summary>
    private static string? WholeColumnDeclaration(TDCParser.OpenCloseElementContext sequence)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(sequence.attr());
        string where = attrs.TryGetValue("name", out string? named)
            ? $"<sequence name=\"{named}\">"
            : "<sequence>";

        foreach (string attr in WholeColumnAttrs)
        {
            if (!attrs.TryGetValue(attr, out string? value) || value.Trim().Length == 0)
            {
                continue;
            }

            return $"generator declares {attr}= on {where}, which a pack cannot honour: a pack "
                + $"builds ONE value and is asked for one per row, while {attr}= is a property of "
                + "the whole column. Declare it on the sequence in the config that draws from this "
                + "pack instead.";
        }

        return null;
    }

    private static IReadOnlyDictionary<string, string> Attributes(TDCParser.AttrContext[] attrs)
    {
        var result = new Dictionary<string, string>();
        foreach (TDCParser.AttrContext attr in attrs)
        {
            string raw = attr.attrValue.Text;
            // The lexer hands back the quotes as part of the token.
            result[attr.attrName.Text] = raw.Substring(1, raw.Length - 2);
        }

        return result;
    }

    private static TDCParser.OpenCloseElementContext? FindElement(IParseTree? parent, string name)
    {
        if (parent is null)
        {
            return null;
        }

        for (int i = 0; i < parent.ChildCount; i++)
        {
            IParseTree child = parent.GetChild(i);
            TDCParser.OpenCloseElementContext? open = child switch
            {
                TDCParser.ElementContext element => element.openCloseElement(),
                TDCParser.OpenCloseElementContext direct => direct,
                _ => null,
            };
            if (open is not null && open.name.Text == name)
            {
                return open;
            }
        }

        return null;
    }
}
