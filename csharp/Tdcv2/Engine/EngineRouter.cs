using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Packs;

namespace Tdcv2.Engine;

/// <summary>
/// Which engine a config gets.
/// </summary>
/// <remarks>
/// <para>
/// The engines are not interchangeable. They draw in different orders, so the same seed lands on
/// different values — that is documented behaviour, not a defect. Which means routing is part of
/// the contract: rendering a config on engine 1 when the reference would have used engine 2
/// produces output that is wrong in every row while looking perfectly plausible.
/// </para>
/// <para>
/// A config does not name an engine — it states a constraint, and the router picks the fastest
/// engine that can honour it. <c>mode="memory"</c> means the whole run may be held at once;
/// <c>mode="disk"</c> means it may not. Naming an engine outright with <c>engine="1|2|3"</c> skips
/// all of this, which is what makes it useful for a benchmark and a poor default for everything
/// else.
/// </para>
/// <para>
/// The interesting decisions are the ones that route a disk-mode config back to memory. Each marks
/// something whose answer depends on the whole column — an interpolated pack address, an exact share
/// declared inside a pack, a weighted draw of a linked row. Answered a row at a time they do not
/// fail; they quietly produce data that is wrong in a way nobody notices, which is the worst outcome
/// available and the reason these checks exist.
/// </para>
/// </remarks>
public static class EngineRouter
{
    public static int Resolve(Config config) => Resolve(config, null);

    /// <summary>Whether the config named an engine outright instead of describing its constraint.</summary>
    /// <remarks>
    /// <para>
    /// The distinction decides what happens when the streaming engine meets a config it cannot
    /// answer a row at a time. Named outright — <c>engine="2"</c>, <c>--engine 2</c>, or the older
    /// <c>mode="stream"</c> — the refusal IS the answer: running the config somewhere else would
    /// hide exactly what its author asked to be told, which is what forcing an engine is for.
    /// </para>
    /// <para>
    /// Described as a constraint — <c>mode="disk"</c>, or nothing at all — the router chose, so the
    /// router may choose again. Correct data then matters more than the memory profile.
    /// </para>
    /// </remarks>
    public static bool Forced(Config config) =>
        TrimToNull(config.Engine) is not null || TrimToNull(config.Mode) == "stream";

    /// <summary>The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk.</summary>
    public static int Resolve(Config config, DataPacks? packs) => Explain(config, packs).Engine;

    /// <summary>How each engine is named next to its number.</summary>
    public static string Label(int engine) => engine switch
    {
        1 => "in memory",
        2 => "streaming",
        _ => "exact, on disk",
    };

    /// <summary>The engine a run uses, and why — what <c>check</c> prints.</summary>
    /// <param name="Engine">1 in memory, 2 streaming, 3 exact on disk.</param>
    /// <param name="Why">The reason, in words.</param>
    /// <param name="Downgraded">Engine 3 was asked for and engine 1 runs the config instead.</param>
    public sealed record Choice(int Engine, string Why, bool Downgraded = false)
    {
        /// <summary>One line for <c>check</c>: the engine, its name, and the reason.</summary>
        public string Describe()
        {
            string named = $"engine {Engine} ({Label(Engine)})";
            return Downgraded ? $"runs on {named}, not engine 3: {Why}" : $"runs on {named}: {Why}";
        }
    }

