namespace Tdcv2.Model;

/// <summary>A single <c>&lt;gen&gt;</c>: its type plus every attribute, unparsed.</summary>
public sealed record Gen(string Type, IReadOnlyDictionary<string, string> Attrs)
{
    public string? Attr(string name, string? fallback = null) =>
        Attrs.TryGetValue(name, out string? value) ? value : fallback;
}

/// <summary>
/// One piece of a <c>&lt;case&gt;</c> body: literal text, a generator, or a nested mix.
/// </summary>
/// <remarks>
/// A case concatenates its pieces, which is what lets a branch read as <c>A-</c> followed by a
/// pattern rather than as a separate prefix column.
/// </remarks>
/// <summary>
/// One piece of a <c>&lt;case&gt;</c> body: literal text, a generator, a nested mix, or a nested
/// switch.
/// </summary>
/// <remarks>
/// A nested <c>&lt;switch&gt;</c> contributes a value only — it has no <c>name</c>, so nothing can
/// interpolate it — and it looks its subject up over the rows of the branch it sits in.
/// </remarks>
public sealed record CasePart(string? Text, Gen? Gen, Mix? Mix, Switch? SwitchSpec = null);

/// <summary>One branch of a <c>&lt;mix&gt;</c> or <c>&lt;switch&gt;</c>.</summary>
/// <param name="Anomaly">
/// <c>&lt;case anomaly="true"&gt;</c> — a label only. It injects nothing; the branch's own
/// generator produces the outlier, and the flag column marks who chose it.
/// </param>
public sealed record Case(IReadOnlyList<CasePart> Parts, bool Anomaly);

/// <summary>
/// <c>&lt;mix name="X" percent="80,20"&gt;</c> — several ways to build one value, apportioned
/// exactly.
/// </summary>
/// <remarks>
/// Different from a conditional sequence: a conditional asks about another column, a mix asks for
/// a share of the run. It is how a column gets a rare shape — 2% malformed addresses, 5%
/// legacy-format ids — in a stated proportion rather than an approximate one.
/// </remarks>
/// <param name="Flag">
/// The name of a companion column marking the rows that took an anomalous case.
/// </param>
public sealed record Mix(string? Percent, string? Flag, IReadOnlyList<Case> Cases);

/// <summary>One <c>&lt;switch&gt;</c> entry: keys, and how to build the value when one matches.</summary>
public sealed record SwitchEntry(IReadOnlyList<string> Keys, Case Value);

/// <summary>
/// <c>&lt;switch name="X" on="Subject"&gt;</c> — a lookup table.
/// </summary>
/// <remarks>
/// A pure function of the subject's value, so unlike everything else here it consumes no
/// randomness of its own beyond what its cases' generators use. Currency from country, tax rate
/// from region: the pairing is a fact, not a choice.
/// </remarks>
public sealed record Switch(string On, IReadOnlyList<SwitchEntry> Entries, Case? Fallback);

/// <summary>One field of a compound sequence: a <c>&lt;gen name="X"&gt;</c> inside a sequence.</summary>
public sealed record Field(string Name, Gen Gen);

/// <summary>
/// One item of a composed sequence's body, in source order.
/// </summary>
/// <remarks>
/// A named <c>&lt;gen&gt;</c> or <c>&lt;data&gt;</c> is a field; an unnamed one is part of the
/// sequence's own value. Exactly one of the three is set.
/// </remarks>
/// <param name="Field">A named <c>&lt;gen&gt;</c> — a field, reached as <c>Name.Field</c>.</param>
/// <param name="Gen">An unnamed <c>&lt;gen&gt;</c> — drawn, and concatenated into the value.</param>
/// <param name="Text">A <c>&lt;data&gt;</c> literal between the gens.</param>
/// <param name="ConstantName">
/// Set beside <c>Text</c> for a named <c>&lt;data&gt;</c> — a constant field, and the only one that
/// costs no draw.
/// </param>
public sealed record Item(
    Field? Field = null, Gen? Gen = null, string? Text = null, string? ConstantName = null);

/// <summary>One branch of a conditional sequence; <c>IfExpr</c> is null on the fallback branch.</summary>
public sealed record Branch(string? IfExpr, Gen Gen);

