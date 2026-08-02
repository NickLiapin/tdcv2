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

    /// <summary>The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk.</summary>
    public static int Resolve(Config config, DataPacks? packs)
    {
        string? forced = TrimToNull(config.Engine);
        if (forced is not null)
        {
            if (forced != "1" && forced != "2" && forced != "3")
            {
                throw new ArgumentException(
                    $"invalid engine \"{forced}\" — expected \"1\" (in-memory), \"2\" (streaming), "
                    + "or \"3\" (exact-on-disk)");
            }

            return int.Parse(forced, System.Globalization.CultureInfo.InvariantCulture);
        }

        string? mode = TrimToNull(config.Mode);
        if (mode == "memory")
        {
            return 1;
        }

        // "stream" is the old name for asking for Engine 2 outright, from before mode described
        // the constraint rather than the engine. Kept working; the router is not consulted.
        if (mode == "stream")
        {
            return 2;
        }

        if (mode is not null && mode != "disk")
        {
            throw new ArgumentException(
                $"invalid mode \"{mode}\" — expected \"memory\" or \"disk\"");
        }

        // No mode at all means disk: a config says how big its run is, not how to hold it, and the
        // engine that can stream is the right default for a generator whose whole point is volume.

        // A template address that names a field resolves per row against the other columns; only
        // the in-memory engine has them all.
        if (AnyGen(config, gen => gen.Type == "template" && IsDynamic(gen.Attr("value") ?? "")))
        {
            return 1;
        }

        // weight= with row= draws a linked record to an exact quota, which needs the global total.
        if (AnyGen(
                config,
                gen => gen.Type == "file"
                    && TrimToNull(gen.Attrs.GetValueOrDefault("weight")) is not null
                    && TrimToNull(gen.Attrs.GetValueOrDefault("row")) is not null))
        {
            return 1;
        }

        // A pack generator that declares its own shares apportions them over the whole column.
        if (packs is not null && AnyGen(config, gen => DeclaresShares(gen, config, packs)))
        {
            return 1;
        }

        // A network call is not reproducible, so it never runs on the reproducible path.
        // uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
        // taken-set span the whole column, which only the in-memory engine holds.
        static bool Counting(string type) => type is "increment" or "decrement";
        if (config.Sequences.Any(s => s.Uniq
            && (s.Gen is not null
                ? !Counting(s.Gen.Type)
                : (s.Items ?? Array.Empty<Item>()).Any(
                    i => i.Gen is not null && i.Field is null && !Counting(i.Gen.Type)))))
        {
            return 1;
        }

        if (AnyGen(config, gen => gen.Type == "http"))
        {
            return 1;
        }

        return NeedsExact(config) ? 3 : 2;
    }

    /// <summary>
    /// Whether disk mode needs the exact engine rather than the streaming one.
    /// </summary>
    /// <remarks>
    /// Everything here is a case where a per-row answer and a whole-column answer differ: exact
    /// percentages combined with uniqueness, a uniq field that is not a finite list, a child of a
    /// parent whose values are not a finite list, a weighted choice inside a pattern. Ordinary exact
    /// percentages, uniform uniqueness, switch, distinct and text parent-child all stream.
    /// </remarks>
    public static bool NeedsExact(Config config)
    {
        var byName = config.Sequences.ToDictionary(s => s.Name, StringComparer.Ordinal);

        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.Uniq)
            {
                if (TrimToNull(spec.Parent) is not null)
                {
                    return true;
                }

                foreach (Field field in FieldsOf(spec))
                {
                    if (field.Gen.Type != "text" || HasPercent(field.Gen))
                    {
                        return true;
                    }
                }
            }

            if (spec.Gen is not null && IsWeightedAdvancedRegex(spec.Gen))
            {
                return true;
            }

            if (FieldsOf(spec).Any(f => IsWeightedAdvancedRegex(f.Gen)))
            {
                return true;
            }

            string? parent = TrimToNull(spec.Parent);
            if (parent is not null && !ParentIsFiniteText(byName, parent))
            {
                return true;
            }
        }

        return false;
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

    private static bool DeclaresShares(Gen gen, Config config, DataPacks packs)
    {
        if (gen.Type != "template")
        {
            return false;
        }

        string path = gen.Attr("value") ?? "";
        if (path.Length == 0 || IsDynamic(path))
        {
            return false;
        }

        string? locale = gen.Attrs.GetValueOrDefault("local");
        try
        {
            return packs.NeedsWholeColumn(
                path, string.IsNullOrWhiteSpace(locale) ? config.Locale : locale);
        }
        catch (Exception e) when (e is ArgumentException or IOException)
        {
            // An address that does not resolve is the validator's problem, not the router's.
            return false;
        }
    }

    /// <summary><c>common.vehicle.model.${{Brand}}</c> — an address not known until the row is.</summary>
    private static bool IsDynamic(string value) => value.Contains("${{");

    /// <summary>Every <c>&lt;gen&gt;</c> in the config, simple or a compound's field.</summary>
    private static bool AnyGen(Config config, Func<Gen, bool> test)
    {
        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.Gen is not null && test(spec.Gen))
            {
                return true;
            }

            if (FieldsOf(spec).Any(f => f.Gen is not null && test(f.Gen)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>A compound's fields, or nothing — a simple sequence has none rather than an empty list.</summary>
    private static IReadOnlyList<Field> FieldsOf(SequenceSpec spec) =>
        spec.IsCompound ? spec.Fields! : Array.Empty<Field>();

    private static string? TrimToNull(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