    /// <summary>The engine a config runs on, and the reason in words.</summary>
    /// <remarks>
    /// Engine 3 asked for by name runs a config the disk route sends to engine 1 on engine 1, and
    /// says so. It always did that, silently, at the last moment — the lazy build refused and the
    /// in-memory engine took over — which left nothing for <c>check</c> to report and, past the
    /// row count where a run splits itself into threads, handed each worker a refusal it could not
    /// take over from: this implementation exited 1 there. Deciding it here, before the run, is
    /// the same answer every implementation gives.
    /// </remarks>
    public static Choice Explain(Config config, DataPacks? packs)
    {
        string? forced = TrimToNull(config.Engine);
        // engine= wins over mode= — except when the two contradict each other. mode="sequential"
        // is not a preference about speed, it is a promise that row N is computed after row N-1,
        // which only engine 1 keeps. Letting engine="2" quietly override it produced the worst
        // possible message: a run failing with "add mode=sequential" against a config that
        // already said it. Naming both attributes is the whole fix.
        if (TrimToNull(config.Mode) == "sequential" && forced is not null && forced != "1")
        {
            throw new ArgumentException(
                $"engine=\"{forced}\" contradicts mode=\"sequential\": rows must be computed in "
                + "order, and only engine 1 does that. Drop one of the two.");
        }

        if (forced is not null)
        {
            if (forced != "1" && forced != "2" && forced != "3")
            {
                throw new ArgumentException(
                    $"invalid engine \"{forced}\" — expected \"1\" (in-memory), \"2\" (streaming), "
                    + "or \"3\" (exact-on-disk)");
            }

            if (forced == "3")
            {
                Choice disk = DiskRoute(config);
                if (disk.Engine == 1)
                {
                    return disk with { Downgraded = true };
                }
            }

            return new Choice(
                int.Parse(forced, System.Globalization.CultureInfo.InvariantCulture),
                $"engine=\"{forced}\" on <env>");
        }

        string? mode = TrimToNull(config.Mode);
        if (mode == "memory")
        {
            return new Choice(1, "mode=\"memory\" on <env>");
        }

        // "stream" is the old name for asking for Engine 2 outright, from before mode described
        // the constraint rather than the engine. Kept working; the router is not consulted.
        if (mode == "stream")
        {
            return new Choice(2, "mode=\"stream\" on <env>");
        }

        // "sequential" computes rows strictly in order, which is what prev() needs and what the
        // streaming engines cannot promise: engine 2 resolves ANY row in O(1) without touching
        // the one before it, and that is its whole design. So the mode forces engine 1, which
        // materialises in order. The cost is engine 1's — the run is held in memory — and it is
        // paid only by a config that asked for it.
        if (mode == "sequential")
        {
            return new Choice(1, "mode=\"sequential\" on <env>");
        }

        if (mode is not null && mode != "disk")
        {
            throw new ArgumentException(
                $"invalid mode \"{mode}\" — expected \"memory\", \"disk\" or \"sequential\"");
        }

        return DiskRoute(config);
    }

    /// <summary><c>mode="disk"</c>, the default: the fastest engine the config allows, and why.</summary>
    private static Choice DiskRoute(Config config)
    {

        // No mode at all means disk: a config says how big its run is, not how to hold it, and the
        // engine that can stream is the right default for a generator whose whole point is volume.

        // A template address that names a field resolves per row against the other columns; only
        // the in-memory engine has them all.
        string? dynamic =
            GenOwner(config, gen => gen.Type == "template" && IsDynamic(gen.Attr("value") ?? ""));
        if (dynamic is not null)
        {
            return new Choice(1, $"\"{dynamic}\" picks its pack per row");
        }

        // weight= with row= draws a linked record to an exact quota, which needs the global total.
        string? weightedRow = GenOwner(
            config,
            gen => gen.Type == "file"
                && TrimToNull(gen.Attrs.GetValueOrDefault("weight")) is not null
                && TrimToNull(gen.Attrs.GetValueOrDefault("row")) is not null);
        if (weightedRow is not null)
        {
            return new Choice(
                1, $"\"{weightedRow}\" draws a weighted row of a file (weight= with row=)");
        }

        // A pack generator that declares its own shares used to be routed here, and for
        // a real reason: resolved a row at a time the quota was computed over a single
        // row and every row went to the largest share. The streaming builder plans such
        // a body over the COLUMN now, so the reason is gone — and keeping the rule after
        // the refusal went was worse than nothing, because the config still landed on
        // the engine that holds the whole table. Measured on a 5,000,000-row
        // `hu.person.male.fullName` column: the in-memory engine wanted 2 GB and died
        // under a 512 MB cap, while the streaming path finished it inside 512 MB.
        //
        // One shape still belongs here — a body carrying its own `<valid>` — and it
        // arrives the way every other unstreamable config does: refused by name.

        // A network call is not reproducible, so it never runs on the reproducible path.
        // uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
        // taken-set span the whole column, which only the in-memory engine holds.
        static bool Counting(string type) => type is "increment" or "decrement";
        SequenceSpec? simpleUniq = config.Sequences.FirstOrDefault(s => s.Uniq
            && (s.Gen is not null
                ? !Counting(s.Gen.Type)
                : (s.Items ?? Array.Empty<Item>()).Any(
                    i => i.Gen is not null && i.Field is null && !Counting(i.Gen.Type))));
        if (simpleUniq is not null)
        {
            return new Choice(1, $"uniq=\"true\" on \"{simpleUniq.Name}\"");
        }

        string? http = GenOwner(config, gen => gen.Type == "http");
        if (http is not null)
        {
            return new Choice(1, $"\"{http}\" calls a web service");
        }

        // A <switch> branch that declares a share the streaming engines cannot lay over the
        // right rows. They refuse such a branch rather than apportion it over the wrong
        // denominator, and a refusal reached at build time is not a fallback for every caller.
        // Decide it here, statically, where every path sees the same answer.
        string? switchShare = UnstreamableSwitchPercent(config);
        if (switchShare is not null)
        {
            return new Choice(1, $"a share inside \"{switchShare}\" needs the whole column");
        }

        // A column derived from other rows — a running total, a statistic, a date offset — is
        // refused by name by the streaming builder. Deciding it here keeps that refusal from
        // reaching a parallel worker, which has nothing to fall back to.
        string? running = GenOwner(config, gen => gen.Type == "running");
        if (running is not null)
        {
            return new Choice(1, $"\"{running}\" adds up the rows before it");
        }

        string? stat = GenOwner(config, gen => gen.Type == "stat");
        if (stat is not null)
        {
            return new Choice(1, $"\"{stat}\" is computed over every row");
        }

        string? offset = GenOwner(
            config,
            gen => gen.Type == "date" && TrimToNull(gen.Attrs.GetValueOrDefault("of")) is not null);
        if (offset is not null)
        {
            return new Choice(1, $"\"{offset}\" is a date offset from another column");
        }

        // parent="Name" with no value narrows a column to the rows where the parent produced
        // anything, which needs the parent's whole column. Same reason as the three above.
        foreach (SequenceSpec spec in config.Sequences)
        {
            string parent = (spec.Parent ?? "").Trim();
            if (parent.Length == 0)
            {
                continue;
            }

            int dot = parent.IndexOf('.');
            if (dot < 0 || parent[(dot + 1)..].Length == 0)
            {
                return new Choice(1, $"\"{spec.Name}\" has parent=\"{parent}\" with no value");
            }
        }

        string? exact = ExactReason(config);
        return exact is not null
            ? new Choice(3, exact)
            : new Choice(2, "every column can be built one row at a time");
    }

