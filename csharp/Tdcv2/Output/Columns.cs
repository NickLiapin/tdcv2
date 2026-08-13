using System.Globalization;
using Tdcv2.Model;

namespace Tdcv2.Output;

/// <summary>
/// The typed columns a <c>&lt;block&gt;</c> declares, and the types they carry.
/// </summary>
/// <remarks>
/// <para>
/// A <c>&lt;data&gt;</c> with a <c>name</c> is a column; one without is decorative text and columnar
/// output ignores it. Which <c>&lt;line&gt;</c> it sits on does not matter — the columns are every
/// named <c>&lt;data&gt;</c> in document order. That keeps the text block and the schema the same
/// construct, so a config gains typed output without learning a second way to describe itself.
/// </para>
/// <para>
/// A column's type is resolved in one order, and the order is the point: an explicit <c>type=</c>
/// wins; failing that, the generator feeding the column is asked; failing that, it is text. Nothing
/// is ever guessed from the rendered values, because that is exactly how <c>007</c> turns into
/// <c>7</c>.
/// </para>
/// </remarks>
public static class Columns
{
    /// <summary>One declared column: its name, the text it renders from, and its type if it declared one.</summary>
    public sealed record Declared(string Name, string Template, ColumnType? Type);

    /// <summary>
    /// A column's type, resolved.
    /// </summary>
    /// <returns>
    /// <c>null</c> for a column with no declared type whose source cannot be told confidently — the
    /// caller falls back to text, which never corrupts anything.
    /// </returns>
    public static ColumnType? Resolve(Declared column, Config config)
    {
        if (column.Type is not null)
        {
            return column.Type;
        }

        string? source = SoleReference(column.Template, config.Inject ?? "${{%}}");
        return source is null ? null : DeriveOutput(source, config);
    }

    /// <summary>
    /// The single sequence a template refers to, when it is exactly one substitution and nothing else
    /// (<c>${{Id}}</c>).
    /// </summary>
    /// <remarks>
    /// Composite text has no single source type: <c>${{First}} ${{Last}}</c> is a sentence, not a
    /// number that happens to be spelled with a space in it.
    /// </remarks>
    public static string? SoleReference(string template, string inject)
    {
        int marker = inject.IndexOf('%');
        if (marker < 0)
        {
            return null;
        }

        string prefix = inject[..marker];
        string suffix = inject[(marker + 1)..];
        string text = template.Trim();
        if (!text.StartsWith(prefix, StringComparison.Ordinal)
            || !text.EndsWith(suffix, StringComparison.Ordinal))
        {
            return null;
        }

        string inner = text[prefix.Length..(text.Length - suffix.Length)];
        // A second marker means more than one substitution, or literal text between them.
        return inner.Length == 0 || inner.Contains(prefix) || inner.Contains('|')
            ? null
            : inner.Trim();
    }

    /// <summary>
    /// The type of a column fed by <paramref name="name"/>, as a LIST when its generator repeats.
    /// </summary>
    /// <remarks>
    /// A repeating generator puts several values in one cell, so the column is a list of whatever one
    /// value would have been. When the element cannot be typed the list survives anyway —
    /// <c>repeat</c> says this IS a list, and flattening it back into comma-joined text would throw
    /// away structure that is known for certain.
    /// </remarks>
    public static ColumnType? DeriveOutput(string name, Config config)
    {
        ColumnType? element = Derive(name, config);
        if (SeparatorOf(name, config) is null)
        {
            return element;
        }

        string inner = element is not null
            ? Spell(element)
            : ElementFallback(name, config);
        return ColumnType.ParseOutput("[]" + inner);
    }

    /// <summary>
    /// A column's type from the generator that feeds it, or <c>null</c> when it cannot be told.
    /// </summary>
    /// <remarks>
    /// The reliable middle step: a column that came from <c>type="number"</c> with no decimals is an
    /// int64, which is knowledge rather than inference. Everything uncertain returns nothing and
    /// becomes text.
    /// </remarks>
    public static ColumnType? Derive(string name, Config config)
    {
        // A ground-truth flag column is minted by a gen's anomaly_flag or a <mix flag=>, and is never
        // declared as a <sequence> of its own — so it has to be found by looking.
        foreach (SequenceSpec spec in config.Sequences)
        {
            if (spec.IsMix && name == spec.Mix!.Flag?.Trim())
            {
                return ColumnType.Parse("bool");
            }

            foreach (Gen gen in GensOf(spec))
            {
                if (name == gen.Attrs.GetValueOrDefault("anomaly_flag")?.Trim())
                {
                    return ColumnType.Parse("bool");
                }
            }
        }

        SequenceSpec? named = SpecNamed(name, config);
        if (named is not null && named.IsMix)
        {
            return DeriveMix(named.Mix!, config);
        }

        return named?.Gen is null ? null : DeriveGen(named.Gen, config);
    }