/// <summary>
/// One declared column.
/// </summary>
/// <remarks>
/// <para>Three shapes, and exactly one of the three is set:</para>
/// <list type="bullet">
///   <item><c>Gen</c> — a single value per row.</item>
///   <item>
///     <c>Fields</c> — a compound: several named values that belong together, each registered
///     under <c>Name.Field</c>. A generated address is one thing, not four unrelated columns that
///     happen to sit next to each other.
///   </item>
///   <item>
///     <c>Branches</c> — a conditional: the first branch whose condition holds produces the value,
///     so a column can depend on another column's value.
///   </item>
/// </list>
/// </remarks>
/// <param name="Parent">
/// <c>null</c>, <c>"Name"</c> or <c>"Name.value"</c> — the rows this column applies to.
/// Declaration order matters: a child may only name a parent declared before it.
/// </param>
/// <param name="Compute">
/// A <c>&lt;compute&gt;</c> tree instead of a <c>&lt;gen&gt;</c>. Held as <c>object</c> so the
/// model does not depend on the parser's generated classes.
/// </param>
public sealed record SequenceSpec(
    string Name,
    string? Parent,
    Gen? Gen,
    IReadOnlyList<Field>? Fields = null,
    IReadOnlyList<Item>? Items = null,
    IReadOnlyList<Branch>? Branches = null,
    object? Compute = null,
    Mix? Mix = null,
    Switch? SwitchSpec = null,
    IReadOnlyList<IReadOnlyList<string>>? DistinctGroups = null,
    bool Uniq = false)
{
    public bool IsMix => Mix is not null;

    public bool IsSwitch => SwitchSpec is not null;

    /// <summary>A sequence whose value is derived rather than drawn.</summary>
    public bool IsComputed => Compute is not null;

    public bool IsCompound => Fields is not null;

    /// <summary>
    /// A body read as ONE ordered list: unnamed items concatenate into the sequence's own value,
    /// named ones are fields beside it.
    /// </summary>
    /// <remarks>
    /// One list rather than two, because a sequence's gens draw in declaration order and that order
    /// is part of the cross-language contract. Splitting the body into "fields" and "parts" would
    /// make the draw order something to remember instead of something the shape guarantees.
    /// </remarks>
    public bool IsComposed => Items is not null;

    public bool IsConditional => Branches is not null;
}

/// <summary>
/// One <c>&lt;data&gt;</c> piece of a line.
/// </summary>
/// <param name="IfExpr">
/// The <c>if</c> attribute, or <c>null</c>. A part whose condition is false contributes nothing —
/// which is how a trailing comma is omitted on the last record.
/// </param>
/// <param name="Name">
/// <c>name="…"</c> — present when the piece is a COLUMN rather than decoration. Text output
/// ignores it; a columnar format uses it as the column's name.
/// </param>
/// <param name="Type">
/// <c>type="…"</c> — a declared column type, or <c>null</c> to let the generator feeding it decide.
/// </param>
public sealed record DataPart(string Text, string? IfExpr, string? Name = null, string? Type = null);

/// <summary>
/// One <c>&lt;line&gt;</c> of output: its <c>&lt;data&gt;</c> children, in order.
/// </summary>
/// <param name="IfExpr">
/// The <c>if</c> attribute, or <c>null</c>. A line whose condition is false is dropped whole — and
/// it is dropped before the delimiters are placed, so the line above it does not keep a separator
/// pointing at nothing.
/// </param>
public sealed record Line(IReadOnlyList<DataPart> Parts, string? IfExpr, string? Each = null);

/// <summary>
/// Text emitted around the repeating body.
/// </summary>
/// <remarks>
/// Each is a list of lines, empty when the config does not declare that block. The three scopes
/// nest: the <c>*Block</c> pair wraps one record, the <c>*Line</c> pair wraps every line inside it,
/// and the two delimiters go only <em>between</em> records and between lines, never after the last
/// one. That last distinction is the whole reason a JSON config can be written at all — it is what
/// keeps a trailing comma off the final record.
/// </remarks>
public sealed record Fixtures(
    IReadOnlyList<Line> Before,
    IReadOnlyList<Line> After,
    IReadOnlyList<Line> BeforeBlock,
    IReadOnlyList<Line> AfterBlock,
    IReadOnlyList<Line> DelimiterBlock,
    IReadOnlyList<Line> BeforeLine,
    IReadOnlyList<Line> AfterLine,
    IReadOnlyList<Line> DelimiterLine)
{
    public static Fixtures Empty { get; } = new(
        Array.Empty<Line>(), Array.Empty<Line>(), Array.Empty<Line>(), Array.Empty<Line>(),
        Array.Empty<Line>(), Array.Empty<Line>(), Array.Empty<Line>(), Array.Empty<Line>());
}

/// <summary>
/// The parts of a config the engine works from.
/// </summary>
/// <remarks>
/// A deliberately small model: only what the golden fixtures exercise. Growing it one verified
/// fixture at a time is the point — a wider model with nothing checking it would just be a guess
/// about the reference implementation's behaviour.
/// </remarks>
/// <summary>
/// A <c>&lt;pool&gt;</c>: a small table computed once, before the rows.
///
/// A pool is a miniature <c>&lt;env&gt;</c> — its body holds the same
/// <c>&lt;sequence&gt;</c>, <c>&lt;mix&gt;</c>, <c>&lt;switch&gt;</c>, <c>&lt;uniq&gt;</c>
/// and <c>&lt;distinct&gt;</c>, and means the same thing by them. So it carries the fields
/// an <c>&lt;env&gt;</c> does, and the engine builds it with the ordinary machinery, handed
/// the member count where it usually gets the row count.
/// </summary>
public sealed class PoolSpec
{
    public PoolSpec(
        string name,
        int count,
        IReadOnlyList<SequenceSpec> sequences,
        IReadOnlyList<IReadOnlyList<string>> uniqGroups,
        IReadOnlyList<IReadOnlyList<string>> distinctGroups)
    {
        Name = name;
        Count = count;
        Sequences = sequences.ToArray();
        UniqGroups = uniqGroups.Select(g => (IReadOnlyList<string>)g.ToArray()).ToArray();
        DistinctGroups = distinctGroups.Select(g => (IReadOnlyList<string>)g.ToArray()).ToArray();
    }