    /// <summary>
    /// Does this <c>&lt;case&gt;</c> body declare a share the denominator has to be right for?
    /// </summary>
    private static bool CaseCarriesPercent(Case? body) =>
        body is not null && body.Parts.Any(part =>
            (part.Mix is not null && !string.IsNullOrWhiteSpace(part.Mix.Percent))
            || (part.Gen is not null && !string.IsNullOrWhiteSpace(part.Gen.Attr("percent"))));

    /// <summary>
    /// A <c>&lt;switch&gt;</c> branch whose share the streaming engines cannot honour.
    /// </summary>
    /// <remarks>
    /// They can subset a branch keyed on ONE value of a plain values list — the same bijection
    /// <c>parent="Gender.Male"</c> uses. They cannot rank a multi-key branch (<c>US|CA|MX</c> is
    /// a union, and ranks across a union do not compose from the per-value ranks), nor
    /// <c>&lt;default&gt;</c> (a complement, which nothing enumerates), nor any branch whose
    /// subject is not a finite values list.
    /// <para>
    /// Deliberately conservative: anything it cannot prove streamable goes to engine 1, which
    /// costs speed on an exotic config and never costs correctness.
    /// </para>
    /// </remarks>
    /// <summary>Every <c>&lt;switch&gt;</c> written inside this <c>&lt;case&gt;</c>, at any depth.</summary>
    private static void NestedSwitches(Case? body, List<Switch> found)
    {
        if (body is null)
        {
            return;
        }

        foreach (CasePart part in body.Parts)
        {
            if (part.SwitchSpec is not null)
            {
                found.Add(part.SwitchSpec);
                foreach (SwitchEntry entry in part.SwitchSpec.Entries)
                {
                    NestedSwitches(entry.Value, found);
                }

                NestedSwitches(part.SwitchSpec.Fallback, found);
            }
            else if (part.Mix is not null)
            {
                foreach (Case inner in part.Mix.Cases)
                {
                    NestedSwitches(inner, found);
                }
            }
        }
    }