    /// <summary>The rules for one generator, shared between a plain sequence and a mix's cases.</summary>
    private static ColumnType? DeriveGen(Gen gen, Config config)
    {
        // Output formatting rewrites the text, so the value is no longer of its raw type.
        if (gen.Attrs.ContainsKey("mask") || gen.Attrs.ContainsKey("case"))
        {
            return null;
        }

        string? missing = gen.Attrs.GetValueOrDefault("missing");
        bool nullable = !string.IsNullOrWhiteSpace(missing) && Positive(missing);

        switch (gen.Type)
        {
            case "number":
            case "timeseries":
            // A pattern draws a NUMBER from a shape — `y_range="1..30"` is a range of numbers
            // whatever the curve looks like — so it types exactly like a timeseries.
            case "pattern":
                return WithNullable(Decimals(gen) > 0 ? "double" : "int64", nullable);
            case "increment":
            case "decrement":
                return WithNullable("int64", nullable);
            case "running":
                // A running total is the arithmetic of the column it reads, so its type is that
                // column's — recursively, since `of=` may name another derived one. `decimals=` on
                // the running gen itself makes it fractional whatever the source was.
                return Decimals(gen) > 0
                    ? WithNullable("double", nullable)
                    : NumericSource(gen.Attrs.GetValueOrDefault("of", ""), config, nullable);
            case "stat":
            {
                // A statistic's type follows the OPERATION, which is declared. Counting is whole by
                // definition; a mean, a median and a standard deviation are not, whatever they are
                // computed from; a sum, a minimum and a maximum keep the source column's type.
                if (Decimals(gen) > 0)
                {
                    return WithNullable("double", nullable);
                }

                string op = (gen.Attrs.GetValueOrDefault("op") ?? "").Trim();
                return op switch
                {
                    "count" => WithNullable("int64", nullable),
                    "mean" or "median" or "stddev" => WithNullable("double", nullable),
                    "sum" or "min" or "max" =>
                        NumericSource(gen.Attrs.GetValueOrDefault("of", ""), config, nullable),
                    _ => null,
                };
            }

            case "formula":
            {
                // A formula's type is knowable exactly when the config declared how many digits it
                // wants, and not otherwise: `expr="A + 1"` is a whole number, `expr="A / 2"` is
                // not, and `expr="A > 5 ? over : under"` is a WORD. So `decimals=` is the one
                // honest signal, and without it the column stays text.
                int? places = DeclaredDecimals(gen);
                return places is null
                    ? null
                    : WithNullable(places > 0 ? "double" : "int64", nullable);
            }

            case "file":
                // A file is a bag of whatever the file holds, so an ordinary read stays text.
                // `read="quantile"` is the exception, and not by inspection of the values: the file
                // MUST be numeric or the run refuses, so the column is a number by construction.
                //
                // Which number is decided by the config alone, because this layer never opens the
                // file. `decimals="0"` is the one declaration that promises whole values; without
                // it the precision comes from the source and may be fractional, so the safe numeric
                // answer is a double.
                return (gen.Attrs.GetValueOrDefault("read") ?? "").Trim() != "quantile"
                    ? null
                    : WithNullable(DeclaredDecimals(gen) == 0 ? "int64" : "double", nullable);
            case "date":
                // The default rendering is locale-shaped (05/25/1996), not ISO, so a date column is
                // only safe to infer when the config asked for ISO. Otherwise it stays text, and the
                // author can still say type="date" if they mean it.
                return gen.Attrs.GetValueOrDefault("format") == "YYYY-MM-DD"
                    ? WithNullable("date", nullable)
                    : null;
            case "template":
                return gen.Attrs.GetValueOrDefault("value", "")
                    .EndsWith(".uuid", StringComparison.Ordinal)
                    ? WithNullable("uuid", nullable)
                    : null;
            default:
                return null;
        }
    }

    /// <summary>
    /// A <c>&lt;mix&gt;</c> column's type, when every branch agrees on one.
    /// </summary>
    /// <remarks>
    /// Deliberately strict: each case must be exactly one generator, and all of them must derive to
    /// the same type. A mix of a number and a word is text, and any doubt falls back to text — the
    /// rule that keeps a leading zero from being optimised away.
    /// </remarks>
    private static ColumnType? DeriveMix(Mix mix, Config config)
    {
        if (mix.Cases.Count == 0)
        {
            return null;
        }

        ColumnType? agreed = null;
        foreach (Case caseSpec in mix.Cases)
        {
            if (caseSpec.Parts.Count != 1 || caseSpec.Parts[0].Gen is null)
            {
                return null;
            }

            ColumnType? type = DeriveGen(caseSpec.Parts[0].Gen!, config);
            if (type is null)
            {
                return null;
            }

            if (agreed is null)
            {
                agreed = type;
            }
            else if (agreed.Kind != type.Kind || agreed.Nullable != type.Nullable)
            {
                return null;
            }
        }

        return agreed;
    }