    public string Name { get; }

    /// <summary>How many members. Separate from <c>&lt;env count&gt;</c>.</summary>
    public int Count { get; }

    public IReadOnlyList<SequenceSpec> Sequences { get; }

    public IReadOnlyList<IReadOnlyList<string>> UniqGroups { get; }

    public IReadOnlyList<IReadOnlyList<string>> DistinctGroups { get; }
}

public sealed class Config
{
    public Config(
        int count,
        string seed,
        string? locale,
        string? inject,
        int regexMaxLength,
        IReadOnlyList<SequenceSpec> sequences,
        IReadOnlyList<Line> block,
        Fixtures fixtures,
        string? mode = null,
        string? engine = null,
        IReadOnlyList<IReadOnlyList<string>>? envUniqGroups = null,
        IReadOnlyList<IReadOnlyList<string>>? envDistinctGroups = null,
        IReadOnlyList<PoolSpec>? pools = null)
    {
        Count = count;
        Seed = seed;
        Locale = locale;
        Inject = inject;
        RegexMaxLength = regexMaxLength;
        Sequences = sequences.ToArray();
        Block = block.ToArray();
        Fixtures = fixtures;
        Mode = mode;
        Engine = engine;
        EnvUniqGroups = DeepCopy(envUniqGroups);
        EnvDistinctGroups = DeepCopy(envDistinctGroups);
        Pools = pools is null ? Array.Empty<PoolSpec>() : pools.ToArray();
    }

    public int Count { get; }

    public string Seed { get; }

    public string? Locale { get; }

    public string? Inject { get; }

    public int RegexMaxLength { get; }

    public IReadOnlyList<SequenceSpec> Sequences { get; }

    public IReadOnlyList<Line> Block { get; }

    /// <summary>Every <c>&lt;pool&gt;</c> declared in <c>&lt;env&gt;</c>.</summary>
    public IReadOnlyList<PoolSpec> Pools { get; }

    public Fixtures Fixtures { get; }

    /// <summary>
    /// <c>&lt;env mode="memory"|"disk"&gt;</c> — how much of a run may be held at once, or
    /// <c>null</c> when the config does not say.
    /// </summary>
    public string? Mode { get; }

    /// <summary><c>&lt;env engine="1"|"2"|"3"&gt;</c> — an engine asked for outright.</summary>
    public string? Engine { get; }

    public IReadOnlyList<IReadOnlyList<string>> EnvUniqGroups { get; }

    public IReadOnlyList<IReadOnlyList<string>> EnvDistinctGroups { get; }

    /// <summary>
    /// A copy with the runtime parameters replaced; a <c>null</c> argument keeps what
    /// <c>&lt;env&gt;</c> declared.
    /// </summary>
    /// <remarks>
    /// Code wins over the file. A test that pins <c>seed</c> needs that value to hold even when the
    /// config it borrowed carries a seed of its own — otherwise the override would be advice rather
    /// than a setting.
    /// </remarks>
    public Config Override(int? newCount, string? newSeed, string? newLocale) =>
        new(
            newCount ?? Count,
            newSeed ?? Seed,
            newLocale ?? Locale,
            Inject,
            RegexMaxLength,
            Sequences,
            Block,
            Fixtures,
            Mode,
            Engine,
            EnvUniqGroups,
            EnvDistinctGroups,
            Pools);

    /// <summary>
    /// A copy whose engine selection comes from the caller rather than from <c>&lt;env&gt;</c>.
    /// </summary>
    /// <remarks>
    /// The two settings replace each other rather than layering, because they answer the same
    /// question at different levels of detail: naming an engine says which one, naming a mode says
    /// what the run may cost. Keeping the file's <c>engine="1"</c> alongside a caller's
    /// <c>mode="disk"</c> would let the more specific of the two win from the wrong source — the
    /// router reads the engine first, so the config would quietly beat the command line.
    /// </remarks>
    public Config WithEngineSelection(string? newEngine, string? newMode) =>
        newEngine is null && newMode is null
            ? this
            : new Config(
                Count,
                Seed,
                Locale,
                Inject,
                RegexMaxLength,
                Sequences,
                Block,
                Fixtures,
                newEngine is null ? newMode : null,
                newEngine,
                EnvUniqGroups,
                EnvDistinctGroups,
                Pools);

    private static IReadOnlyList<IReadOnlyList<string>> DeepCopy(
        IReadOnlyList<IReadOnlyList<string>>? groups) =>
        groups is null
            ? Array.Empty<IReadOnlyList<string>>()
            : groups.Select(g => (IReadOnlyList<string>)g.ToArray()).ToArray();
}