    private static string? UnstreamableSwitchPercent(Config config)
    {
        List<string>? PlainListValues(string name)
        {
            SequenceSpec? subject = config.Sequences.FirstOrDefault(s => s.Name == name);
            Gen? gen = subject?.Gen;
            if (gen is null || gen.Type != "text")
            {
                return null;
            }

            if (gen.Attr("order") == "sequential" || !string.IsNullOrWhiteSpace(gen.Attr("repeat")))
            {
                return null;
            }

            return gen.Attr("value").Split(',').Select(v => v.Trim()).ToList();
        }

        foreach (SequenceSpec spec in config.Sequences)
        {
            // A NESTED switch is never rankable — its branch covers an intersection of two
            // partitions, and there is no O(1) rank inside one. So any share it declares, at any
            // depth, decides engine 1.
            var bodies = new List<Case?>();
            if (spec.SwitchSpec is not null)
            {
                bodies.AddRange(spec.SwitchSpec.Entries.Select(e => (Case?)e.Value));
                bodies.Add(spec.SwitchSpec.Fallback);
            }

            if (spec.Mix is not null)
            {
                bodies.AddRange(spec.Mix.Cases.Select(c => (Case?)c));
            }

            var nested = new List<Switch>();
            foreach (Case? body in bodies)
            {
                NestedSwitches(body, nested);
            }

            if (nested.Any(inner =>
                CaseCarriesPercent(inner.Fallback)
                || inner.Entries.Any(e => CaseCarriesPercent(e.Value))))
            {
                return spec.Name;
            }

            Switch? sw = spec.SwitchSpec;
            if (sw is null)
            {
                continue;
            }

            if (CaseCarriesPercent(sw.Fallback))
            {
                return spec.Name;
            }

            List<string>? values = PlainListValues(sw.On);
            foreach (SwitchEntry entry in sw.Entries)
            {
                if (!CaseCarriesPercent(entry.Value))
                {
                    continue;
                }

                if (entry.Keys.Count != 1 || values is null || !values.Contains(entry.Keys[0]))
                {
                    return spec.Name;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Whether disk mode needs the exact engine rather than the streaming one.
    /// </summary>
    /// <remarks>
    /// Everything here is a case where a per-row answer and a whole-column answer differ: ANY
    /// uniqueness, a child of a parent whose values are not a finite list, a weighted choice
    /// inside a pattern. Ordinary exact percentages, switch, distinct and text parent-child all
    /// stream.
    /// </remarks>
    public static bool NeedsExact(Config config) => ExactReason(config) is not null;

    /// <summary>Why disk mode needs the exact engine, in words; null when it does not.</summary>
    private static string? ExactReason(Config config)
    {
        var byName = config.Sequences.ToDictionary(s => s.Name, StringComparer.Ordinal);

        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.Uniq)
            {
                return $"uniq=\"true\" on \"{spec.Name}\"";
            }

            if ((spec.Gen is not null && IsWeightedAdvancedRegex(spec.Gen))
                || FieldsOf(spec).Any(f => IsWeightedAdvancedRegex(f.Gen)))
            {
                return $"\"{spec.Name}\" has a weighted choice in advanced_regex";
            }

            string? parent = TrimToNull(spec.Parent);
            if (parent is not null && !ParentIsFiniteText(byName, parent))
            {
                return $"\"{spec.Name}\" has parent=\"{parent}\", which is not a list of values";
            }
        }

        // A group REARRANGES the columns it covers — every column keeps its multiset, so every
        // declared share survives — and that cannot be decided a row at a time. The streaming
        // engine could only offer a different answer, and two answers from one seed is the thing
        // this whole design exists to prevent.
        return config.EnvUniqGroups.Count > 0
            ? "a <uniq> group over " + string.Join(", ", config.EnvUniqGroups[0].Select(n => $"\"{n}\""))
            : null;
    }

    private static bool ParentIsFiniteText(
        IReadOnlyDictionary<string, SequenceSpec> byName, string reference)
    {
        int dot = reference.IndexOf('.');
        return byName.TryGetValue(dot < 0 ? reference : reference[..dot], out SequenceSpec? parent)
            && parent.Gen is not null
            && parent.Gen.Type == "text";
    }

    private static bool IsWeightedAdvancedRegex(Gen gen) =>
        gen.Type == "advanced_regex"
        && AdvancedRegexGen.HasWeightedChoice(gen.Attr("value") ?? "");

    private static bool HasPercent(Gen gen) =>
        !string.IsNullOrEmpty(gen.Attrs.GetValueOrDefault("percent"));



    /// <summary><c>common.vehicle.model.${{Brand}}</c> — an address not known until the row is.</summary>
    private static bool IsDynamic(string value) => value.Contains("${{");

    /// <summary>
    /// The first sequence holding a <c>&lt;gen&gt;</c> — simple or a compound's field — that passes.
    /// </summary>
    private static string? GenOwner(Config config, Func<Gen, bool> test)
    {
        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.Gen is not null && test(spec.Gen))
            {
                return spec.Name;
            }

            if (FieldsOf(spec).Any(f => f.Gen is not null && test(f.Gen)))
            {
                return spec.Name;
            }
        }

        return null;
    }

    /// <summary>A compound's fields, or nothing — a simple sequence has none rather than an empty list.</summary>
    private static IReadOnlyList<Field> FieldsOf(SequenceSpec spec) =>
        spec.IsCompound ? spec.Fields! : Array.Empty<Field>();

    private static string? TrimToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