    /// <summary>
    /// The separator of the generator feeding <paramref name="name"/>, or <c>null</c> when it does
    /// not repeat.
    /// </summary>
    /// <remarks>
    /// A list column splits its rendered text on exactly this, so the text view and the typed view
    /// can never disagree about where one value ends and the next begins.
    /// </remarks>
    public static string? SeparatorOf(string name, Config config)
    {
        Gen? gen = SpecNamed(name, config)?.Gen;
        if (gen is null)
        {
            return null;
        }

        return string.IsNullOrWhiteSpace(gen.Attrs.GetValueOrDefault("repeat"))
            ? null
            : gen.Attrs.GetValueOrDefault("separator", ",");
    }

    /// <summary>
    /// The element type for a repeating generator whose values cannot be typed.
    /// </summary>
    /// <remarks>
    /// Text stays text, but <c>missing=</c> still makes the ELEMENT nullable — that is what it blanks.
    /// </remarks>
    private static string ElementFallback(string name, Config config)
    {
        string? missing = SpecNamed(name, config)?.Gen?.Attrs.GetValueOrDefault("missing");
        return !string.IsNullOrWhiteSpace(missing) && Positive(missing) ? "string|null" : "string";
    }

    /// <summary>Refuse a duplicate name before anything is written — two columns cannot share one.</summary>
    public static void CheckUnique(IReadOnlyList<Declared> columns)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Declared column in columns)
        {
            if (!seen.Add(column.Name))
            {
                throw new ArgumentException($"duplicate column name \"{column.Name}\"");
            }
        }
    }

    private static SequenceSpec? SpecNamed(string name, Config config) =>
        config.Sequences.FirstOrDefault(spec => spec.Name == name);

    private static IEnumerable<Gen> GensOf(SequenceSpec spec)
    {
        if (spec.Gen is not null)
        {
            yield return spec.Gen;
        }

        if (spec.IsCompound)
        {
            foreach (Field field in spec.Fields!)
            {
                yield return field.Gen;
            }
        }
    }

    private static ColumnType WithNullable(string type, bool nullable) =>
        ColumnType.Parse(nullable ? type + "|null" : type);

    /// <summary>
    /// A resolved type written back out, so a list can be spelled around it.
    /// </summary>
    /// <remarks>
    /// Java gets this from the type's own toString; here the shape is written explicitly rather than
    /// left to a default that has no reason to match the parser.
    /// </remarks>
    private static string Spell(ColumnType type)
    {
        string head = type.Kind switch
        {
            ColumnKind.Decimal => $"decimal({type.Precision},{type.Scale})",
            _ => type.Kind.ToString().ToLowerInvariant(),
        };
        return type.Nullable ? head + "|null" : head;
    }

    /// <summary><c>decimals=</c> as the config WROTE it — null when it said nothing at all.</summary>
    /// <remarks>
    /// Different from <see cref="Decimals"/>, which reads an absent attribute as zero. Two
    /// generators need the difference: a formula is typed only when the config declared one, and a
    /// quantile read is whole only when it declared zero.
    /// </remarks>
    private static int? DeclaredDecimals(Gen gen)
    {
        string raw = (gen.Attrs.GetValueOrDefault("decimals") ?? "").Trim();
        if (raw.Length == 0)
        {
            return null;
        }

        return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double d)
            ? (int)d
            : null;
    }

    /// <summary>The type of the column <c>of=</c> names, when it is a number.</summary>
    /// <remarks>
    /// Anything else — or a source this file cannot type — stays text rather than guessing: only a
    /// numeric source gives a numeric total.
    /// </remarks>
    private static ColumnType? NumericSource(string of, Config config, bool nullable)
    {
        string source = (of ?? "").Trim();
        if (source.Length == 0)
        {
            return null;
        }

        ColumnType? from = Derive(source, config);
        return from?.Kind switch
        {
            ColumnKind.Int64 => WithNullable("int64", nullable),
            ColumnKind.Double => WithNullable("double", nullable),
            _ => null,
        };
    }

    private static int Decimals(Gen gen) =>
        double.TryParse(
            gen.Attrs.GetValueOrDefault("decimals", "0"), NumberStyles.Float,
            CultureInfo.InvariantCulture, out double d)
            ? (int)d
            : 0;

    private static bool Positive(string raw) =>
        double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
        && v > 0;
}
