using System.Globalization;
using Tdcv2.Sequence;
using System.Text.RegularExpressions;
using Antlr4.Runtime;
using Antlr4.Runtime.Tree;
using Tdcv2.Date;
using Tdcv2.Distribution;
using Tdcv2.Errors;
using Tdcv2.Format;
using Tdcv2.Generators;
using Tdcv2.Output;
using Tdcv2.Packs;
using Tdcv2.Parser;

namespace Tdcv2.Validation;

/// <summary>
/// Checks a config before it runs, and reports what is wrong by stable code.
/// </summary>
/// <remarks>
/// <para>
/// This exists because "the same config produces the same data everywhere" is only half a promise if
/// one implementation accepts what another refuses. A config that runs in C# and fails in TypeScript
/// is a portability bug even when no value was ever wrong.
/// </para>
/// <para>
/// The grammar is deliberately permissive — it lets any element nest anywhere — so every rule about
/// <em>where</em> a tag may live is owned here rather than by the parser. That keeps the grammar
/// shared and small while the rules stay readable.
/// </para>
/// <para>
/// Codes and their meanings come from the reference. Nothing is invented here: a rule that exists in
/// one implementation and not the other is exactly the divergence this file is meant to prevent.
/// </para>
/// </remarks>
public sealed class Validator
{
    /// <summary>What may sit directly inside <c>&lt;tdc&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> TdcChildren = Set("env", "block");

    /// <summary>
    /// What each closed tag reads.
    /// </summary>
    /// <remarks>
    /// An attribute a tag does not read is a request the config made and silently did not get, which
    /// is indistinguishable from a typo — and the data comes out looking fine either way.
    /// <c>comment</c> is accepted everywhere: it is documented as a note that never renders, and
    /// refusing it on a tag that happens not to list it would be a pointless trap.
    /// </remarks>
    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> ClosedTagAttributes =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            ["env"] = Set("count", "seed", "local", "inject", "mode", "engine", "comment"),
            ["sequence"] = Set("name", "parent", "uniq", "comment"),
            ["line"] = Set("if", "each", "comment"),
            ["tdc"] = Set("version", "v", "regex_max_length", "comment"),
            ["mix"] = Set("name", "percent", "parent", "flag", "comment"),
            // `percent` is NOT here: a <switch> picks its case from `on=`, and <case>
            // requires `is=` (TDC137). The percentage short-form belongs to <mix>.
            ["switch"] = Set("name", "on", "comment"),
            ["case"] = Set("is", "if", "anomaly", "default", "comment"),
            ["map"] = Set("comment"),
            ["default"] = Set("comment"),
            ["data"] = Set("if", "pair", "name", "type", "comment"),
            ["pool"] = Set("name", "count", "comment"),
            // A group wrapper says what must hold BETWEEN the sequences inside it; it has
            // no settings of its own. uniq="true" is an attribute of <sequence>, not of
            // <uniq> — writing it on the wrapper is a common slip and now says so.
            ["uniq"] = Set("comment"),
            ["distinct"] = Set("comment"),
        };

    /// <summary>Constructs that live at env level; inside a &lt;sequence&gt; they are simply misplaced.</summary>
    private static readonly IReadOnlySet<string> MisplacedInSequence =
        Set("mix", "switch", "case", "default", "map");

    /// <summary>
    /// Which generator types actually read a given attribute.
    /// </summary>
    /// <remarks>
    /// An attribute in <see cref="GenAttrs"/> is spelled correctly for SOME generator; this says
    /// whether it means anything for THIS one. Without it a <c>min=</c>/<c>max=</c> on a number and
    /// a <c>range=</c> on anything but a date pass silently and are dropped.
    /// </remarks>
    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> AttributeOwners =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            // A list to walk — or, on a date, a range walked instead of drawn.
            ["order"] = Set("text", "file", "date"),
            ["cycle"] = Set("text", "file", "date"),

            // How far each row moves. A counter's stride and a walked date range mean the same
            // thing in their own units, which is why they borrow one word.
            ["step"] = Set("date", "increment", "decrement"),
            ["weekdays"] = Set("date"),

            // Where the characters come from.
            ["alphabet"] = Set("symbol"),

            // The external source and how to read it. `pattern` is here because a drawn curve is
            // loaded the same way — src="curve.svg", src="curve.png".
            // Only `pool` takes a filter: everywhere else there are no candidates
            // to narrow, and the row-level question is `if=`.
            ["filter"] = Set("pool"),
            ["src"] = Set("file", "http", "pattern"),
            ["column"] = Set("file"),
            ["header"] = Set("file"),
            ["delimiter"] = Set("file"),
            ["row"] = Set("file"),

            // The network generator's own knobs.
            ["in"] = Set("http"),
            ["on_error"] = Set("http"),
            ["timeout"] = Set("http"),

            // The drawn curve.
            ["points"] = Set("pattern"),
            ["upper"] = Set("pattern"),
            ["lower"] = Set("pattern"),
            ["y_range"] = Set("pattern"),
            ["interp"] = Set("pattern"),
            ["spread"] = Set("pattern"),
            ["ink_threshold"] = Set("pattern"),

            // The synthetic series.
            ["base"] = Set("timeseries", "running"),
            ["trend"] = Set("timeseries"),
            ["period"] = Set("timeseries"),
            ["amplitude"] = Set("timeseries"),
            ["noise"] = Set("timeseries"),

            // Zero-padding a numeric range.
            ["first_zero"] = Set("number"),

            // The legacy two-date span, read by the date generator and by the `date.range` builtin
            // template. On a number it is the wrong word for value="10..99" — and silently gave
            // single digits.
            ["range"] = Set("date", "template"),
        };

    /// <summary>
    /// Parameters of the named distributions.
    /// </summary>
    /// <remarks>
    /// They shape the DRAW, so they mean nothing unless <c>distribution=</c> asked for one —
    /// <c>min="10" max="20"</c> on a plain number is the trap this catches. Gated on the attribute
    /// rather than on the type, because that is how the engine reads them.
    /// </remarks>
    private static readonly IReadOnlySet<string> DistributionParams = Set(
        "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
        "min", "max", "lambda", "beta", "s", "n");

    /// <summary>
    /// The two template paths no pack backs, and the parameters each reads.
    /// </summary>
    /// <remarks>
    /// A pack declares its own parameters and is judged against the registry; these two would
    /// otherwise be checked by nobody, and <c>oldst="30"</c> for <c>oldest</c> is the same silent
    /// failure <c>persent</c> used to be.
    /// </remarks>
    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> BuiltinTemplateParams =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            ["person.b_day"] = Set("oldest", "youngest", "format", "precision"),
            ["date.range"] = Set("range", "format", "precision"),
        };

    /// <summary>What any template takes regardless of which path it names.</summary>
    private static readonly IReadOnlySet<string> TemplateCommonAttrs =
        Set("type", "value", "name", "local", "count", "percent", "weight", "if");

    private static readonly IReadOnlyDictionary<string, string> PlacementHints =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["gen"] = "A <gen> lives inside a <sequence> (or a <case> of a <mix>/<switch>).",
            ["mix"] = "A <mix> is a named env-level construct — declare it directly in <env> and "
                + "use ${{Name}}.",
            ["switch"] = "A <switch> is a named env-level construct — declare it directly in <env> "
                + "and use ${{Name}}.",
            ["case"] = "A <case> belongs inside a <mix> or a <switch>.",
            ["map"] = "A <map> belongs inside a <switch>.",
            ["default"] = "A <default> belongs inside a <switch>.",
            ["line"] = "A <line> belongs inside a <block> (or a before/after fixture).",
            ["sequence"] = "A <sequence> belongs directly inside <env>.",
        };

    /// <summary>The binary operators the evaluator implements. Anything else is refused, not ignored.</summary>
    private static readonly IReadOnlyList<string> SupportedBinaryOperators =
        new[] { "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/" };

    private static readonly IReadOnlyList<string> SupportedUnaryOperators = new[] { "!", "-", "+" };

    /// <summary>What may sit directly inside <c>&lt;env&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> EnvChildren = Set(
        "sequence", "mix", "switch", "pool", "uniq", "distinct", "before", "after", "before_block",
        "after_block", "delimiter_block", "before_line", "after_line", "delimiter_line");

    /// <summary>
    /// Everything a <c>&lt;gen&gt;</c> may carry, whatever its type.
    ///
    /// Eight names are deliberately ABSENT: <c>seed</c>, <c>engine</c>, <c>version</c> and
    /// <c>inject</c> belong to <c>&lt;env&gt;</c> or <c>&lt;tdc&gt;</c>, <c>uniq</c> to
    /// <c>&lt;sequence&gt;</c>, <c>is</c> to <c>&lt;case&gt;</c>, <c>on</c> to
    /// <c>&lt;switch&gt;</c>, <c>v</c> to <c>&lt;tdc&gt;</c>. This was one flat union of every
    /// attribute name in the language, so writing any of them on a <c>&lt;gen&gt;</c> passed in
    /// silence here while the reference refused it.
    /// </summary>
    private static readonly IReadOnlySet<string> GenAttrs = Set(
        "type", "value", "name", "if", "comment", "case", "mask", "order", "cycle", "repeat",
        "separator", "accumulate", "of", "reset", "missing", "missing_as", "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "flag", "local", "count", "weight", "percent", "first_zero", "include", "exclude",
        "length", "decimals", "distribution", "regex_max_length", "alphabet", "format", "from",
        "to", "oldest", "youngest", "precision", "range", "step", "weekdays", "src", "column",
        "header",
        "delimiter", "row", "base", "trend", "period", "amplitude", "noise", "points", "upper",
        "lower", "y_range", "interp", "spread", "ink_threshold", "mode", "in", "on_error",
        "timeout", "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
        "lambda", "n", "s", "beta", "min", "max", "filter");

    private static readonly IReadOnlySet<string> GenTypes = Set(
        "text", "file", "template", "number", "regex", "advanced_regex", "symbol", "date",
        "increment", "decrement", "timeseries", "pattern", "http", "pool", "running");

    /// <summary>
    /// Template paths that are generators rather than pack files.
    /// </summary>
    /// <remarks>
    /// No pack is named after them, so looking them up on disk would report a missing address for
    /// the two paths that always work.
    /// </remarks>
    private static readonly IReadOnlySet<string> BuiltinTemplatePaths =
        Set("person.b_day", "date.range");

    /// <summary>The document versions this runtime understands.</summary>
    private const string SupportedVersion = "0.1.0";

    private static readonly Regex Interpolation =
        new(@"\$\{\{([^}]+)}}", RegexOptions.Compiled);

    private static readonly Regex VersionText =
        new(@"^\d+(?:\.\d+)*$", RegexOptions.Compiled);

    private readonly List<Diagnostic> _diagnostics = new();
    private readonly string? _baseDir;
    private readonly DataPacks? _packs;
    private int _documentRegexMaxLength = RegexGen.DefaultMaxLength;
    private string _locale = "en";

    /// <summary>
    /// The run length from <c>&lt;env count="…"&gt;</c>. Needed by checks whose answer depends on
    /// SIZE rather than shape — a <c>uniq</c> column costs nothing at a hundred rows and gigabytes
    /// at ten million.
    /// </summary>
    private long _envCount;

    /// <summary>Every sequence name the config declares — what an interpolation may refer to.</summary>
    private readonly HashSet<string> _declaredNames = new(StringComparer.Ordinal);

    /// <summary>
    /// Of those, the ones declared at the TOP level — which is what a <c>filter=</c> compares
    /// against. A pool's members share no namespace with the run's, so a pool holding an
    /// <c>id</c> must not collide with the run's <c>id</c>, nor look like an ambiguity.
    /// </summary>
    private readonly HashSet<string> _envNames = new(StringComparer.Ordinal);

    /// <summary>The sequences declared BEFORE the one being walked — see CheckRunning.</summary>
    private IReadOnlyList<string> _declaredOrder = System.Array.Empty<string>();

    /// <summary>Field names per <c>&lt;pool&gt;</c>, and the sequences drawing a member.</summary>
    private readonly Dictionary<string, List<string>> _poolFields = new(StringComparer.Ordinal);

    /// <summary>Of those fields, the ones whose value list the config writes down — TDC225.</summary>
    private readonly Dictionary<string, Dictionary<string, List<string>>> _poolFieldValues =
        new(StringComparer.Ordinal);

    /// <summary>Every pool a <c>&lt;gen type="pool"&gt;</c> names, gathered before the walk.</summary>
    private readonly HashSet<string> _poolsRead = new(StringComparer.Ordinal);

    private readonly HashSet<string> _poolReferences = new(StringComparer.Ordinal);

    private readonly HashSet<TDCParser.OpenCloseElementContext> poolMemberNodes = new();

    /// <summary>Those of them that produce a list, which is what <c>each=</c> may walk.</summary>
    private readonly HashSet<string> _repeatingNames = new(StringComparer.Ordinal);

    /// <summary>
    /// Of the declared names, the compounds: every <c>&lt;gen&gt;</c> named, so the sequence is a
    /// group of fields and produces no value of its own — which is what <c>parent=</c> filters on.
    /// </summary>
    private readonly HashSet<string> _valuelessNames = new(StringComparer.Ordinal);

    /// <summary>
    /// Sequences whose produced values are plainly the list in their <c>value=</c>.
    /// </summary>
    /// <remarks>
    /// Which is what lets <c>if="Gender.Mail"</c> be caught: the dot on a plain sequence asks
    /// about a VALUE, and here the values are known. Only recorded where nothing rewrites them —
    /// see <see cref="FiniteTextValues"/>.
    /// </remarks>
    private readonly Dictionary<string, List<string>> _finiteValues = new(StringComparer.Ordinal);

    /// <summary>Operators whose right side may be a bare word rather than a name.</summary>
    private static readonly HashSet<string> ComparisonOperators = new(StringComparer.Ordinal)
    {
        "==", "!=", "===", "!==", "<", ">", "<=", ">=",
    };

    /// <summary>
    /// Every <c>if=</c> seen, where its complaint belongs in the report, and whether the builtins
    /// of an <c>each=</c> line are in scope.
    /// </summary>
    /// <remarks>
    /// The names cannot be checked as the walk passes: an expression may name a sequence declared
    /// BELOW it, and the run resolves that happily, so checking mid-walk would invent errors on
    /// configs that work.
    /// </remarks>
    private readonly List<(int At, string Expression, int Line, int Column, bool Each)>
        _pendingExpressions = new();

    /// <summary>
    /// Every <c>filter=</c> seen, and where its complaint belongs in the report.
    /// </summary>
    /// <remarks>
    /// Held back for the same reason an <c>if=</c> is: the column a filter compares against may be
    /// declared BELOW the reference, and the run resolves that happily.
    /// </remarks>
    private readonly List<(int At, string Expression, string Pool, string Field, string Other,
        int Line, int Column)> _pendingPoolFilters = new();

    private Validator(string? baseDir, DataPacks? packs)
    {
        _baseDir = baseDir;
        _packs = packs;
    }

    public static IReadOnlyList<Diagnostic> Validate(TDCParser.DocumentContext document) =>
        Validate(document, null, null);

    /// <param name="baseDir">Where a relative <c>src=</c> resolves from — the config file's own folder.</param>
    public static IReadOnlyList<Diagnostic> Validate(
        TDCParser.DocumentContext document, string? baseDir, DataPacks? packs)
    {
        var v = new Validator(baseDir, packs);
        v.Run(document);
        if (packs is null)
        {
            return v._diagnostics;
        }

        // A pack file the address scan read and could not place — TDC171. Reported after the walk
        // because the scan is what the walk's own lookups trigger: asking before it has run would
        // always find nothing.
        var found = new List<Diagnostic>(v._diagnostics);
        found.AddRange(packs.HeaderWarnings());
        return found;
    }

    /// <summary>The folders a file source may name. Absent packs mean none were configured.</summary>
    private IReadOnlyList<string> DataRoots =>
        _packs?.DataRoots ?? Array.Empty<string>();

    private void Run(TDCParser.DocumentContext document)
    {
        TDCParser.OpenCloseElementContext? tdc = FindElement(document, "tdc");
        if (tdc is null)
        {
            // A point, not a span: the complaint is that the document begins without a <tdc>, so
            // whatever does begin there is not the thing being complained about.
            _diagnostics.Add(Diagnostic.ErrorAt(
                "TDC001", "document has no <tdc> root element",
                "Wrap your configuration in a single <tdc>…</tdc> root tag.", 1, 0));
            return;
        }

        CheckVersion(tdc);
        CheckRegexMaxLength(tdc);
        try
        {
            _documentRegexMaxLength =
                RegexGen.ParseMaxLength(Attributes(tdc.attr()).GetValueOrDefault("regex_max_length"));
        }
        catch (ArgumentException)
        {
            _documentRegexMaxLength = RegexGen.DefaultMaxLength;
        }

        TDCParser.OpenCloseElementContext? env = FindElement(tdc.content(), "env");
        TDCParser.OpenCloseElementContext? block = FindElement(tdc.content(), "block");
        if (block is null)
        {
            Error(
                "TDC002", "<tdc> has no <block> child — nothing to render",
                "<block> describes the layout of each generated card. Add a <block>…</block> "
                + "inside <tdc>.",
                Line(tdc), Column(tdc));
        }

        CheckTdcChildren(tdc);
        if (env is not null)
        {
            CheckEnv(env);
        }

        if (block is not null)
        {
            CheckBlock(block);
        }

        // Two second passes, pools before expressions. Both splice their complaints back at the
        // position the attribute was found, so the report still reads top to bottom; running the
        // pool pass first is what makes the two independent — an expression's recorded position is
        // relative to the walk, and re-splicing it after another pass has inserted would need that
        // pass's shifts as well.
        this.RunPendingPoolFilters();

        // Now that every name is known, the expressions can be checked — and each complaint goes
        // back where its attribute was, so the report stays in source order.
        var pending = new List<(int At, string Expression, int Line, int Column, bool Each)>(
            _pendingExpressions);
        _pendingExpressions.Clear();
        int shift = 0;
        foreach ((int at, string expression, int line, int column, bool each) in pending)
        {
            int before = _diagnostics.Count;
            CheckExpressionNames(expression, line, column, each);
            var found = _diagnostics.GetRange(before, _diagnostics.Count - before);
            _diagnostics.RemoveRange(before, _diagnostics.Count - before);
            _diagnostics.InsertRange(at + shift, found);
            shift += found.Count;
        }
    }

    /// <summary>
    /// <c>&lt;tdc&gt;</c> holds <c>&lt;env&gt;</c> and <c>&lt;block&gt;</c>, and a self-closing
    /// spelling of either is refused rather than honoured in part.
    /// </summary>
    /// <remarks>
    /// <c>&lt;env count="3" seed="demo"/&gt;</c> parses, and then every attribute on it is
    /// discarded: the run silently falls back to a default count on a random seed. Half-honouring it
    /// is worse than refusing it.
    /// </remarks>
    private void CheckTdcChildren(TDCParser.OpenCloseElementContext tdc)
    {
        foreach (TDCParser.ElementContext child in tdc.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null)
            {
                string name = self.name.Text;
                if (name is "env" or "block")
                {
                    Error(
                        "TDC014",
                        $"<{name}/> cannot be self-closing — its attributes and children would be "
                        + "ignored",
                        $"Write <{name}> … </{name}>.", Line(self), Column(self));
                    continue;
                }

                Error(
                    "TDC010", $"unknown child of <tdc>: \"<{name}>\"",
                    "Allowed children: env, block.", Line(self), Column(self));
                continue;
            }

            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && !TdcChildren.Contains(open.name.Text))
            {
                Error(
                    "TDC010", $"unknown child of <tdc>: \"<{open.name.Text}>\"",
                    "Allowed children: env, block.", Line(open), Column(open));
            }
        }
    }

    // ── document ─────────────────────────────────────────────────────────────────────────────

    private void CheckVersion(TDCParser.OpenCloseElementContext tdc)
    {
        CheckClosedTagAttrs("tdc", tdc.attr(), Line(tdc), Column(tdc));
        IReadOnlyDictionary<string, string> attrs = Attributes(tdc.attr());
        string? versionAttr = attrs.GetValueOrDefault("version");
        string? shortAttr = attrs.GetValueOrDefault("v");

        if (versionAttr is not null && shortAttr is not null)
        {
            Error(
                "TDC003", "both \"version\" and \"v\" are present on <tdc>",
                "Use one of them. They mean the same thing.", Line(tdc), Column(tdc));
            return;
        }

        string? raw = versionAttr ?? shortAttr;
        if (raw is null)
        {
            return;
        }

        // Any dot-separated numeric version: "0.1", "0.1.0", "1.2.3". Insisting on exactly two
        // parts would reject the version this runtime itself declares.
        if (!VersionText.IsMatch(raw.Trim()))
        {
            (int line, int column) = At(tdc, versionAttr is not null ? "version" : "v");
            Error(
                "TDC004", $"invalid TDC document version \"{raw}\"",
                "Use dot-separated numeric versions, e.g. \"0.1\", \"0.1.0\", or \"1.2.3\".",
                line, column);
            return;
        }

        // A document from the future may use tags this runtime has never heard of, and rendering it
        // as best we can would produce data that is quietly missing whatever it did not understand.
        if (CompareVersions(raw, SupportedVersion) > 0)
        {
            (int line, int column) = At(tdc, versionAttr is not null ? "version" : "v");
            Error(
                "TDC005",
                $"document version \"{raw}\" is newer than this runtime supports "
                + $"({SupportedVersion})",
                "Update the library, or lower the version attribute.", line, column);
        }
    }

    private static int CompareVersions(string a, string b)
    {
        string[] x = a.Split('.');
        string[] y = b.Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int xi = i < x.Length ? int.Parse(x[i]) : 0;
            int yi = i < y.Length ? int.Parse(y[i]) : 0;
            if (xi != yi)
            {
                return xi.CompareTo(yi);
            }
        }

        return 0;
    }

    private void CheckRegexMaxLength(TDCParser.OpenCloseElementContext tdc)
    {
        string? raw = Attributes(tdc.attr()).GetValueOrDefault("regex_max_length");
        if (raw is null)
        {
            return;
        }

        if (!int.TryParse(raw.Trim(), out int value) || value <= 0)
        {
            (int line, int column) = At(tdc, "regex_max_length");
            Error(
                "TDC096", $"regex_max_length must be a positive integer, got \"{raw}\"",
                "It caps how long a generated regex value may be.", line, column);
        }
    }

    // ── env ──────────────────────────────────────────────────────────────────────────────────

    // ── a share below one whole row ───────────────────────────────────────────────────────

    /// <summary>A <c>percent</c> share that asks for less than one whole row.</summary>
    /// <remarks>
    /// <c>percent</c> is an exact quota over the rows that reach it, not a chance rolled per row.
    /// Ten percent of a five-row subset asks for HALF a record, and half a record cannot be
    /// emitted — so the branch produces one or none and the seed alone decides which. The engine
    /// rounds and says nothing, which is how a column that came out empty reads as a config that
    /// was never written rather than one that rounded away.
    /// <para>
    /// The denominator is knowable for the shapes people write: <c>count</c> at the top of
    /// <c>&lt;env&gt;</c>, <c>count</c> × a parent's share, or <c>count</c> × the share a
    /// <c>&lt;switch&gt;</c> branch matches. Where the subject writes no shares of its own this
    /// stays SILENT — a check that guessed would fire on working configs and be turned off.
    /// </para>
    /// </remarks>
    private void CheckSmallShares(TDCParser.OpenCloseElementContext env)
    {
        if (_envCount <= 0)
        {
            return;
        }

        var shares = new Dictionary<string, Dictionary<string, double>>(StringComparer.Ordinal);
        foreach (TDCParser.OpenCloseElementContext child in OpenChildren(env))
        {
            switch (child.name.Text)
            {
                case "sequence":
                    this.ReadSequenceShares(child, shares);
                    break;
                case "mix":
                    this.ReportThin(
                        child, BranchCount(child),
                        this.RowsOf(Attributes(child.attr()).GetValueOrDefault("parent"), shares));
                    break;
                case "switch":
                    this.ReadSwitchShares(child, shares);
                    break;
                default:
                    break;
            }
        }
    }

    /// <summary>Record what a sequence's values are worth, and check its own share.</summary>
    private void ReadSequenceShares(
        TDCParser.OpenCloseElementContext seq,
        Dictionary<string, Dictionary<string, double>> shares)
    {
        IReadOnlyDictionary<string, string> seqAttrs = Attributes(seq.attr());
        double? rows = this.RowsOf(seqAttrs.GetValueOrDefault("parent"), shares);

        // A `<gen …/>` is SELF-CLOSING, and one written as `<gen …></gen>` is not. Both are the
        // sequence's generator, so both are collected.
        var gens = new List<Antlr4.Runtime.ParserRuleContext>();
        var genAttrs = new List<IReadOnlyDictionary<string, string>>();
        if (seq.content() is not null)
        {
            foreach (TDCParser.ElementContext c in seq.content().element())
            {
                TDCParser.SelfClosingElementContext self = c.selfClosingElement();
                TDCParser.OpenCloseElementContext open = c.openCloseElement();
                if (self is not null && self.name.Text == "gen")
                {
                    gens.Add(self);
                    genAttrs.Add(Attributes(self.attr()));
                }
                else if (open is not null && open.name.Text == "gen")
                {
                    gens.Add(open);
                    genAttrs.Add(Attributes(open.attr()));
                }
            }
        }

        if (gens.Count != 1)
        {
            return;
        }

        IReadOnlyDictionary<string, string> attrs = genAttrs[0];
        if (attrs.GetValueOrDefault("type") != "text")
        {
            return;
        }

        var values = new List<string>();
        foreach (string v in (attrs.GetValueOrDefault("value") ?? "").Split(','))
        {
            if (v.Trim().Length > 0)
            {
                values.Add(v.Trim());
            }
        }

        string? mask = attrs.GetValueOrDefault("percent");
        if (values.Count == 0 || mask is null)
        {
            return;
        }

        double[]? percents = SafeExpand(mask, values.Count);
        if (percents is null)
        {
            return;
        }

        string? name = seqAttrs.GetValueOrDefault("name");
        if (!string.IsNullOrEmpty(name) && rows is not null)
        {
            var table = new Dictionary<string, double>(StringComparer.Ordinal);
            for (int i = 0; i < values.Count; i++)
            {
                table[values[i]] = percents[i] / 100;
            }

            shares[name] = table;
        }

        this.ReportThinAttrs(attrs, gens[0], values.Count, rows);
    }

    /// <summary>Each <c>&lt;case is="X"&gt;</c>, with the rows that value takes.</summary>
    private void ReadSwitchShares(
        TDCParser.OpenCloseElementContext switchEl,
        Dictionary<string, Dictionary<string, double>> shares)
    {
        string? subject = Attributes(switchEl.attr()).GetValueOrDefault("on");
        if (subject is null || !shares.TryGetValue(subject, out Dictionary<string, double>? table))
        {
            return;
        }

        foreach (TDCParser.OpenCloseElementContext caseEl in OpenChildren(switchEl))
        {
            if (caseEl.name.Text != "case")
            {
                continue;
            }

            string? isValue = Attributes(caseEl.attr()).GetValueOrDefault("is");
            if (isValue is null)
            {
                continue;
            }

            // `is="US|CA"` matches either, so the branch takes both their shares.
            double fraction = 0;
            bool known = true;
            foreach (string key in isValue.Split('|'))
            {
                if (table.TryGetValue(key.Trim(), out double share))
                {
                    fraction += share;
                }
                else
                {
                    known = false;
                }
            }

            if (!known)
            {
                continue;
            }

            foreach (TDCParser.OpenCloseElementContext inner in OpenChildren(caseEl))
            {
                if (inner.name.Text == "mix")
                {
                    this.ReportThin(inner, BranchCount(inner), _envCount * fraction);
                }
            }
        }
    }

    /// <summary>How many <c>&lt;case&gt;</c> branches a <c>&lt;mix&gt;</c> holds.</summary>
    private static int BranchCount(TDCParser.OpenCloseElementContext mix)
    {
        int n = 0;
        foreach (TDCParser.OpenCloseElementContext c in OpenChildren(mix))
        {
            if (c.name.Text == "case")
            {
                n++;
            }
        }

        return n;
    }

    /// <summary>Rows reaching something with this <c>parent</c>, or null when unresolvable.</summary>
    private double? RowsOf(string? parent, Dictionary<string, Dictionary<string, double>> shares)
    {
        if (string.IsNullOrWhiteSpace(parent))
        {
            return _envCount;
        }

        int at = parent.IndexOf('.', StringComparison.Ordinal);
        if (at < 0)
        {
            return null;
        }

        return shares.TryGetValue(parent[..at], out Dictionary<string, double>? table)
            && table.TryGetValue(parent[(at + 1)..], out double share)
            ? _envCount * share
            : null;
    }

    /// <summary>The mask, or null when it does not parse — somebody else's diagnostic.</summary>
    private static double[]? SafeExpand(string mask, int values)
    {
        try
        {
            return PercentMask.Expand(mask, values);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void ReportThin(
        TDCParser.OpenCloseElementContext el, int branches, double? rows) =>
        this.ReportThinAttrs(Attributes(el.attr()), el, branches, rows);

    /// <summary>Report the smallest share that asks for less than a row, once per element.</summary>
    private void ReportThinAttrs(
        IReadOnlyDictionary<string, string> own, Antlr4.Runtime.ParserRuleContext el,
        int branches, double? rows)
    {
        if (rows is not > 0 || branches <= 0)
        {
            return;
        }

        string? mask = own.GetValueOrDefault("percent");
        if (mask is null)
        {
            return;
        }

        // `repeat=` plans the quota over ELEMENTS, not rows: three per row over four rows is
        // twelve draws, and `repeat="1..3"` does not even fix how many. Rows is the wrong
        // denominator here, so say nothing.
        if (!string.IsNullOrWhiteSpace(own.GetValueOrDefault("repeat")))
        {
            return;
        }

        double[]? percents = SafeExpand(mask, branches);
        if (percents is null)
        {
            return;
        }

        double? worst = null;
        foreach (double percent in percents)
        {
            if (percent <= 0)
            {
                continue; // a zero share asks for nothing on purpose
            }

            if (percent / 100 * rows.Value >= 1)
            {
                continue;
            }

            if (worst is null || percent < worst)
            {
                worst = percent;
            }
        }

        if (worst is null)
        {
            return;
        }

        this.Warn(
            "TDC251",
            $"percent=\"{TwoPlaces(worst.Value)}\" over {TwoPlaces(rows.Value)} rows asks for "
            + $"{TwoPlaces(worst.Value / 100 * rows.Value)} records — the result is 0 or 1, and "
            + "the seed decides which",
            "A share below one whole row cannot be emitted, so the branch fires once or not at "
            + "all. Raise the share, or raise count= until the share covers a whole row.",
            el.Start.Line, el.Start.Column);
    }

    /// <summary>Every child that is an open-close tag, in source order.</summary>
    private static List<TDCParser.OpenCloseElementContext> OpenChildren(
        TDCParser.OpenCloseElementContext parent)
    {
        var out_ = new List<TDCParser.OpenCloseElementContext>();
        if (parent.content() is null)
        {
            return out_;
        }

        foreach (TDCParser.ElementContext c in parent.content().element())
        {
            TDCParser.OpenCloseElementContext el = c.openCloseElement();
            if (el is not null)
            {
                out_.Add(el);
            }
        }

        return out_;
    }

    /// <summary>Two decimals at most, and no trailing zeros — <c>0.5</c>, not <c>0.50</c>.</summary>
    private static string TwoPlaces(double value)
    {
        double rounded = Math.Round(value, 2, MidpointRounding.AwayFromZero);
        return rounded == Math.Truncate(rounded)
            ? ((long)rounded).ToString(CultureInfo.InvariantCulture)
            : rounded.ToString(CultureInfo.InvariantCulture);
    }

    private void CheckEnv(TDCParser.OpenCloseElementContext env)
    {
        IReadOnlyDictionary<string, string> envAttrs = Attributes(env.attr());
        _locale = envAttrs.GetValueOrDefault("local", "en");

        string? count = envAttrs.GetValueOrDefault("count");
        if (count is not null && int.TryParse(count.Trim(), out int parsed) && parsed >= 0)
        {
            _envCount = parsed;
        }

        if (count is not null && (!int.TryParse(count.Trim(), out int n) || n < 0))
        {
            (int line, int column) = At(env, "count");
            Error(
                "TDC020", $"invalid count \"{count}\" — expected a non-negative integer",
                "count is how many records to generate.", line, column);
        }

        string? inject = envAttrs.GetValueOrDefault("inject");
        if (inject is not null && !inject.Contains('%'))
        {
            (int line, int column) = At(env, "inject");
            Error(
                "TDC021",
                $"inject pattern \"{inject}\" has no \"%\" placeholder — interpolation will never "
                + "match",
                "Use a single \"%\" where the sequence name should go, e.g. inject=\"${{%}}\".",
                line, column);
        }

        // A share below one whole row: its own pass, because the denominator of a <mix> in a
        // switch branch belongs to the switch and not to the walk that follows.
        this.CheckSmallShares(env);

        // Pools first, and only their shape: a reference may stand above the pool it names, and
        // complaining about an unknown field in that case would report the wrong problem.
        this.CollectPoolFields(env);
        this.CollectPoolFieldValues(env);
        this.CollectPoolReferences(env);
        CheckChildren(env.content(), "env", EnvChildren);
        foreach (TDCParser.ElementContext c in env.content().element())
        {
            TDCParser.OpenCloseElementContext el = c.openCloseElement();
            if (el is null)
            {
                continue;
            }

            string tag = el.name.Text;
            if (FixtureTagNames.Contains(tag))
            {
                // A fixture holds text and <line>s; anything else was ignored in silence.
                CheckChildren(el.content(), tag, FixtureChildren, "TDC131", FixtureChildren);
            }
            else if (tag == "pool")
            {
                // Tags with a reason of their own keep TDC230, which says far more; they
                // pass this check but are never offered as allowed.
                var passes = new HashSet<string>(PoolChildren);
                foreach (TDCParser.ElementContext inner in el.content().element())
                {
                    string? poolChildName = inner.openCloseElement()?.name.Text
                        ?? inner.selfClosingElement()?.name.Text;
                    if (poolChildName is not null && ForbiddenInPool(poolChildName) is not null)
                    {
                        passes.Add(poolChildName);
                    }
                }

                CheckChildren(el.content(), "pool", passes, "TDC010", PoolChildren);
            }
        }
        CheckClosedTagAttrs("env", env.attr(), Line(env), Column(env));

        var names = new HashSet<string>(StringComparer.Ordinal);
        var declared = new List<string>();
        _declaredOrder = declared;

        foreach (TDCParser.OpenCloseElementContext open in Declarations(env))
        {
            string tag = open.name.Text;
            CheckClosedTagAttrs(tag, open.attr(), Line(open), Column(open));
            IReadOnlyDictionary<string, string> attrs = Attributes(open.attr());
            string? name = attrs.GetValueOrDefault("name");
            if (string.IsNullOrWhiteSpace(name))
            {
                Error(
                    "TDC030", $"<{tag}> is missing a required \"name\" attribute",
                    "A sequence is referenced by name, so it needs one.", Line(open), Column(open));
            }
            else if (Checks.IsBuiltin(name))
            {
                (int line, int column) = At(open, "name");
                Error(
                    "TDC033", $"sequence name \"{name}\" collides with a builtin",
                    "Builtins: " + string.Join(", ", Checks.Builtins.OrderBy(b => b, StringComparer.Ordinal)) + ".",
                    line, column);
            }
            else if (name.StartsWith('_'))
            {
                // The leading underscore is the engine's namespace. Letting a config into it means a
                // future builtin would silently shadow somebody's column.
                (int line, int column) = At(open, "name");
                Error(
                    "TDC031", $"sequence name \"{name}\" starts with \"_\" — reserved for builtins",
                    "User sequences should avoid the leading underscore.", line, column);
            }
            else if (!this.poolMemberNodes.Contains(open) && !names.Add(name))
            {
                (int line, int column) = At(open, "name");
                Error(
                    "TDC032", $"duplicate sequence name \"{name}\"",
                    "Two sequences cannot share a name — the second would shadow the first.",
                    line, column);
            }

            // Declaration order decides who can filter whom: a parent must already exist, because
            // the rows it selects are what the child is built over.
            string? parent = attrs.GetValueOrDefault("parent");
            if (!string.IsNullOrWhiteSpace(parent))
            {
                int dot = parent.IndexOf('.');
                string parentName = dot < 0 ? parent : parent[..dot];
                if (parentName.Length == 0)
                {
                    (int line, int column) = At(open, "parent");
                    Error(
                        "TDC034", $"invalid parent reference \"{parent}\"",
                        "Syntax: parent=\"ParentName\" or parent=\"ParentName.Value\".",
                        line, column);
                }
                else if (!declared.Contains(parentName))
                {
                    (int line, int column) = At(open, "parent");
                    Error(
                        "TDC035",
                        $"parent sequence \"{parentName}\" is not declared before this sequence",
                        "Move the parent above it. A child is built over the rows its parent "
                        + "selected.",
                        line, column);
                }
                else if (_valuelessNames.Contains(parentName))
                {
                    // A parent selects rows by the VALUE it produced. A compound is a group of
                    // fields and produces none, so no row can ever match — the run used to
                    // discover that and report the parent as unknown, sending the reader after a
                    // name that is declared right above.
                    (int line, int column) = At(open, "parent");
                    Error(
                        "TDC214",
                        $"compound sequence \"{parentName}\" has no value of its own to filter on",
                        "A parent is chosen by the value it produced, e.g. parent=\"Gender.Male\". "
                        + $"\"{parentName}\" is a group of fields and produces none — name one of "
                        + "its fields, or a sequence that has a single value.",
                        line, column);
                }
            }

            switch (tag)
            {
                case "switch":
                    CheckSwitch(open, declared);
                    break;
                case "mix":
                    CheckMix(open);
                    break;
                case "sequence":
                    // Size, not shape: what this column will COST at this run length.
                    CheckUniqMemory(open, name);
                    CheckSequenceBody(open, name);
                    CheckSequenceDataAttrs(open);
                    CheckComputeBody(open);
                    break;
            }

            foreach (TDCParser.ElementContext inner in open.content().element())
            {
                CheckGensIn(inner);
            }

            if (!string.IsNullOrWhiteSpace(name))
            {
                declared.Add(name);
                _declaredNames.Add(name);
                if (!this.poolMemberNodes.Contains(open))
                {
                    _envNames.Add(name);
                    this.RegisterPoolReference(open, name);
                }
                // A compound's fields are referenced as Name.Field, and a flag column is a name
                // too. Fields inside a <distinct> wrapper are ordinary fields, so they count as
                // well.
                CollectFieldNames(open, name);
                foreach (string key in new[] { "flag", "anomaly_flag" })
                {
                    string? extra = attrs.GetValueOrDefault(key);
                    if (!string.IsNullOrWhiteSpace(extra))
                    {
                        _declaredNames.Add(extra);
                    }
                }
            }
        }
    }

    /// <summary>
    /// Every sequence-like declaration in <c>&lt;env&gt;</c>, in the order they appear.
    /// </summary>
    /// <remarks>
    /// A <c>&lt;uniq&gt;</c> or <c>&lt;distinct&gt;</c> wrapper is not a declaration of its own — it
    /// says what must hold between the sequences inside it. So its children are flattened into the
    /// same list, and each is checked, named and ordered exactly as if it had been written directly
    /// under <c>&lt;env&gt;</c>. Anything else would make wrapping a sequence change what the
    /// sequence is.
    /// </remarks>
    /// <summary>Field names per pool, gathered before the members are walked.</summary>
    private void CollectPoolFields(TDCParser.OpenCloseElementContext env)
    {
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null || open.name.Text != "pool")
            {
                continue;
            }

            string? name = Attributes(open.attr()).GetValueOrDefault("name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            var fields = new List<string>();
            foreach (TDCParser.ElementContext member in open.content().element())
            {
                TDCParser.OpenCloseElementContext inner = member.openCloseElement();
                if (inner is null)
                {
                    continue;
                }

                if (inner.name.Text is "sequence" or "mix" or "switch")
                {
                    this.AddMemberFields(fields, inner);
                }
                else if (inner.name.Text is "uniq" or "distinct")
                {
                    foreach (TDCParser.ElementContext w in inner.content().element())
                    {
                        TDCParser.OpenCloseElementContext wrapped = w.openCloseElement();
                        if (wrapped is not null)
                        {
                            this.AddMemberFields(fields, wrapped);
                        }
                    }
                }
            }

            _poolFields[name] = fields;
        }
    }

    /// <summary>
    /// The values each pool field can hold, where the config says them outright.
    /// </summary>
    /// <remarks>
    /// A member whose body is one unnamed <c>&lt;gen type="text" value="A,B"&gt;</c> produces
    /// nothing but <c>A</c> and <c>B</c>, so the set recorded here is a SUPERSET of what the built
    /// pool will hold — a pool of two members drawn from three values holds at most two of them.
    /// That direction is what TDC225 needs: a value outside the superset can match no member,
    /// whatever the draw turns out to be.
    /// </remarks>
    private void CollectPoolFieldValues(TDCParser.OpenCloseElementContext env)
    {
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null || open.name.Text != "pool")
            {
                continue;
            }

            string? name = Attributes(open.attr()).GetValueOrDefault("name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            var fields = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (TDCParser.OpenCloseElementContext member in PoolMemberNodesOf(open))
            {
                string? field = Attributes(member.attr()).GetValueOrDefault("name");
                if (string.IsNullOrWhiteSpace(field))
                {
                    continue;
                }

                List<string>? values = LiteralTextValues(member);
                if (values is not null)
                {
                    fields[field] = values;
                }
            }

            _poolFieldValues[name] = fields;
        }
    }

    /// <summary>Every declaration inside a pool, flattened out of any group wrapper.</summary>
    private static List<TDCParser.OpenCloseElementContext> PoolMemberNodesOf(
        TDCParser.OpenCloseElementContext pool)
    {
        var result = new List<TDCParser.OpenCloseElementContext>();
        foreach (TDCParser.ElementContext member in pool.content().element())
        {
            TDCParser.OpenCloseElementContext inner = member.openCloseElement();
            if (inner is null)
            {
                continue;
            }

            if (inner.name.Text is "sequence" or "mix" or "switch")
            {
                result.Add(inner);
            }
            else if (inner.name.Text is "uniq" or "distinct")
            {
                foreach (TDCParser.ElementContext w in inner.content().element())
                {
                    TDCParser.OpenCloseElementContext wrapped = w.openCloseElement();
                    if (wrapped is not null && wrapped.name.Text is "sequence" or "mix" or "switch")
                    {
                        result.Add(wrapped);
                    }
                }
            }
        }

        return result;
    }

    /// <summary>The literal <c>value=</c> list of a member whose body is a single plain text gen.</summary>
    private static List<string>? LiteralTextValues(TDCParser.OpenCloseElementContext member)
    {
        var gens = new List<IReadOnlyDictionary<string, string>>();
        foreach (TDCParser.ElementContext child in member.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            string? tag = self is not null ? self.name.Text : open?.name.Text;
            if (tag == "gen")
            {
                gens.Add(self is not null ? Attributes(self.attr()) : Attributes(open!.attr()));
            }
        }

        if (gens.Count != 1 || gens[0].ContainsKey("name"))
        {
            return null;
        }

        return FiniteTextValues(gens[0]);
    }

    /// <summary>
    /// Every pool named by a <c>&lt;gen type="pool" value="…"&gt;</c>, anywhere under
    /// <c>&lt;env&gt;</c>.
    /// </summary>
    /// <remarks>
    /// Collected in one descent rather than tallied during the walk, because a reference may stand
    /// above the pool it names and TDC231 has to know about it by the time that pool is reached.
    /// </remarks>
    private void CollectPoolReferences(TDCParser.OpenCloseElementContext node)
    {
        foreach (TDCParser.ElementContext child in node.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            string? tag = self is not null ? self.name.Text : open?.name.Text;
            if (tag is null)
            {
                continue;
            }

            if (tag == "gen")
            {
                IReadOnlyDictionary<string, string> attrs =
                    self is not null ? Attributes(self.attr()) : Attributes(open!.attr());
                if (attrs.GetValueOrDefault("type") == "pool")
                {
                    _poolsRead.Add(attrs.GetValueOrDefault("value", string.Empty).Trim());
                }

                continue;
            }

            if (open is not null)
            {
                this.CollectPoolReferences(open);
            }
        }
    }

    /// <summary>A pool nobody draws from.</summary>
    /// <remarks>
    /// A warning rather than an error, on the same reasoning as TDC234: the config runs, and every
    /// row is exactly what it would have been. What it costs is the build — a pool is computed in
    /// full before the first row and held in memory for the whole run — so an unread
    /// <c>count="50000"</c> is paid for and thrown away. It is also the shape a rename leaves
    /// behind, where the reference points at a new pool and the old one sits there looking
    /// deliberate.
    /// </remarks>
    private void CheckPoolIsRead(TDCParser.OpenCloseElementContext pool)
    {
        string? name = Attributes(pool.attr()).GetValueOrDefault("name");
        if (string.IsNullOrWhiteSpace(name) || _poolsRead.Contains(name))
        {
            return;
        }

        Warn(
            "TDC231",
            $"pool \"{name}\" is never drawn from",
            "A pool is built in full before the first row and kept in memory for the whole run, so "
            + "an unread one costs its members for nothing. Read it with "
            + $"<gen type=\"pool\" value=\"{name}\"/>, or remove it.",
            Line(pool),
            Column(pool));
    }

    /// <summary>
    /// A <c>&lt;pool&gt;</c>'s own attributes and the tags it may hold.
    ///
    /// What is inside a legal child is NOT checked here — the pool's members go through the same
    /// checks the top level gets, which is the whole point of the construct.
    /// </summary>
    private void CheckPool(TDCParser.OpenCloseElementContext node)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(node.attr());
        int line = Line(node);
        int column = Column(node);
        string? name = attrs.GetValueOrDefault("name");
        if (string.IsNullOrWhiteSpace(name))
        {
            Error(
                "TDC222", "<pool> has no name",
                "A pool is read by name: <pool name=\"Doctors\" count=\"30\">, then "
                + "<gen type=\"pool\" value=\"Doctors\"/>.",
                line, column);
        }

        string? raw = attrs.GetValueOrDefault("count");
        if (string.IsNullOrWhiteSpace(raw))
        {
            string shown = string.IsNullOrWhiteSpace(name) ? "" : $" name=\"{name}\"";
            Error(
                "TDC222", $"<pool{shown}> has no count",
                "count is how many members the table holds — thirty doctors for two thousand "
                + "patients: count=\"30\".",
                line, column);
        }
        else if (!long.TryParse(raw.Trim(), out long count) || count < 1)
        {
            Error(
                "TDC223", $"<pool> count \"{raw}\" is not a whole number of members",
                "Use a whole number of at least 1 — a pool of nothing has no member to hand out.",
                line, column);
        }
        else if (count > Pool.MaxMembers)
        {
            Error(
                "TDC235",
                $"<pool> holds {count:N0} members — more than the {Pool.MaxMembers:N0} a pool may hold",
                "A pool is kept in memory for the whole run (measured: ~320 bytes a member with "
                + "four fields), so this would cost hundreds of megabytes before the first row. "
                + "If you meant the number of ROWS, that is count on <env>.",
                line, column);
        }
        else if (count > Pool.WarnMembers)
        {
            Warn(
                "TDC234",
                $"<pool> holds {count:N0} members and stays in memory for the whole run",
                "Measured at ~320 bytes a member with four fields — 100,000 members cost about "
                + "29 MB. It works; it is worth being deliberate about. If you meant the number "
                + "of ROWS, that is count on <env>.",
                line, column);
        }

        foreach (TDCParser.ElementContext child in node.content().element())
        {
            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            string? reason = inner is null ? null : ForbiddenInPool(inner.name.Text);
            if (reason is null)
            {
                continue;
            }

            Error(
                "TDC230", $"<{inner!.name.Text}> cannot live inside a <pool>", reason + ".",
                Line(inner), Column(inner));
        }
    }

    /// <summary>
    /// What one member contributes to its pool's field list.
    ///
    /// Usually its own name. A member that is itself a reference to another pool contributes
    /// that pool's fields under its name instead — <c>at</c> pointing at <c>Clinics</c> gives
    /// <c>at.city</c> and no bare <c>at</c>, because a record has no value to print. Only pools
    /// declared ABOVE are visible, which is exactly what the engine can compute.
    /// </summary>
    private void AddMemberFields(List<string> fields, TDCParser.OpenCloseElementContext node)
    {
        string? name = Attributes(node.attr()).GetValueOrDefault("name");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        string? target = MemberPoolRef(node);
        if (target is null || !_poolFields.TryGetValue(target, out List<string>? nested))
        {
            fields.Add(name);
            return;
        }

        foreach (string field in nested)
        {
            fields.Add($"{name}.{field}");
        }
    }

    /// <summary>
    /// A member that draws from another pool may only name a pool declared ABOVE.
    ///
    /// The engine builds pools in declaration order, so this is not a style rule: a pool named
    /// below has no table yet when this one is computed, and a pool naming itself never would.
    /// Both used to pass validation and produce a member with no fields, which surfaced far away
    /// as "not a field of R" — blaming the line that reads for a mistake in the declaration.
    /// Declaration order is also the entire cycle check: a cycle cannot be written down.
    /// </summary>
    private void CheckPoolMemberRefs(
        TDCParser.OpenCloseElementContext pool, IReadOnlyList<string> above)
    {
        string poolName = Attributes(pool.attr()).GetValueOrDefault("name") ?? "";
        foreach (TDCParser.OpenCloseElementContext member in PoolMemberNodes(pool))
        {
            string? target = MemberPoolRef(member);
            if (target is null || above.Contains(target, StringComparer.Ordinal))
            {
                continue;
            }

            bool itself = string.Equals(target, poolName, StringComparison.Ordinal);
            string message = itself
                ? $"pool \"{poolName}\" draws from itself"
                : $"pool \"{poolName}\" draws from \"{target}\", which is not declared above it";
            string hint = itself
                ? "A pool is built before its own members exist, so there is nothing to draw. "
                : "Pools are built in declaration order, so a pool can only read the pools above "
                    + $"it. Move \"{target}\" above \"{poolName}\". ";
            Error(
                "TDC236",
                message,
                hint + "That order is also why a cycle between pools cannot be written down.",
                Line(member),
                Column(member));
        }
    }

    /// <summary>Every declaration inside a pool, flattened out of any group wrapper.</summary>
    private static List<TDCParser.OpenCloseElementContext> PoolMemberNodes(
        TDCParser.OpenCloseElementContext pool)
    {
        var out_ = new List<TDCParser.OpenCloseElementContext>();
        foreach (TDCParser.ElementContext child in pool.content().element())
        {
            TDCParser.OpenCloseElementContext member = child.openCloseElement();
            if (member is null)
            {
                continue;
            }

            if (member.name.Text is "sequence" or "mix" or "switch")
            {
                out_.Add(member);
            }
            else if (member.name.Text is "uniq" or "distinct")
            {
                foreach (TDCParser.ElementContext w in member.content().element())
                {
                    TDCParser.OpenCloseElementContext wrapped = w.openCloseElement();
                    if (wrapped is not null)
                    {
                        out_.Add(wrapped);
                    }
                }
            }
        }

        return out_;
    }

    /// <summary>The pool a member draws from, when the member is a <c>&lt;gen type="pool"&gt;</c>.</summary>
    private static string? MemberPoolRef(TDCParser.OpenCloseElementContext node)
    {
        foreach (TDCParser.ElementContext child in node.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            string? tag = self?.name.Text ?? open?.name.Text;
            if (tag != "gen")
            {
                continue;
            }

            IReadOnlyDictionary<string, string> attrs =
                self is not null ? Attributes(self.attr()) : Attributes(open!.attr());
            if (attrs.GetValueOrDefault("type") != "pool")
            {
                continue;
            }

            return (attrs.GetValueOrDefault("value") ?? "").Trim();
        }

        return null;
    }

    private static string? ForbiddenInPool(string tag) => tag switch
    {
        "block" => "a pool has no output of its own — it is a table other columns read",
        "before" or "after" or "before_block" or "after_block" or "delimiter_block"
            or "before_line" or "after_line" or "delimiter_line" =>
            "fixtures describe a file, and a pool is not written to one",
        "pool" => "a pool stays a flat table — point one pool at another instead of nesting them",
        _ => null,
    };

    /// <summary>Publish <c>Ref.field</c> for a <c>&lt;gen type="pool"&gt;</c>.</summary>
    private void RegisterPoolReference(TDCParser.OpenCloseElementContext sequence, string name)
    {
        foreach (TDCParser.ElementContext child in sequence.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            string? tag = self?.name.Text ?? open?.name.Text;
            if (tag != "gen")
            {
                continue;
            }

            IReadOnlyDictionary<string, string> attrs =
                self is not null ? Attributes(self.attr()) : Attributes(open!.attr());
            if (attrs.GetValueOrDefault("type") != "pool")
            {
                continue;
            }

            int line = self is not null ? Line(self) : Line(open!);
            int column = self is not null ? Column(self) : Column(open!);
            string poolName = (attrs.GetValueOrDefault("value") ?? "").Trim();
            if (!_poolFields.TryGetValue(poolName, out List<string>? fields))
            {
                Error(
                    "TDC224",
                    $"<gen type=\"pool\"> draws from \"{poolName}\", which is not a declared pool",
                    _poolFields.Count == 0
                        ? "Declare it first: <pool name=\"…\" count=\"…\"> inside the same <env>."
                        : "Declared pools: " + string.Join(", ", _poolFields.Keys.OrderBy(k => k, StringComparer.Ordinal)) + ".",
                    line, column);
                continue;
            }

            this.CheckPoolFilter(attrs, poolName, fields, line, column);
            foreach (string field in fields)
            {
                _declaredNames.Add($"{name}.{field}");
            }

            // The reference itself is a record, not a value: nothing to print.
            _valuelessNames.Add(name);
            _poolReferences.Add(name);
        }
    }

    /// <summary>
    /// What <c>filter=</c> may name.
    ///
    /// A qualified <c>Pool.field</c> says exactly what it means, so a field the pool has not got
    /// is a certain mistake. An UNQUALIFIED unknown name is left alone: the expression language
    /// reads a bare word as a string literal, which is how <c>filter="c == North"</c> says
    /// "northern only".
    /// </summary>
    private void CheckPoolFilter(
        IReadOnlyDictionary<string, string> attrs,
        string poolName,
        List<string> fields,
        int line,
        int column)
    {
        string? expression = attrs.GetValueOrDefault("filter");
        if (string.IsNullOrWhiteSpace(expression))
        {
            return;
        }

        foreach (Match m in Regex.Matches(expression, @"([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)"))
        {
            if (m.Groups[1].Value != poolName || fields.Contains(m.Groups[2].Value))
            {
                continue;
            }

            Error(
                "TDC226",
                $"filter= reads \"{m.Value}\", but pool \"{poolName}\" has no field \"{m.Groups[2].Value}\"",
                fields.Count == 0
                    ? $"Pool \"{poolName}\" declares no fields."
                    : $"Fields of \"{poolName}\": " + string.Join(", ", fields) + ".",
                line, column);
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(expression, @"[A-Za-z_][A-Za-z0-9_]*"))
        {
            string word = m.Value;
            if (!seen.Add(word) || !fields.Contains(word) || !_envNames.Contains(word))
            {
                continue;
            }

            Error(
                "TDC232",
                $"\"{word}\" in filter= is both a field of pool \"{poolName}\" and a sequence — which one is meant is not decidable",
                $"Rename one of them. Qualifying one side (\"{poolName}.{word}\") does not help: "
                + $"the other \"{word}\" still reads as the member's field, so the test would "
                + "compare a value with itself.",
                line, column);
        }

        // `field == Something` — the one filter shape a check can decide, recognised the same way
        // the engine's fast path recognises it, by looking at the text rather than a parsed tree,
        // so what the reader sees and what is checked are the same thing.
        string[] sides = expression!.Split("==");
        if (sides.Length != 2)
        {
            return;
        }

        string left = sides[0].Trim();
        string right = sides[1].Trim();
        if (!Regex.IsMatch(left, @"^[A-Za-z_][A-Za-z0-9_]*$")
            || !Regex.IsMatch(right, @"^[A-Za-z_][A-Za-z0-9_]*$"))
        {
            return;
        }

        bool leftIsField = fields.Contains(left);
        bool rightIsField = fields.Contains(right);
        // Both sides a field compares the candidate with itself, which is a different mistake.
        if (leftIsField == rightIsField)
        {
            return;
        }

        _pendingPoolFilters.Add((
            _diagnostics.Count,
            expression.Trim(),
            poolName,
            leftIsField ? left : right,
            leftIsField ? right : left,
            line,
            column));
    }

    /// <summary>
    /// The put-aside filters, decided now that every column is known.
    /// </summary>
    /// <remarks>
    /// What can be said before a single value exists: the member's field and the other side of the
    /// <c>==</c> each draw from a set the config writes down, and when those two sets do not
    /// overlap the filter can never match — not on some row, on every row. The run already refuses
    /// that, on row one, after building the pool; saying it at check time costs nothing.
    /// Only DISJOINT sets are reported: a value that is merely rare is a refusal waiting for the
    /// row that draws it, and <c>percent="100,0"</c> may never draw it at all.
    /// </remarks>
    private void RunPendingPoolFilters()
    {
        var pending = new List<(int At, string Expression, string Pool, string Field, string Other,
            int Line, int Column)>(_pendingPoolFilters);
        _pendingPoolFilters.Clear();
        int shift = 0;
        foreach ((int at, string expression, string pool, string field, string other, int line,
            int column) in pending)
        {
            if (!_poolFieldValues.TryGetValue(pool, out Dictionary<string, List<string>>? byField)
                || !byField.TryGetValue(field, out List<string>? fieldValues)
                || fieldValues.Count == 0)
            {
                continue;
            }

            // A name no sequence has is a bare word, and the expression language reads a bare word
            // as its own text — that is how filter="clinic == North" says "northern only". So it
            // is a set of exactly one value.
            bool isColumn = _declaredNames.Contains(other);
            List<string>? otherValues = isColumn
                ? _finiteValues.GetValueOrDefault(other)
                : new List<string> { other };
            if (otherValues is null || otherValues.Count == 0)
            {
                continue;
            }

            if (otherValues.Any(fieldValues.Contains))
            {
                continue;
            }

            string message = isColumn
                ? $"filter=\"{expression}\" can never match — no value \"{other}\" produces is a "
                    + $"\"{field}\" any member of pool \"{pool}\" could hold"
                : $"filter=\"{expression}\" can never match — no member of pool \"{pool}\" holds "
                    + $"\"{field}\" = \"{other}\"";
            string produced = isColumn
                ? $"\"{other}\" produces: " + string.Join(", ", otherValues) + ". "
                : string.Empty;
            _diagnostics.Insert(
                at + shift,
                Diagnostic.Error(
                    "TDC225",
                    message,
                    $"\"{field}\" is drawn from: " + string.Join(", ", fieldValues) + ". "
                        + produced
                        + "A filter narrows the members a row may draw from, and every row would "
                        + "be left with none.",
                    line,
                    column));
            shift += 1;
        }
    }

    private List<TDCParser.OpenCloseElementContext> Declarations(
        TDCParser.OpenCloseElementContext env)
    {
        var result = new List<TDCParser.OpenCloseElementContext>();
        var poolsAbove = new List<string>();
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null)
            {
                continue;
            }

            string tag = open.name.Text;
            if (tag is "sequence" or "mix" or "switch")
            {
                result.Add(open);
            }
            else if (tag == "pool")
            {
                // A pool node is not a declaration, so the env walk never reached its own
                // attributes — every one of them, including a typo, used to pass in silence.
                CheckClosedTagAttrs("pool", open.attr(), Line(open), Column(open));
                // A pool's members are declarations too — checked exactly as at the top level —
                // but its names are ITS columns, not the run's, so they are recorded separately
                // and kept out of the shared namespace.
                this.CheckPool(open);
                // Only the pools ALREADY seen: a member may draw from one of those and from
                // nothing else, which is what makes a cycle unwritable.
                this.CheckPoolMemberRefs(open, poolsAbove);
                string? declaredPool = Attributes(open.attr()).GetValueOrDefault("name");
                if (!string.IsNullOrWhiteSpace(declaredPool) && poolsAbove.Contains(declaredPool))
                {
                    // The second pool quietly replaced the first, and the only sign was a
                    // TDC193 in the block about a field that "does not exist".
                    Error(
                        "TDC241",
                        $"duplicate pool name \"{declaredPool}\"",
                        "A pool is reached by name, so two of them cannot share one. Rename or remove the second.",
                        Line(open),
                        Column(open));
                }
                else if (!string.IsNullOrWhiteSpace(declaredPool))
                {
                    poolsAbove.Add(declaredPool);
                }

                this.CheckPoolIsRead(open);

                foreach (TDCParser.ElementContext member in open.content().element())
                {
                    TDCParser.OpenCloseElementContext inner = member.openCloseElement();
                    if (inner is null)
                    {
                        continue;
                    }

                    if (inner.name.Text is "sequence" or "mix" or "switch")
                    {
                        this.poolMemberNodes.Add(inner);
                        result.Add(inner);
                    }
                    else if (inner.name.Text is "uniq" or "distinct")
                    {
                        int wrappedCount = 0;
                        foreach (TDCParser.ElementContext w in inner.content().element())
                        {
                            TDCParser.OpenCloseElementContext wrapped = w.openCloseElement();
                            if (wrapped is not null
                                && wrapped.name.Text is "sequence" or "mix" or "switch")
                            {
                                wrappedCount++;
                                this.poolMemberNodes.Add(wrapped);
                                result.Add(wrapped);
                            }
                        }

                        this.CheckGroupSize(inner, inner.name.Text, wrappedCount);
                    }
                }
            }
            else if (tag is "uniq" or "distinct")
            {
                // A group wrapper is not a declaration either — same gap, same fix.
                CheckClosedTagAttrs(tag, open.attr(), Line(open), Column(open));
                int members = 0;
                foreach (TDCParser.ElementContext inner in open.content().element())
                {
                    TDCParser.OpenCloseElementContext wrapped = inner.openCloseElement();
                    if (wrapped is null)
                    {
                        continue;
                    }

                    // A <mix> or <switch> inside the group is a member and a declaration both
                    // — without this the name never exists and every reference reads as
                    // undeclared.
                    if (wrapped.name.Text == "mix" || wrapped.name.Text == "switch")
                    {
                        members++;
                        result.Add(wrapped);
                    }
                    else if (wrapped.name.Text == "sequence")
                    {
                        members++;
                        CheckEnvGroupMember(wrapped, tag);
                        result.Add(wrapped);
                    }
                }

                CheckGroupSize(open, tag, members);
            }
        }

        return result;
    }

    /// <summary>
    /// A group of fewer than two sequences constrains nothing.
    /// </summary>
    /// <remarks>
    /// It used to be dropped in silence: check called the config valid and the
    /// run drew repeats anyway. A warning rather than an error — the config
    /// still runs, it just does not do what it was written for.
    /// </remarks>
    private void CheckGroupSize(TDCParser.OpenCloseElementContext wrapper, string tag, int members)
    {
        if (members >= 2)
        {
            return;
        }

        string counted = members == 0 ? "no sequences" : "one sequence";
        string hint = tag == "uniq"
            ? "Put at least two <sequence> members in it, or drop the wrapper and write "
                + "uniq=\"true\" on the one sequence — that draws without replacement."
            : "Put at least two <sequence> members in it, or drop the wrapper: there is nothing "
                + "for a single value to differ from.";

        Warn(
            "TDC221",
            $"<{tag}> wraps {counted} — a group constrains its members against each other, so it "
                + "does nothing here",
            hint,
            wrapper.Start.Line,
            wrapper.Start.Column);
    }

    /// <summary>
    /// A member of an env-level group has to produce one value per row.
    /// </summary>
    /// <remarks>
    /// The constraint is stated between sequences, so a compound has no single value to compare or
    /// to make unique. Refusing is the only honest answer: silently using its first field would
    /// enforce something the config did not ask for.
    /// </remarks>
    private void CheckEnvGroupMember(TDCParser.OpenCloseElementContext sequence, string tag)
    {
        int named = 0;
        int total = 0;
        foreach (TDCParser.ElementContext child in sequence.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                total++;
                if (Attributes(self.attr()).ContainsKey("name"))
                {
                    named++;
                }
            }
        }

        if (named > 0 || total > 1)
        {
            string name = Attributes(sequence.attr()).GetValueOrDefault("name") ?? "?";
            Error(
                "TDC129",
                $"<sequence name=\"{name}\"> inside a config-level <{tag}> must produce a single "
                + "value",
                $"A <{tag}> around sequences uses one value per sequence. Use a simple <gen> or a "
                + "<switch> sequence, not a compound (multi-field) one.",
                Line(sequence), Column(sequence));
        }
    }

    /// <summary>
    /// A <c>&lt;compute&gt;</c> sequence's tree, checked against everything declared so far.
    /// </summary>
    /// <remarks>
    /// Its <c>&lt;field&gt;</c> references can only name a sequence that already exists — the value
    /// is derived from the row, and a row is built in declaration order.
    /// </remarks>
    private void CheckComputeBody(TDCParser.OpenCloseElementContext sequence)
    {
        foreach (TDCParser.ElementContext child in sequence.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null || open.name.Text != "compute")
            {
                continue;
            }

            var known = new HashSet<string>(_declaredNames, StringComparer.Ordinal);
            known.UnionWith(Checks.Builtins);
            new ComputeCheck(_diagnostics).Check(open, known);
        }
    }

    /// <summary>Register <c>Name.Field</c> for every field, wherever in the sequence body it sits.</summary>
    private void CollectFieldNames(TDCParser.OpenCloseElementContext element, string name)
    {
        foreach (TDCParser.ElementContext child in element.content().element())
        {
            // A named <data> is a constant field and a real column, so a reference to it must not
            // read as a typo for a sequence nobody declared.
            if (child.dataElement() is TDCParser.DataWithBodyContext data)
            {
                string? constantName = Attributes(data.attr()).GetValueOrDefault("name");
                if (!string.IsNullOrWhiteSpace(constantName))
                {
                    _declaredNames.Add(name + "." + constantName);
                }

                continue;
            }

            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                IReadOnlyDictionary<string, string> genAttrs = Attributes(self.attr());
                string? field = genAttrs.GetValueOrDefault("name");
                if (!string.IsNullOrWhiteSpace(field))
                {
                    _declaredNames.Add(name + "." + field);
                }

                // anomaly_flag= sits on the <gen>, not on the <sequence>, and names a real column —
                // referencing it must not read as a typo for a sequence nobody declared.
                string? genFlag = genAttrs.GetValueOrDefault("anomaly_flag");
                if (!string.IsNullOrWhiteSpace(genFlag))
                {
                    _declaredNames.Add(genFlag);
                }

                try
                {
                    if (Checks.HasRepeat(genAttrs))
                    {
                        _repeatingNames.Add(name);
                    }
                }
                catch (ArgumentException)
                {
                    // A malformed repeat is reported by CheckRepeat; not this pass's business.
                }

                continue;
            }

            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            if (inner is not null && inner.name.Text == "distinct")
            {
                CollectFieldNames(inner, name);
            }
        }
    }

    /// <summary>A sequence must actually produce something, and a compound must name its fields.</summary>
    /// <summary>Bytes a value costs while <c>uniq</c> holds the column — MEASURED.</summary>
    private const long UniqBytesPerValue = 250;

    /// <summary>Where to start talking, matching <c>&lt;pool&gt;</c>'s TDC234 threshold.</summary>
    private const long UniqWarnRows = 100_000;

    /// <summary>
    /// <c>uniq</c> over many rows holds the whole column in memory — say so before the run.
    /// <para>A <c>&lt;pool&gt;</c> has warned since TDC234; <c>uniq</c> does the same thing and
    /// said nothing. 250 bytes a value is measured — peak RSS against row count, the slope over an
    /// eight-fold range; the table is in <c>typescript/src/validator/uniq-memory.ts</c>.</para>
    /// </summary>
    private void CheckUniqMemory(TDCParser.OpenCloseElementContext open, string? name)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(open.attr());
        if (attrs.GetValueOrDefault("uniq", "").Trim().ToLowerInvariant() != "true")
        {
            return;
        }

        if (_envCount < UniqWarnRows)
        {
            return;
        }

        double mb = _envCount * (double)UniqBytesPerValue / 1024 / 1024;
        string size = mb >= 1024
            ? $"{mb / 1024:F1} GB"
            : $"{Math.Round(mb):N0} MB";
        Warn(
            "TDC236",
            $"uniq on \"{name ?? "?"}\" holds all {_envCount:N0} values in memory for the whole "
            + $"run — about {size}",
            "Drawing without replacement means remembering what has been drawn, so this cannot "
            + "stream: the config runs on the in-memory engine whatever mode= asks for. Measured "
            + "at about 250 bytes a value. It works — it is worth being deliberate about at this "
            + "size.",
            Line(open), Column(open));
    }

    private void CheckSequenceBody(TDCParser.OpenCloseElementContext open, string? name)
    {
        // An invented tag here used to pass in SILENCE: the config validated, exit 0, and
        // the run went ahead as if the tag had done something.
        // MisplacedInSequence is handled by the dedicated loop below, which also counts
        // them so TDC036 stays quiet. Reporting them here as well printed the same TDC013
        // twice — invisible in the full report, obvious once the brief output put the two
        // lines together.
        var seqPasses = new HashSet<string>(SequenceChildren);
        seqPasses.UnionWith(MisplacedInSequence);
        CheckChildren(open.content(), "sequence", seqPasses, "TDC010", SequenceChildren);
        foreach (TDCParser.ElementContext c in open.content().element())
        {
            TDCParser.OpenCloseElementContext w = c.openCloseElement();
            if (w is not null && (w.name.Text == "distinct" || w.name.Text == "uniq"))
            {
                // The wrapper is allowed here, but its own body was never looked at.
                CheckChildren(w.content(), w.name.Text, DistinctChildren);
            }
        }

        var gens = new List<IReadOnlyDictionary<string, string>>();
        // Attributes and a position, rather than the typed node: a <gen> reaches here in
        // either punctuation, and pointing at it is all this list is ever used for.
        var genNodes = new List<GenNode>();
        bool hasCompute = false;
        TDCParser.OpenCloseElementContext? computeEl = null;
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            GenNode? self = GenNodeOf(child);
            if (self is not null)
            {
                gens.Add(Attributes(self.Attrs));
                genNodes.Add(self);
                continue;
            }

            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            if (inner is null)
            {
                continue;
            }

            if (inner.name.Text == "compute")
            {
                hasCompute = true;
                computeEl = inner;
            }
            else if (inner.name.Text == "distinct")
            {
                foreach (TDCParser.ElementContext g in inner.content().element())
                {
                    GenNode? gen = GenNodeOf(g);
                    if (gen is not null)
                    {
                        gens.Add(Attributes(gen.Attrs));
                        genNodes.Add(gen);
                    }
                }
            }
        }

        // A <sequence> holds only <gen> (optionally wrapped in <distinct>). A construct that belongs
        // at env level is a placement mistake — saying so beats letting it fall through to a
        // confusing "no <gen>", which names a symptom rather than the cause.
        int misplaced = 0;
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            string? tag = null;
            ParserRuleContext? node = null;
            if (child.mapElement() is { } map)
            {
                tag = "map";
                node = map;
            }
            else if (child.openCloseElement() is { } oc)
            {
                tag = oc.name.Text;
                node = oc;
            }
            else if (child.selfClosingElement() is { } sc)
            {
                tag = sc.name.Text;
                node = sc;
            }

            if (tag is not null && MisplacedInSequence.Contains(tag))
            {
                Error(
                    "TDC013", $"<{tag}> is not allowed directly inside <sequence>",
                    PlacementHints.GetValueOrDefault(tag, "")
                    + $" Allowed inside <sequence>: {string.Join(", ", SequenceChildren.OrderBy(a => a, StringComparer.Ordinal))}.",
                    node!.Start.Line, node.Start.Column);
                misplaced++;
            }
        }

        if (hasCompute && gens.Count > 0)
        {
            // One <sequence>, two producers. The engine cannot honour both, and the five
            // implementations did not even agree on which one to drop — same config,
            // different data. Refuse instead.
            Error(
                "TDC219",
                $"<compute> cannot sit beside a <gen> in <sequence name=\"{name ?? "?"}\"> \u2014 "
                    + "one of the two would be dropped",
                "A sequence either DERIVES its value with <compute> or DRAWS it with <gen>. "
                    + "Move the <compute> into its own <sequence> and read the drawn one from "
                    + "it with <field name=\"\u2026\"/>.",
                Line(computeEl!), Column(computeEl!));
        }

        if (hasCompute && gens.Count == 0)
        {
            UniqUnsupported(open, name, "<compute> processes the values it reads rather than drawing any of its own, so it cannot promise uniqueness");
        }

        if (gens.Count == 0 && !hasCompute && misplaced == 0)
        {
            Error(
                "TDC036", $"<sequence name=\"{name ?? "?"}\"> has no <gen> child",
                "A sequence needs at least one <gen type=\"…\"/> describing how values are made.",
                Line(open), Column(open));
            return;
        }

        // Conditional first, exactly as the reference orders it: gens carrying `if` are branches,
        // and a branch has no need of a name.
        if (gens.Any(g => g.ContainsKey("if")))
        {
            UniqUnsupported(
                open, name,
                "its value is picked per row from <gen if=\"…\"> branches rather than drawn as one pool, so it cannot promise uniqueness");
            return;
        }

        UniqOnComposed(open, name, gens);

        // Three readings, and the body says which: every gen named is a compound (several columns,
        // no value of its own), one unnamed gen alone is a simple sequence, and anything else
        // COMPOSES — the unnamed gens and the literals concatenate into the sequence's own value
        // while the named ones stay fields beside it. None of the three is an error, so the only
        // thing left to check is that two fields do not share a name.
        var fieldNames = new HashSet<string>(StringComparer.Ordinal);
        for (int g = 0; g < gens.Count; g++)
        {
            string? fieldName = gens[g].GetValueOrDefault("name");
            if (string.IsNullOrWhiteSpace(fieldName))
            {
                continue;
            }

            if (!fieldNames.Add(fieldName))
            {
                (int line, int column) =
                    At(genNodes[g].Attrs, "name", genNodes[g].Line, genNodes[g].Column);
                Error(
                    "TDC111",
                    $"duplicate field name \"{fieldName}\" inside compound <sequence "
                    + $"name=\"{name ?? "?"}\">",
                    "Each <gen name=\"…\"> within a compound sequence must have a unique name.",
                    line, column);
            }
        }

        // Compound: every gen named, and no literal to compose with. Recorded so a later parent=
        // naming this sequence can be refused before the run rather than during it.
        bool composes = false;
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            if (child.dataElement() is TDCParser.DataWithBodyContext literal
                && !string.IsNullOrWhiteSpace(
                    PairedData.Restore(literal.dataContent().GetText())))
            {
                composes = true;
                break;
            }
        }

        if (gens.Count > 0 && fieldNames.Count == gens.Count && !composes && name is not null)
        {
            _valuelessNames.Add(name);
        }

        // A simple body — one unnamed gen and nothing else — may say outright what it produces.
        if (gens.Count == 1 && fieldNames.Count == 0 && !composes && name is not null)
        {
            List<string>? values = FiniteTextValues(gens[0]);
            if (values is not null)
            {
                _finiteValues[name] = values;
            }
        }
    }

    /// <summary>A <c>&lt;data&gt;</c> inside a <c>&lt;sequence&gt;</c> reads <c>name</c> and nothing else.</summary>
    /// <remarks>
    /// It is a literal, or — with a name — a constant field. An output type belongs on the
    /// <c>&lt;data&gt;</c> in the <c>&lt;line&gt;</c>, where the column is actually emitted;
    /// dropping one here is the silent loss this whole reading was introduced to end.
    /// </remarks>
    private void CheckSequenceDataAttrs(TDCParser.OpenCloseElementContext open)
    {
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            if (child.dataElement() is not TDCParser.DataWithBodyContext body)
            {
                continue;
            }

            foreach (TDCParser.AttrContext attr in body.attr())
            {
                string attrName = attr.attrName.Text;
                if (attrName is "name" or "comment")
                {
                    continue;
                }

                (int line, int column) = At(body.attr(), attrName, Line(open), Column(open));
                Error(
                    "TDC015",
                    $"<data> inside <sequence> does not read \"{attrName}\" — it is ignored",
                    "Inside a <sequence> a <data> is a literal or, with name=\"…\", a constant "
                    + "field. Output types belong on the <data> in the <line>.",
                    line, column);
            }
        }
    }

    /// <summary>A mix needs branches, and only branches.</summary>
    private void CheckMix(TDCParser.OpenCloseElementContext open) => CheckMix(open, true);

    /// <param name="named">
    /// Whether this mix sits at env level and can therefore own a flag column. A nested one
    /// contributes a value to somebody else's column and has nowhere to put a flag.
    /// </param>
    private void CheckMix(TDCParser.OpenCloseElementContext open, bool named)
    {
        int cases = 0;
        bool anomalous = false;
        TDCParser.OpenCloseElementContext? firstAnomalous = null;
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            string? tag = inner?.name.Text ?? self?.name.Text;
            if (tag is null)
            {
                continue;
            }

            if (tag == "case")
            {
                cases++;
                if (inner is not null)
                {
                    if (Attributes(inner.attr()).GetValueOrDefault("anomaly") == "true")
                    {
                        anomalous = true;
                        firstAnomalous ??= inner;
                    }

                    CheckClosedTagAttrs("case", inner.attr(), Line(inner), Column(inner));
                    CheckCaseBody(inner);
                }

                continue;
            }

            int l = inner is not null ? Line(inner) : Line(self);
            int c = inner is not null ? Column(inner) : Column(self);
            Error("TDC124", $"unknown child of <mix>: \"<{tag}>\"", "Allowed children: case.", l, c);
        }

        IReadOnlyDictionary<string, string> mixAttrs = Attributes(open.attr());

        if (cases > 0)
        {
            (int line, int column) = At(open, "percent");
            CheckPercentMask(
                mixAttrs.GetValueOrDefault("percent"), cases,
                new[] { "TDC121", "TDC122", "TDC123" }, line, column);
        }
        else
        {
            Error(
                "TDC120", "<mix> has no <case> children",
                "Add at least one <case>...</case> inside <mix>.", Line(open), Column(open));
        }

        string? flag = mixAttrs.GetValueOrDefault("flag");
        if (flag is not null && !named)
        {
            (int line, int column) = At(open, "flag");
            Error(
                "TDC203",
                "\"flag\" on a nested <mix> is not supported — only a named env-level <mix> can "
                + "declare one",
                "A flag becomes its own sequence, so it needs a <mix name=\"…\"> at env level.",
                line, column);
            // One complaint per mix: whether its branches are marked is beside the point once the
            // flag itself cannot exist.
            return;
        }

        if (flag is null && firstAnomalous is not null)
        {
            // A branch marked as the outlier, and nothing recording which rows took it. The label is
            // the only reason to mark it, so the complaint points at the branch.
            (int line, int column) = At(firstAnomalous, "anomaly");
            Error(
                "TDC203",
                "anomaly=\"true\" on <case> does nothing — the enclosing <mix> declares no "
                + "flag=\"…\"",
                "Name the ground-truth column: <mix name=\"…\" flag=\"IsAnomaly\">.", line, column);
        }

        foreach (string listy in new[] { "repeat", "separator" })
        {
            if (mixAttrs.ContainsKey(listy))
            {
                (int line, int column) = At(open, listy);
                Error(
                    "TDC196",
                    $"\"{listy}\" is not supported on <mix> — it picks one branch, it does not "
                    + "produce a list",
                    "Put repeat= on the <gen> inside a <case>, or on a plain <sequence>.",
                    line, column);
            }
        }

        if (!string.IsNullOrWhiteSpace(flag) && cases > 0 && !anomalous)
        {
            // A label that is false on every row is not a label. It reads as ground truth and
            // teaches whatever consumes it that nothing is ever anomalous.
            (int line, int column) = At(open, "flag");
            Error(
                "TDC202",
                "flag=\"…\" but no <case> is marked anomaly=\"true\" — the column would be all "
                + "\"false\"",
                "Mark the outlier branch: <case anomaly=\"true\">…</case>.", line, column);
        }
    }

    private void CheckSwitch(TDCParser.OpenCloseElementContext open, List<string> declared) =>
        CheckSwitchForm(open, declared, true);

    /// <summary>
    /// <c>named</c> is false for the form written inside a <c>&lt;case&gt;</c>: it contributes a
    /// value to that branch rather than a column of its own, so it has no name to declare and
    /// nothing can interpolate it. Every other rule is the same, from this one method.
    /// </summary>
    private void CheckSwitchEntries(TDCParser.OpenCloseElementContext open) =>
        // The entries walk only ever looked at open/close children, so a self-closing
        // invention passed while <bogus></bogus> was caught.
        CheckChildren(open.content(), "switch", SwitchChildren, "TDC124", SwitchChildren);

    private void CheckSwitchForm(
        TDCParser.OpenCloseElementContext open, IReadOnlyList<string> declared, bool named)
    {
        CheckSwitchEntries(open);
        IReadOnlyDictionary<string, string> attrs = Attributes(open.attr());
        if (!named && attrs.GetValueOrDefault("name") is not null)
        {
            (int nameLine, int nameColumn) = At(open, "name");
            Error(
                "TDC245",
                "\"name\" on a nested <switch> is not supported — only an env-level <switch> "
                + "becomes a column",
                "A nested <switch> contributes its value to the <case> around it. Nothing can "
                + "interpolate it, so a name would name nothing. Move it to <env> if you want "
                + "${{Name}}.",
                nameLine, nameColumn);
        }

        string? on = attrs.GetValueOrDefault("on");
        if (string.IsNullOrWhiteSpace(on))
        {
            Error(
                "TDC133", "<switch> is missing a required \"on\" attribute",
                "A switch looks a value up; \"on\" names the sequence it looks up.",
                Line(open), Column(open));
        }
        else if (!declared.Contains(on))
        {
            (int line, int column) = At(open, "on");
            Error(
                "TDC134", $"<switch on=\"{on}\"> refers to an unknown sequence",
                "Declare the subject sequence above the switch.", line, column);
        }

        int entries = 0;
        foreach (TDCParser.ElementContext child in open.content().element())
        {
            if (child.mapElement() is { } map)
            {
                entries++;
                CheckMapRows(map);
                continue;
            }

            TDCParser.OpenCloseElementContext inner = child.openCloseElement();
            if (inner is null)
            {
                continue;
            }

            if (inner.name.Text == "case")
            {
                entries++;
                if (string.IsNullOrWhiteSpace(Attributes(inner.attr()).GetValueOrDefault("is")))
                {
                    Error(
                        "TDC137", "<case> inside <switch> is missing a required \"is\" attribute",
                        "A switch case matches a value; \"is\" is the value it matches.",
                        Line(inner), Column(inner));
                }

                CheckCaseBody(inner);
            }
            else if (inner.name.Text == "default")
            {
                entries++;
                CheckCaseBody(inner);
            }
        }

        if (entries == 0)
        {
            Error(
                "TDC135", "<switch> has no entries",
                "Add a <map>, a <case is=\"…\">, or a <default>.", Line(open), Column(open));
        }
    }

    /// <summary>Walk into a sequence body so a <c>&lt;gen&gt;</c> inside a <c>&lt;distinct&gt;</c> is checked too.</summary>
    private void CheckGensIn(TDCParser.ElementContext element)
    {
        TDCParser.SelfClosingElementContext self = element.selfClosingElement();
        if (self is not null && self.name.Text == "gen")
        {
            CheckGen(self);
            return;
        }

        TDCParser.OpenCloseElementContext open = element.openCloseElement();
        if (open is not null)
        {
            foreach (TDCParser.ElementContext inner in open.content().element())
            {
                CheckGensIn(inner);
            }
        }
    }

    // ── gen ──────────────────────────────────────────────────────────────────────────────────

    private void CheckGen(TDCParser.SelfClosingElementContext gen)
    {
        // A conditional gen carries `if` as its branch condition, and a plain one may have one
        // too. An expression here is an expression like any other: left unchecked, a branch that
        // can never be taken looks exactly like a branch nobody happened to hit.
        if (Attributes(gen.attr()).TryGetValue("if", out string? genCondition))
        {
            (int gl, int gc) = At(gen.attr(), "if", Line(gen), Column(gen));
            CheckIfExpression(genCondition, gl, gc);
            _pendingExpressions.Add((_diagnostics.Count, genCondition, gl, gc, false));
        }

        IReadOnlyDictionary<string, string> attrs = Attributes(gen.attr());
        string? type = attrs.GetValueOrDefault("type");

        if (string.IsNullOrWhiteSpace(type))
        {
            (int line, int column) = At(gen, "name");
            Error(
                "TDC040", "<gen> is missing a required \"type\" attribute",
                "Every generator names what it generates.", line, column);
        }
        else if (!GenTypes.Contains(type))
        {
            (int line, int column) = At(gen, "type");
            Error(
                "TDC041", $"unknown gen type \"{type}\"",
                "Known types: " + string.Join(", ", GenTypes.OrderBy(t => t, StringComparer.Ordinal)) + ".",
                line, column);
        }

        CheckRequiredValue(gen, attrs, type);
        CheckNumber(gen, attrs, type);
        CheckRegexes(gen, attrs, type);
        CheckSymbol(gen, attrs, type);
        CheckDate(gen, attrs, type);
        CheckRepeat(gen, attrs, type);

        CheckGenAttributes(gen, attrs, type);

        CheckWeight(gen, attrs, type);
        CheckSource(gen, attrs, type);
        CheckHttp(gen, attrs, type);
        CheckRunning(gen, attrs, type);
        CheckMask(gen, attrs);
        CheckCounter(gen, attrs, type);
        CheckDateTemplates(gen, attrs, type);
        CheckCaseAndOrder(gen, attrs);
        this.CheckImperfections(gen, attrs, type);

        if (type == "text" && attrs.ContainsKey("percent"))
        {
            (int line, int column) = At(gen, "percent");
            CheckPercentMask(
                attrs["percent"], SplitCount(attrs.GetValueOrDefault("value", "")),
                new[] { "TDC051", "TDC052", "TDC053" }, line, column);
        }

        if (type == "number" && attrs.ContainsKey("percent") && attrs.ContainsKey("length"))
        {
            (int line, int column) = At(gen, "percent");
            CheckPercentMask(
                attrs["percent"], SplitCount(attrs["length"]),
                new[] { "TDC084", "TDC085", "TDC086" }, line, column);
        }
    }

    /// <summary>
    /// The <c>http</c> generator: everything knowable before the run.
    /// </summary>
    /// <remarks>
    /// A missing endpoint, an address that is not a URL, an <c>in=</c> naming nothing. The transport
    /// failures — the service down, slow or wrong — cannot be known until the run and are reported
    /// then; these can, and a run that calls a service is the most expensive kind to discover a typo
    /// in.
    /// </remarks>
    private void CheckHttp(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "http")
        {
            return;
        }

        string? src = attrs.GetValueOrDefault("src");
        if (string.IsNullOrWhiteSpace(src))
        {
            (int line, int column) = At(gen, "src");
            Error(
                "TDC065", "<gen type=\"http\"> requires a \"src\" attribute",
                "Point it at the service, e.g. src=\"http://127.0.0.1:5566/gen\".", line, column);
        }
        else if (!IsHttpUrl(src.Trim()))
        {
            (int line, int column) = At(gen, "src");
            Error(
                "TDC066",
                $"invalid http src \"{src.Trim()}\" — must be an http:// or https:// URL",
                "e.g. src=\"http://127.0.0.1:5566/gen\" or src=\"https://svc.example.com/gen\".",
                line, column);
        }

        string? inAttr = attrs.GetValueOrDefault("in");
        if (inAttr is not null && !_declaredNames.Contains(inAttr.Trim()))
        {
            (int line, int column) = At(gen, "in");
            Error(
                "TDC067",
                $"in=\"{inAttr.Trim()}\" does not name a sequence declared before this one",
                "The value sent per row comes from an earlier <sequence>; declare it above.",
                line, column);
        }

        string? onError = attrs.GetValueOrDefault("on_error");
        if (onError is not null && onError is not ("fail" or "empty"))
        {
            (int line, int column) = At(gen, "on_error");
            Error(
                "TDC068", $"invalid on_error \"{onError}\" — expected \"fail\" or \"empty\"",
                "fail (default) stops the run; empty blanks the cell and continues.", line, column);
        }
    }

    private static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
        && (uri.Scheme == "http" || uri.Scheme == "https")
        && !string.IsNullOrEmpty(uri.Host);

    /// <summary>A <c>mask=</c> that does not parse. Caught here rather than on the first row.</summary>
    private void CheckMask(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (!attrs.TryGetValue("mask", out string? mask))
        {
            return;
        }

        try
        {
            Mask.Check(mask);
        }
        catch (ArgumentException e)
        {
            (int line, int column) = At(gen, "mask");
            Error(
                "TDC199", e.Message,
                "Indices are 0-based; ranges use \"..\", e.g. mask=\"x[0..3]\" or "
                + "mask=\"w[-1], w[0]\".",
                line, column);
        }
    }

    /// <summary>
    /// A <c>src=</c> that names a file nobody can read.
    /// </summary>
    /// <remarks>
    /// Checked before the run rather than during it: a missing file discovered on row one of a
    /// million-row job has already cost whatever the job cost.
    /// </remarks>
    /// <summary>
    /// <c>missing="p"</c> and <c>anomaly="p"</c>: a probability, and something to spend it on.
    /// </summary>
    /// <remarks>
    /// <para>Both were parsed only where they are used, deep in the sequence builder, so
    /// <c>check</c> called a config valid and the run then stopped on <c>anomaly="10x"</c>. A check
    /// that passes what the very next command refuses is worse than no check. The generator keeps
    /// its own parse as a backstop, for callers who build a gen through the library.</para>
    /// <para>The second half is a request that would be honoured and still do nothing. An anomaly
    /// multiplies the selected value by <c>anomaly_factor</c>, so a <c>value=</c> list with no
    /// number anywhere in it has nothing to perturb and ten rows come back ordinary with no sign
    /// that 30% of them were meant to be outliers. Only a <c>type="text"</c> list is judged: it is
    /// the only source whose whole candidate set is written in the config.</para>
    /// </remarks>
    private void CheckImperfections(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        foreach (string key in new[] { "anomaly", "missing" })
        {
            string? probability = attrs.GetValueOrDefault(key);
            if (string.IsNullOrWhiteSpace(probability) || IsProbability(probability))
            {
                continue;
            }

            (int line, int column) = At(gen, key);
            Error(
                "TDC242",
                $"{key}=\"{probability}\" is not a probability — it must be a number in [0, 1]",
                key == "anomaly"
                    ? "It is the share of values turned into outliers: anomaly=\"0.05\" spikes one "
                        + "value in twenty."
                    : "It is the share of values blanked: missing=\"0.1\" empties one value in ten.",
                line, column);
        }

        string? raw = attrs.GetValueOrDefault("anomaly");
        if (raw is null || !IsProbability(raw) || AsNumber(raw) == 0.0)
        {
            return;
        }

        if (type != "text")
        {
            return;
        }

        string? listed = attrs.GetValueOrDefault("value");
        if (string.IsNullOrWhiteSpace(listed))
        {
            return;
        }

        if (listed.Split(',').Any(piece => IsNumber(piece.Trim())))
        {
            return;
        }

        (int anomalyLine, int anomalyColumn) = At(gen, "anomaly");
        Error(
            "TDC243",
            $"anomaly=\"{raw}\" has nothing to perturb — no value in \"{listed}\" is a number",
            "An anomaly multiplies a numeric value by anomaly_factor, so a list of words comes "
            + "back unchanged. Put the anomaly on a numeric generator, or drop it.",
            anomalyLine, anomalyColumn);
    }

    /// <summary>The text as a number, or NaN — the same reading the generators apply.</summary>
    private static double AsNumber(string raw) =>
        double.TryParse(
            raw, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double value)
            ? value
            : double.NaN;

    private static bool IsNumber(string raw) => double.IsFinite(AsNumber(raw));

    /// <summary>True when the text is a probability the generators will accept.</summary>
    private static bool IsProbability(string raw)
    {
        double p = AsNumber(raw);
        return double.IsFinite(p) && p >= 0.0 && p <= 1.0;
    }

    private void CheckSource(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type is not ("file" or "pattern"))
        {
            return;
        }

        // `src=` is one of three ways to hand a drawing a shape, so its absence is only a mistake
        // when the other two are absent too — the drawing equivalent of a regex with no pattern,
        // which TDC095 and TDC128 have always caught before the run.
        if (type == "pattern"
            && !new[] { "points", "src", "upper" }.Any(
                key => !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault(key))))
        {
            Error(
                "TDC244",
                "<gen type=\"pattern\"> has nothing to draw from",
                "Give it a shape: points=\"0,0 1,5 2,3\", src=\"curve.svg\" (or a PNG), or "
                + "upper=\"…\" with an optional lower=\"…\" for a band.",
                Line(gen), Column(gen));
            return;
        }

        string? src = attrs.GetValueOrDefault("src");
        if (string.IsNullOrWhiteSpace(src))
        {
            return;
        }

        // The same resolution the generator itself performs, or the validator would refuse a config
        // the run would have handled — an @data/ source above all.
        string path;
        try
        {
            path = FileGen.Resolve(src, _baseDir, DataRoots);
        }
        catch (ArgumentException e)
        {
            (int line, int column) = At(gen, "src");
            Error(
                "TDC061", e.Message, "Paths are relative to the config file's own folder.",
                line, column);
            return;
        }

        if (!File.Exists(path))
        {
            (int line, int column) = At(gen, "src");
            Error(
                "TDC061", $"cannot read file \"{src}\"",
                "Paths are relative to the config file's own folder.", line, column);
            return;
        }

        if (!attrs.ContainsKey("column"))
        {
            return;
        }

        // A column that names nothing in the file: caught by loading it, which is the only way to
        // know, and cheap next to discovering it a million rows in.
        try
        {
            FileGen.Load(attrs, _baseDir, DataRoots);
        }
        catch (Exception e) when (e is ArgumentException or IOException)
        {
            (int line, int column) = At(gen, "column");
            Error(
                "TDC062", e.Message,
                "For CSV files, use a header name like column=\"email\" or a 1-based index like "
                + "column=\"2\".",
                line, column);
        }
    }

    /// <summary>
    /// Every attribute is spelled right AND read by this generator.
    /// </summary>
    /// <remarks>
    /// An ignored attribute is a request the config made and silently did not get, which is
    /// indistinguishable from a typo — and the data comes out looking fine either way, which is what
    /// makes it worth stopping for. All errors, matching the reference.
    /// </remarks>
    private void CheckGenAttributes(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type == "template")
        {
            CheckBuiltinTemplateAttrs(gen, attrs);
            return;
        }

        bool hasDistribution =
            !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("distribution"));

        foreach (string name in attrs.Keys)
        {
            if (!GenAttrs.Contains(name))
            {
                Ignored(gen, name, "Check the spelling against the generator's attributes.");
                continue;
            }

            // A distribution parameter with no distribution asked for shapes nothing.
            if (DistributionParams.Contains(name) && !hasDistribution)
            {
                Ignored(
                    gen, name,
                    $"\"{name}\" is a parameter of a named distribution — add distribution=\"…\" "
                    + "for it to mean anything. To bound a plain number, put the range in "
                    + "value=\"10..20\".");
                continue;
            }

            if (AttributeOwners.TryGetValue(name, out IReadOnlySet<string>? owners)
                && type is not null && !owners.Contains(type))
            {
                string belongs = string.Join(
                    ", ", owners.OrderBy(o => o, StringComparer.Ordinal).Select(o => $"type=\"{o}\""));
                Ignored(
                    gen, name,
                    $"\"{name}\" belongs to {belongs} — a type=\"{type}\" generator ignores it.");
            }
        }
    }

    /// <summary>
    /// The two pack-less template paths, against their own closed parameter sets.
    /// </summary>
    /// <remarks>
    /// A pack declares its own parameters and is judged with the registry in hand; these two are
    /// backed by no pack, so nothing else checks them.
    /// </remarks>
    private void CheckBuiltinTemplateAttrs(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        string path = attrs.GetValueOrDefault("value", "").Trim();
        if (!BuiltinTemplateParams.TryGetValue(path, out IReadOnlySet<string>? allowed))
        {
            if (CheckPackParams(gen, attrs, path))
            {
                return;
            }

            foreach (string name in attrs.Keys)
            {
                if (!GenAttrs.Contains(name))
                {
                    Ignored(gen, name, "Check the spelling against the generator's attributes.");
                }
            }

            return;
        }

        foreach (string name in attrs.Keys)
        {
            if (TemplateCommonAttrs.Contains(name) || allowed.Contains(name))
            {
                continue;
            }

            Ignored(
                gen, name,
                $"\"{path}\" reads only "
                + string.Join(", ", allowed.OrderBy(a => a, StringComparer.Ordinal)) + ".");
        }
    }

    /// <summary>
    /// Attributes on a template <c>&lt;gen&gt;</c> that the target pack CAN act on.
    /// </summary>
    /// <remarks>
    /// A pack whose body declares <c>&lt;sequence name="domain"&gt;</c> accepts
    /// <c>domain="…"</c> from the caller, and the engine replaces that sequence with the
    /// constant. So the attribute is neither a typo nor ignored — refusing it, as this used to,
    /// made a config that runs in the reference fail here.
    /// <para>
    /// Returns false — leaving the ordinary check to run — when nothing is known about the pack:
    /// an unresolvable address, or no registry at all. Guessing there would produce exactly the
    /// false errors this must not create.
    /// </para>
    /// </remarks>
    private bool CheckPackParams(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string path)
    {
        if (_packs is null || path.Length == 0)
        {
            return false;
        }

        IReadOnlySet<string>? declared = _packs.ParameterNames(path, _locale);
        if (declared is null)
        {
            return false;
        }

        foreach (KeyValuePair<string, string> attr in attrs)
        {
            if (GenAttrs.Contains(attr.Key) || declared.Contains(attr.Key))
            {
                continue;
            }

            string hint = declared.Count > 0
                ? "Parameters of this generator: "
                    + string.Join(", ", declared.OrderBy(n => n, StringComparer.Ordinal)) + "."
                : "This generator takes no parameters — it produces a fixed shape. "
                    + $"Value passed: \"{attr.Value}\".";
            (int line, int column) = At(gen, attr.Key);
            Error(
                "TDC072",
                $"\"{attr.Key}\" is not a parameter of \"{path}\" — it would be ignored",
                hint,
                line,
                column);
        }

        return true;
    }

    private void Ignored(TDCParser.SelfClosingElementContext gen, string name, string why)
    {
        (int line, int column) = At(gen, name);
        Error("TDC015", $"<gen> does not read \"{name}\" — it is ignored", why, line, column);
    }

    private void CheckRequiredValue(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        string? value = attrs.GetValueOrDefault("value");
        bool missing = string.IsNullOrWhiteSpace(value);
        switch (type)
        {
            case "text":
                if (missing)
                {
                    Error(
                        "TDC050", "<gen type=\"text\"> requires a \"value\" attribute",
                        "It is the comma-separated list to pick from.", Line(gen), Column(gen));
                }

                return;

            case "file":
            {
                if (string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("src")))
                {
                    Error(
                        "TDC060", "<gen type=\"file\"> requires a \"src\" attribute",
                        "Provide the path to a UTF-8 text file with one value per line.",
                        Line(gen), Column(gen));
                }

                string? row = attrs.GetValueOrDefault("row");
                if (!string.IsNullOrWhiteSpace(row)
                    && string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("column")))
                {
                    (int line, int column) = At(gen, "row");
                    Error(
                        "TDC064", "row-linked file generators require a CSV \"column\" attribute",
                        "Use column=\"name\" or column=\"2\" together with row=\"sharedKey\".",
                        line, column);
                }

                return;
            }

            case "template":
            {
                if (missing)
                {
                    Error(
                        "TDC070", "<gen type=\"template\"> requires a \"value\" attribute",
                        "Use a known template path, e.g. person.male.firstName.",
                        Line(gen), Column(gen));
                    return;
                }

                if (value!.Contains("${{"))
                {
                    // An address that names a field is not known until the row is, so there is
                    // nothing to look up here. The engine resolves it per row and reports what it
                    // cannot find.
                    return;
                }

                string path = value.Trim();
                if (BuiltinTemplatePaths.Contains(path) || _packs is null)
                {
                    return;
                }

                if (_packs.Exists(path, _locale))
                {
                    // The address resolves; whether the file behind it is usable is a separate
                    // question, and one worth answering now. A pack a user wrote themselves is
                    // exactly the kind that is malformed, and finding out on the first row wastes
                    // the run.
                    try
                    {
                        _packs.Load(path, _locale);
                    }
                    catch (Exception e) when (e is ArgumentException or IOException)
                    {
                        (int line, int column) = At(gen, "value");
                        Error(
                            "TDC170", e.Message, $"Data pack file for \"{path}\".", line, column);
                    }
                }
                else
                {
                    (int line, int column) = At(gen, "value");
                    // The path may be real and only missing DATA for this locale. Said as its
                    // own code because "unknown template path" reads as a typo and sends the
                    // reader hunting for one that is not there.
                    if (_locale != "en" && _packs.Exists(path, "en"))
                    {
                        Error(
                            "TDC217",
                            $"template path \"{value}\" has no data for locale \"{_locale}\"",
                            "The \"en\" pack ships it. Set local=\"…\" on this <gen> or on <env>, "
                            + "or choose a path your locale ships.", line, column);
                    }
                    else
                    {
                        Error(
                            "TDC071", $"unknown template path \"{value}\"",
                            "Check the address against the packs you have.", line, column);
                    }
                }

                return;
            }

            case "regex":
                if (missing)
                {
                    Error(
                        "TDC095", "<gen type=\"regex\"> requires a \"value\" attribute",
                        "Provide a finite regex pattern, e.g. value=\"[A-Z]{2}[0-9]{6}\".",
                        Line(gen), Column(gen));
                }

                return;

            case "advanced_regex":
                if (missing)
                {
                    Error(
                        "TDC128", "<gen type=\"advanced_regex\"> requires a \"value\" attribute",
                        "Provide a finite pattern, optionally with a weighted choice.",
                        Line(gen), Column(gen));
                }

                return;

            default:
                // Nothing else has a single required attribute.
                return;
        }
    }

    /// <summary>
    /// The number generator's own parsers decide what is valid.
    /// </summary>
    /// <remarks>
    /// A validator with its own idea of a valid range drifts from the generator that reads it, and
    /// then a config passes the check and fails at run time — the worst of both.
    /// </remarks>
    private void CheckNumber(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "number")
        {
            return;
        }

        string? distribution = attrs.GetValueOrDefault("distribution");
        if (!string.IsNullOrWhiteSpace(distribution))
        {
            foreach (string key in Checks.DistributionConflicts)
            {
                if (attrs.ContainsKey(key))
                {
                    (int line, int column) = At(gen, key);
                    Error(
                        "TDC088",
                        $"<gen type=\"number\" distribution=\"...\"> cannot be combined with "
                        + $"\"{key}\"",
                        $"A distribution replaces the range/percent. Remove \"{key}\", or drop "
                        + "\"distribution\" to use a range.",
                        line, column);
                }
            }

            // The distribution's own parameters: a shape nobody can draw from is an error before the
            // run, not a surprise on the first row.
            try
            {
                Stats.Distribution.Parse(attrs);
            }
            catch (ArgumentException e)
            {
                (int line, int column) = At(gen, "distribution");
                Error(
                    "TDC089", e.Message,
                    "Distributions: normal (mean, sd), lognormal (meanlog, sdlog), exponential "
                    + "(rate), pareto (alpha, xmin). Optional: decimals, min, max.",
                    line, column);
            }

            return;
        }

        string? value = attrs.GetValueOrDefault("value");
        if (!string.IsNullOrWhiteSpace(value) && Checks.NumberRangeProblem(value) is not null)
        {
            (int line, int column) = At(gen, "value");
            Error(
                "TDC081", $"invalid number range \"{value}\"",
                "Expected \"bit\", \"MIN..MAX\", or a list like \"[0..9],[20..29]\".", line, column);
        }

        string? firstZero = attrs.GetValueOrDefault("first_zero");
        if (firstZero is not null && !Checks.IsBooleanText(firstZero))
        {
            (int line, int column) = At(gen, "first_zero");
            Error(
                "TDC082", $"invalid first_zero \"{firstZero}\" — expected \"true\" or \"false\"",
                "It decides whether a generated digit string may start with a zero.", line, column);
        }

        string? length = attrs.GetValueOrDefault("length");
        if (length is not null && !Checks.IsValidLength(length))
        {
            (int line, int column) = At(gen, "length");
            Error(
                "TDC083",
                $"invalid length \"{length}\" — expected a positive integer, range, or "
                + "comma-separated list",
                "Examples: length=\"10\", length=\"2-10\", length=\"2,10-12\".", line, column);
        }

        bool hasModifier =
            !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("include"))
            || !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("exclude"));
        if (hasModifier && string.IsNullOrWhiteSpace(value))
        {
            Error(
                "TDC087",
                "<gen type=\"number\"> include/exclude require a numeric range in \"value\"",
                "Add a range first, e.g. value=\"0..9\" exclude=\"3\".", Line(gen), Column(gen));
        }
    }

    private void CheckRegexes(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        string? value = attrs.GetValueOrDefault("value");
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        int limit = attrs.TryGetValue("regex_max_length", out string? own)
            ? SafeMaxLength(own)
            : _documentRegexMaxLength;

        if (type == "regex")
        {
            string? problem = Checks.RegexProblem(value, limit);
            if (problem is not null)
            {
                (int line, int column) = At(gen, "value");
                Error(
                    "TDC097", $"invalid regex generator pattern: {problem}",
                    "The subset is finite: no * or +, and every pattern has a longest output.",
                    line, column);
            }
        }
        else if (type == "advanced_regex")
        {
            string? problem = Checks.AdvancedRegexProblem(value, limit);
            if (problem is not null)
            {
                (int line, int column) = At(gen, "value");
                Error(
                    "TDC130", $"invalid advanced_regex generator pattern: {problem}",
                    "Weighted branches must sum to 100.", line, column);
            }
        }
    }

    private void CheckSymbol(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "symbol")
        {
            return;
        }

        string? value = attrs.GetValueOrDefault("value");
        string? alphabet = attrs.GetValueOrDefault("alphabet");
        bool hasValue = !string.IsNullOrEmpty(value);
        bool hasAlphabet = !string.IsNullOrEmpty(alphabet);

        const string hint =
            "Use value=\"[a-z]\" for an inline set, or alphabet=\"cyrillic.ru.letters\" for a "
            + "named one.";

        if (hasValue && hasAlphabet)
        {
            (int line, int column) = At(gen, "value");
            Error(
                "TDC098", "<gen type=\"symbol\"> accepts either \"value\" or \"alphabet\", not both",
                hint, line, column);
            return;
        }

        if (!hasValue && !hasAlphabet)
        {
            // Neither an inline set nor a named one: there is nothing to draw a character from, and
            // the generator would produce empty strings for the whole run.
            Error(
                "TDC098",
                "<gen type=\"symbol\"> requires a \"value\" (inline set) or \"alphabet\" (named)",
                hint, Line(gen), Column(gen));
            return;
        }

        if (hasAlphabet && !Checks.IsKnownAlphabet(alphabet!))
        {
            (int line, int column) = At(gen, "alphabet");
            Error(
                "TDC099", $"unknown alphabet \"{alphabet}\"",
                "Known alphabets: " + string.Join(", ", Checks.AlphabetNames()) + ".", line, column);
        }
    }

    /// <summary><c>step=</c> on a walked date axis: what it may say, and that anything reads it.</summary>
    private void CheckDateStep(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (!attrs.TryGetValue("step", out string? rawStep))
        {
            return;
        }

        string raw = rawStep.Trim();
        (int line, int column) = At(gen, "step");
        DateStep.Result parsed = DateStep.ParseStep(raw);

        if (!parsed.Ok)
        {
            // The two failures read differently because they ARE different: one is a spelling
            // nobody meant, the other a step whose meaning would depend on which half was applied
            // first.
            bool mixed = parsed.Why == DateStep.Reason.Mixed;
            Error(
                "TDC247",
                mixed
                    ? $"step=\"{raw}\" mixes a calendar unit with a fixed one"
                    : $"step=\"{raw}\" is not a step this engine can walk",
                mixed
                    ? "A month is 28 to 31 days, so \"one month and fifteen days\" depends on "
                      + "which is applied first. Write one or the other: 45d, or 1mo."
                    : $"Write {DateStep.StepSyntax}. A bare number means days, so step=\"2\" is "
                      + "every other day.",
                line, column);
            return;
        }

        if ((attrs.GetValueOrDefault("order") ?? "").Trim() != "sequential")
        {
            Error(
                "TDC248",
                $"step=\"{raw}\" has no order=\"sequential\" on the same <gen> — nothing walks "
                + "the range",
                "Add order=\"sequential\" to walk the range one step at a time, or remove step= "
                + "and let the dates be drawn at random.",
                line, column);
        }
    }

    /// <summary><c>weekdays="mon..fri"</c> — which weekdays a walked axis keeps.</summary>
    /// <remarks>
    /// A FILTER, not a step: the spacing stops being even, since Friday to Monday is a three-day
    /// jump. That is why it is a separate attribute — one word for both operations would stop them
    /// being combinable, and "every 15 minutes, but only on working days" is exactly what gets
    /// asked for.
    /// </remarks>
    private void CheckDateWeekdays(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (!attrs.TryGetValue("weekdays", out string? rawDays))
        {
            return;
        }

        string raw = rawDays.Trim();
        (int line, int column) = At(gen, "weekdays");

        if (DateStep.ParseWeekdays(raw) is null)
        {
            Error(
                "TDC249",
                $"unknown weekday in weekdays=\"{raw}\"",
                $"Names are {string.Join(", ", DateStep.WeekdayNames)} — a span like \"mon..fri\" "
                + "or a list like \"sun,wed\".",
                line, column);
            return;
        }

        if ((attrs.GetValueOrDefault("order") ?? "").Trim() != "sequential")
        {
            Error(
                "TDC248",
                $"weekdays=\"{raw}\" has no order=\"sequential\" on the same <gen> — nothing "
                + "walks the range",
                "Add order=\"sequential\" to walk the range and keep only these days, or remove "
                + "weekdays= and let the dates be drawn at random.",
                line, column);
            return;
        }

        DateStep.Result step = DateStep.ParseStep(attrs.GetValueOrDefault("step"));
        if (step.Step is DateStep.Spec spec && DateStep.FixesWeekday(spec))
        {
            // A calendar step, or any whole number of weeks, lands on the same weekday every time
            // — so the filter would match every row or none of them, giving a full column or an
            // empty one with nothing said either way. Measured on the STEP rather than on its
            // spelling, so `14d` is caught as surely as `2w`.
            string written = (attrs.GetValueOrDefault("step") ?? "").Trim();
            Error(
                "TDC250",
                $"weekdays=\"{raw}\" cannot narrow step=\"{written}\" — that step already fixes "
                + "the weekday",
                "A whole number of weeks, or any calendar step, lands on the same weekday every "
                + "time, so this would match every row or none. Use a step that is not a multiple "
                + "of a week, or drop weekdays=.",
                line, column);
        }
    }

    private void CheckDate(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "date")
        {
            return;
        }

        // `from=` alone is an OPEN axis when the range is WALKED: the end of such an axis is
        // start + count × step, a consequence rather than an input. On a DRAWN date one end
        // genuinely means nothing, and that is what this refuses.
        bool walked = (attrs.GetValueOrDefault("order") ?? "").Trim() == "sequential";
        bool openAxis = walked && attrs.ContainsKey("from") && !attrs.ContainsKey("to");
        if (!openAxis && attrs.ContainsKey("from") != attrs.ContainsKey("to"))
        {
            Error(
                "TDC150",
                "<gen type=\"date\"> requires both \"from\" and \"to\" when either is used",
                "Use from=\"2020-01-01\" to=\"2025-12-31\", or value=\"2020-01-01..2025-12-31\".",
                Line(gen), Column(gen));
        }

        CheckDateStep(gen, attrs);
        CheckDateWeekdays(gen, attrs);

        string? local = attrs.GetValueOrDefault("local");
        if (!string.IsNullOrWhiteSpace(local) && !Checks.IsKnownDateLocale(local))
        {
            (int line, int column) = At(gen, "local");
            Error(
                "TDC153", $"unknown date locale \"{local}\"",
                "A date locale has to be translated deliberately — month names inflect.",
                line, column);
        }

        CheckDateCommonAttrs(gen, attrs);
        CheckDateValues(gen, attrs);
    }

    /// <summary>
    /// The dates themselves parse.
    /// </summary>
    /// <remarks>
    /// Without this a <c>from="notadate"</c> reached the generator and failed there, which is a
    /// crash at render time instead of a diagnostic at validation time — and the reference reports
    /// it here.
    /// </remarks>
    private void CheckDateValues(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        try
        {
            if (attrs.TryGetValue("from", out string? from) && attrs.TryGetValue("to", out string? to))
            {
                DateParse.DateTime(from);
                DateParse.DateTime(to);
            }

            if (attrs.TryGetValue("range", out string? range))
            {
                DateParse.ParseRange(range);
            }

            string value = attrs.GetValueOrDefault("value", "").Trim();
            if (value.Length > 0)
            {
                CheckDateValue(value);
            }

            if (value == "birth")
            {
                DateGen.CheckBirthAges(attrs);
            }
        }
        catch (ArgumentException e)
        {
            // Whichever attribute the reader would look at first — the complaint is about the span,
            // and pointing at one of its two ends names only half of it.
            (int line, int column) = At(gen, PrimaryDateAttr(attrs));
            Error(
                "TDC151", e.Message,
                "Examples: value=\"2020-01-01..2025-12-31\", value=\"birth\", value=\"today\", "
                + "or value=\"now\".",
                line, column);
        }
    }

    /// <summary>A <c>value=</c> that is a date, a range, or one of the words the generator knows.</summary>
    private static void CheckDateValue(string value)
    {
        if (value is "birth" or "today" or "now")
        {
            return;
        }

        if (value.Contains(".."))
        {
            DateParse.ParseRange(value);
            return;
        }

        DateParse.DateTime(value);
    }

    /// <summary>
    /// The attributes every date-shaped generator shares: how it is formatted, and how precise it is.
    /// </summary>
    /// <remarks>
    /// Also reached from the pack templates <c>date.range</c> and <c>person.b_day</c>, which are
    /// dates wearing a different address and would otherwise skip these checks entirely.
    /// </remarks>
    private void CheckDateCommonAttrs(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (attrs.TryGetValue("format", out string? format))
        {
            try
            {
                DateFormatter.CheckFormat(format);
            }
            catch (ArgumentException e)
            {
                (int line, int column) = At(gen, "format");
                Error(
                    "TDC152", e.Message,
                    "Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket "
                    + "literals [text].",
                    line, column);
            }
        }

        if (attrs.TryGetValue("precision", out string? precision))
        {
            try
            {
                DateGen.ParsePrecision(precision, DateGen.Precision.Day);
            }
            catch (ArgumentException e)
            {
                (int line, int column) = At(gen, "precision");
                Error("TDC154", e.Message, "Supported: day, second, millisecond.", line, column);
            }
        }
    }

    /// <summary><c>oldest</c>/<c>youngest</c> on a birth date: whole ages, and in that order.</summary>
    private void CheckBirthAges(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        try
        {
            DateGen.CheckBirthAges(attrs);
        }
        catch (ArgumentException e)
        {
            (int line, int column) = At(gen, PrimaryDateAttr(attrs));
            Error("TDC151", e.Message, "", line, column);
        }
    }

    /// <summary>The attribute a date complaint points at, in the order the reference tries them.</summary>
    private static string PrimaryDateAttr(IReadOnlyDictionary<string, string> attrs)
    {
        foreach (string name in new[] { "value", "range", "from", "to", "oldest", "youngest" })
        {
            if (attrs.ContainsKey(name))
            {
                return name;
            }
        }

        return "value";
    }

    /// <summary>
    /// <c>date.range</c> and <c>person.b_day</c>: pack addresses that are date generators.
    /// </summary>
    /// <remarks>
    /// They take the same attributes and can be wrong in the same ways, so they are checked the same
    /// way rather than passing through as ordinary template lookups.
    /// </remarks>
    private void CheckDateTemplates(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "template")
        {
            return;
        }

        string path = attrs.GetValueOrDefault("value", "").Trim();
        if (path == "date.range")
        {
            if (!attrs.TryGetValue("range", out string? range))
            {
                Error(
                    "TDC072", "<gen value=\"date.range\"> requires a \"range\" attribute",
                    "Syntax: range=\"YYYY.MM.DD - YYYY.MM.DD\".", Line(gen), Column(gen));
                return;
            }

            try
            {
                DateParse.LegacyRange(range);
                CheckDateCommonAttrs(gen, attrs);
            }
            catch (ArgumentException e)
            {
                (int line, int column) = At(gen, "range");
                Error(
                    "TDC073", e.Message,
                    "Expected two valid dates in \"YYYY.MM.DD - YYYY.MM.DD\" form.", line, column);
            }

            return;
        }

        if (path == "person.b_day")
        {
            CheckDateCommonAttrs(gen, attrs);
            CheckBirthAges(gen, attrs);
        }
    }

    /// <summary><c>value=</c> and <c>step=</c> on a counter have to be numbers.</summary>
    private void CheckCounter(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type is not ("increment" or "decrement"))
        {
            return;
        }

        foreach (string name in new[] { "value", "step" })
        {
            if (!attrs.TryGetValue(name, out string? raw))
            {
                continue;
            }

            if (!double.TryParse(
                    raw.Trim(), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out double v)
                || !double.IsFinite(v))
            {
                (int line, int column) = At(gen, name);
                Error(
                    "TDC090", $"invalid {name} \"{raw}\" — expected a number", "", line, column);
            }
        }
    }

    /// <summary><c>accumulate=</c> needs a list, and its op is one of a short closed set.</summary>
    /// <summary>
    /// Everything a running total cannot do without.
    ///
    /// Two things have to hold before the engine sees it, and neither is discoverable from
    /// the row it stands on: it has to say WHAT to accumulate and HOW, and the column it
    /// reads has to be declared ABOVE it — the same rule <c>parent=</c> follows.
    /// </summary>
    private void CheckRunning(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "running")
        {
            return;
        }

        if ((attrs.GetValueOrDefault("of") ?? "").Trim().Length == 0)
        {
            Error(
                "TDC239", "<gen type=\"running\"> does not say what to accumulate",
                "Name the column it adds up: of=\"Delta\". A running total reads another "
                + "sequence — it draws nothing of its own.",
                Line(gen), Column(gen));
        }

        if ((attrs.GetValueOrDefault("accumulate") ?? "").Trim().Length == 0)
        {
            Error(
                "TDC239", "<gen type=\"running\"> does not say how to accumulate",
                "Add accumulate=\"…\" — one of: " + string.Join(", ", Accumulate.Ops) + ".",
                Line(gen), Column(gen));
        }

        // `of=` and `reset=` both read a column, so both take the rule. Reported separately:
        // naming the wrong one would send the reader to the wrong attribute.
        foreach (string name in new[] { "of", "reset" })
        {
            string value = (attrs.GetValueOrDefault(name) ?? "").Trim();
            if (value.Length == 0 || _declaredOrder.Contains(value, StringComparer.Ordinal))
            {
                continue;
            }

            (int line, int column) = At(gen, name);
            Error(
                "TDC240", $"{name}=\"{value}\" is not a sequence declared above this one",
                _declaredOrder.Count == 0
                    ? "A running total is built from a column that already exists, so the "
                      + "column it reads has to come first."
                    : "Declared above: " + string.Join(", ", _declaredOrder) + ".",
                line, column);
        }
    }

    private void CheckAccumulate(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        bool repeats)
    {
        if (!attrs.ContainsKey("accumulate"))
        {
            return;
        }

        (int line, int column) = At(gen, "accumulate");
        try
        {
            Accumulate.Parse(attrs);
        }
        catch (AccumulateException e)
        {
            Error(
                "TDC238", e.Message,
                "accumulate= keeps a running total across a repeat list. One of: "
                + string.Join(", ", Accumulate.Ops) + ".",
                line, column);
        }

        // `type="running"` accumulates down a COLUMN, so it carries the same word with no
        // list in sight. Only the list flavour needs `repeat`.
        if (!repeats && attrs.GetValueOrDefault("type") != "running")
        {
            Error(
                "TDC237", "\"accumulate\" has no effect without \"repeat\"",
                "accumulate= turns the values of a repeat list into a running total, so there "
                + "has to be a list. Add repeat=\"N\", or drop accumulate=.",
                line, column);
        }
    }

    private void CheckRepeat(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        bool repeats;
        try
        {
            repeats = Checks.HasRepeat(attrs);
        }
        catch (ArgumentException e)
        {
            (int line, int column) = At(gen, "repeat");
            Error(
                "TDC195", e.Message,
                "Use repeat=\"3\" for a fixed count or repeat=\"1..5\" for a range (0 to 64).",
                line, column);
            CheckAccumulate(gen, attrs, true);
            return;
        }

        CheckAccumulate(gen, attrs, repeats);

        if (repeats)
        {
            string? reason = Checks.RepeatUnsupportedReason(type);
            if (reason is not null)
            {
                (int line, int column) = At(gen, "repeat");
                Error(
                    "TDC204", $"\"repeat\" is not supported on <gen type=\"{type}\"> — {reason}",
                    "Its value comes from the row index, which a variable-length list makes "
                    + "unknowable.",
                    line, column);
            }
        }
        else if (attrs.ContainsKey("separator"))
        {
            // A separator with nothing to separate is a request that silently does nothing.
            (int line, int column) = At(gen, "separator");
            Error(
                "TDC198", "\"separator\" has no effect without \"repeat\"",
                "separator joins the values a repeating gen produces. Add repeat=\"N\", or drop it.",
                line, column);
        }
    }

    /// <summary>Every attribute on a closed tag, checked against what that tag actually reads.</summary>
    private void CheckClosedTagAttrs(
        string tag, TDCParser.AttrContext[] attrs, int line, int column)
    {
        if (!ClosedTagAttributes.TryGetValue(tag, out IReadOnlySet<string>? known))
        {
            return;
        }

        foreach (KeyValuePair<string, string> attr in Attributes(attrs))
        {
            if (!known.Contains(attr.Key))
            {
                (int l, int c) = At(attrs, attr.Key, line, column);
                Error(
                    "TDC015", $"<{tag}> does not read \"{attr.Key}\" — it is ignored",
                    $"Attributes of <{tag}>: "
                    + string.Join(", ", known.OrderBy(k => k, StringComparer.Ordinal)) + ".",
                    l, c);
            }
        }
    }

    /// <summary>
    /// What may sit inside a <c>&lt;case&gt;</c>: literal text, one generator, or a nested mix.
    /// </summary>
    /// <remarks>
    /// A nested mix is checked as a nested one — it contributes a value to the column around it and
    /// has nowhere of its own to put a flag.
    /// </remarks>
    /// <summary>
    /// A <c>&lt;gen&gt;</c> written inside a <c>&lt;case&gt;</c>.
    /// </summary>
    /// <remarks>
    /// <c>anomaly_flag="NAME"</c> mints a ground-truth column beside a sequence's value. A case
    /// body is a CONCATENATION of parts, so a flag written on one part describes that part rather
    /// than the row, and there is no honest column to mint. <c>&lt;mix flag="NAME"&gt;</c> asks
    /// the same question where it has an answer. Until this check the attribute was accepted here
    /// and did nothing, and the only sign was <c>${{NAME}}</c> reaching the data as literal
    /// characters.
    /// </remarks>
    private void CheckCaseGenFlag(string? flag, (int Line, int Column) at)
    {
        if (flag is null)
        {
            return;
        }

        Error(
            "TDC246", $"anomaly_flag=\"{flag.Trim()}\" is not read on a <gen> inside a <case>",
            "A case body is several parts joined, so a flag on one part does not describe the "
            + "row. Put flag=\"NAME\" on the <mix> instead, or move the <gen> into a <sequence> "
            + "of its own.",
            at.Line, at.Column);
    }

    private void CheckCaseBody(TDCParser.OpenCloseElementContext caseEl)
    {
        foreach (TDCParser.ElementContext child in caseEl.content().element())
        {
            if (child.dataElement() is not null)
            {
                continue;
            }

            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                CheckCaseGenFlag(
                    Attributes(self.attr()).GetValueOrDefault("anomaly_flag"),
                    At(self, "anomaly_flag"));
                continue;
            }

            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is null)
            {
                continue;
            }

            if (open.name.Text == "mix")
            {
                CheckMix(open, false);
                continue;
            }

            if (open.name.Text == "switch")
            {
                // A `<switch>` inside a `<case>` looks its subject up over the rows of that
                // branch. Held to every rule the env-level form is, except that it has no name.
                CheckSwitchForm(open, _declaredOrder, false);
                continue;
            }

            if (open.name.Text == "gen")
            {
                CheckCaseGenFlag(
                    Attributes(open.attr()).GetValueOrDefault("anomaly_flag"),
                    At(open, "anomaly_flag"));
                continue;
            }

            Error(
                "TDC125", $"unknown child of <case>: \"<{open.name.Text}>\"",
                "Allowed children: data, gen, mix, switch.", Line(open), Column(open));
        }
    }

    /// <summary>
    /// A percent mask, checked against how many things it is dividing.
    /// </summary>
    /// <remarks>
    /// Three different mistakes get three different codes, because they call for three different
    /// fixes: the wrong number of entries, an entry that is not a share, and shares that do not add
    /// up.
    /// </remarks>
    /// <param name="codes">
    /// The codes for length, number and sum, in that order — <c>&lt;gen&gt;</c>,
    /// <c>&lt;mix&gt;</c> and <c>&lt;switch&gt;</c> each have their own trio.
    /// </param>
    private void CheckPercentMask(
        string? mask, int valueCount, string[] codes, int line, int column)
    {
        if (mask is null)
        {
            return;
        }

        try
        {
            PercentMask.Expand(mask, valueCount);
        }
        catch (MaskException e)
        {
            string code = e.Kind switch
            {
                MaskKind.Length => codes[0],
                MaskKind.Number => codes[1],
                _ => codes[2],
            };
            string hint = e.Kind == MaskKind.Length
                ? "Percent masks may be shorter than value only when missing positions can be "
                + "inferred. They may never be longer than value."
                : "Filled positions must be non-negative numbers. Empty positions split the "
                + "remaining percent equally.";
            Error(code, e.Message, hint, line, column);
        }
        catch (ArgumentException e)
        {
            Error(codes[2], e.Message, "", line, column);
        }
    }

    /// <summary><c>case=</c> and <c>order=</c> take one of a short list, and nothing else.</summary>
    private void CheckCaseAndOrder(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (attrs.TryGetValue("case", out string? transform)
            && !Transforms.IsCaseTransform(transform))
        {
            (int line, int column) = At(gen, "case");
            Error(
                "TDC190", $"unknown case \"{transform}\"",
                "Supported: " + string.Join(", ", Transforms.CaseTransforms) + ".", line, column);
        }

        if (attrs.TryGetValue("order", out string? order)
            && order is not ("random" or "sequential"))
        {
            (int line, int column) = At(gen, "order");
            Error(
                "TDC191", $"unknown order \"{order}\"",
                "Supported: random (the default), sequential.", line, column);
        }
    }

    /// <summary>
    /// A <c>&lt;map&gt;</c> body: one <c>KEY:VALUE</c> per row.
    /// </summary>
    /// <remarks>
    /// Entries are separated by commas, and a row with no colon is not a mapping — it would
    /// otherwise become a key with no value, silently absent from the table the switch reads. A
    /// warning rather than an error: the rest of the table still works, and the run is worth
    /// finishing.
    /// </remarks>
    private void CheckMapRows(TDCParser.MapElementContext element)
    {
        if (element is not TDCParser.MapWithBodyContext body)
        {
            return;
        }

        int line = body.Start.Line;
        int column = body.Start.Column;
        foreach (string row in body.mapContent().GetText().Split(','))
        {
            string trimmed = row.Trim();
            if (trimmed.Length == 0 || trimmed.Contains(':'))
            {
                continue;
            }

            Warn(
                "TDC136", $"malformed <map> row \"{trimmed}\" — expected KEY:VALUE",
                "Each entry is KEY:VALUE, entries separated by commas, multi-key via \"|\" "
                + "(US|CA:USD).",
                line, column);
        }
    }

    /// <summary>
    /// <c>type=</c> on a <c>&lt;data&gt;</c>: parsable, and on a piece that is actually a column.
    /// </summary>
    /// <remarks>
    /// A type on an unnamed <c>&lt;data&gt;</c> is a request that does nothing — only a named one
    /// becomes a column, so the declaration would be quietly dropped.
    /// </remarks>
    private void CheckDataType(TDCParser.DataWithBodyContext body, int line, int column)
    {
        IReadOnlyDictionary<string, string> attrs = Attributes(body.attr());
        if (!attrs.TryGetValue("type", out string? rawType))
        {
            return;
        }

        (int l, int c) = At(body.attr(), "type", line, column);
        string? name = attrs.GetValueOrDefault("name");
        if (string.IsNullOrWhiteSpace(name))
        {
            Error(
                "TDC194",
                $"type=\"{rawType}\" has no name — only a named <data> becomes a column",
                "Add name=\"…\" to export this as a typed column, or drop type=.", l, c);
            return;
        }

        try
        {
            ColumnType.ParseOutput(rawType);
        }
        catch (ArgumentException e)
        {
            Error(
                "TDC194", e.Message,
                "Types: bool, int32, int64, uint8/16/32/64, float, float16, double, string, enum, "
                + "date, timestamp, decimal(p,s), uuid, json; []T for a list; |null to allow NULL.",
                l, c);
        }
    }

    /// <summary>How many entries a comma-separated attribute holds.</summary>
    private static int SplitCount(string value) => value.Split(',').Length;

    private int SafeMaxLength(string raw)
    {
        try
        {
            return RegexGen.ParseMaxLength(raw);
        }
        catch (ArgumentException)
        {
            return _documentRegexMaxLength;
        }
    }

    private void CheckWeight(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("weight")))
        {
            return;
        }

        if (type != "file")
        {
            (int line, int column) = At(gen, "weight");
            Error(
                "TDC211",
                $"\"weight\" applies to <gen type=\"file\">, not type=\"{type ?? ""}\"",
                "For inline values, percent= states the shares.", line, column);
            return;
        }

        if (string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("column")))
        {
            (int line, int column) = At(gen, "weight");
            Error(
                "TDC212", "\"weight\" needs \"column\" — the weights live in a second CSV column",
                "Name the value column too.", line, column);
        }

        if (attrs.ContainsKey("order"))
        {
            (int line, int column) = At(gen, "weight");
            Error(
                "TDC213",
                "\"weight\" cannot be combined with \"order\" — that walks rows by position, not "
                + "by share",
                "Drop one of them.", line, column);
        }
    }

    // ── block ────────────────────────────────────────────────────────────────────────────────

    private void CheckBlock(TDCParser.OpenCloseElementContext block)
    {
        // These two were missed when the other containers were closed: an invented tag in
        // either passed in silence while the same tag one level up did not.
        CheckChildren(block.content(), "block", BlockChildren, "TDC013", BlockChildren);
        foreach (TDCParser.ElementContext child in block.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "line")
            {
                CheckChildren(open.content(), "line", LineChildren, "TDC013", LineChildren);
                CheckLine(open);
            }
        }
    }

    /// <summary>
    /// A <c>&lt;line&gt;</c> holds text, and only text.
    /// </summary>
    /// <remarks>
    /// The block describes the shape of the output, not where values come from. A generator placed
    /// here would produce a value nothing else could reference, and a construct like a switch would
    /// be building a column in the middle of a layout.
    /// </remarks>
    private void CheckLine(TDCParser.OpenCloseElementContext line)
    {
        CheckClosedTagAttrs("line", line.attr(), Line(line), Column(line));

        // `if=` sits on the <line> as well as on each <data> inside it, and an unparsable one has to
        // be caught in both places or a whole line silently never renders.
        IReadOnlyDictionary<string, string> lineAttrs = Attributes(line.attr());

        // `_item` and `_item_id` exist only while a line walks a list, and both the line's own
        // condition and every <data> inside it may name them.
        bool walksAList = lineAttrs.ContainsKey("each");
        if (lineAttrs.TryGetValue("if", out string? lineCondition))
        {
            (int l, int c) = At(line.attr(), "if", Line(line), Column(line));
            CheckIfExpression(lineCondition, l, c);
            _pendingExpressions.Add((_diagnostics.Count, lineCondition, l, c, walksAList));
        }

        if (lineAttrs.TryGetValue("each", out string? each))
        {
            if (string.IsNullOrWhiteSpace(each))
            {
                (int l, int c) = At(line, "each");
                Error(
                    "TDC206", "each=\"\" names no sequence",
                    "Give it the name of a repeating sequence, or drop the attribute.", l, c);
            }
            else if (_declaredNames.Contains(each) && !_repeatingNames.Contains(each))
            {
                // Walking a scalar would emit one line and look like it worked, which is the kind of
                // near-miss that survives review.
                (int l, int c) = At(line, "each");
                Error(
                    "TDC207", $"each=\"{each}\" — that sequence holds one value, not a list",
                    "Add repeat= to its <gen>, e.g. repeat=\"1..5\", or drop each=.", l, c);
            }

            // A typed column is collected once per record, and an each= line emits several. The two
            // cannot both be true, so the column would silently take whichever element came last.
            foreach (TDCParser.ElementContext child in line.content().element())
            {
                if (child.dataElement() is not TDCParser.DataWithBodyContext body)
                {
                    continue;
                }

                string? columnName = Attributes(body.attr()).GetValueOrDefault("name");
                if (!string.IsNullOrWhiteSpace(columnName))
                {
                    (int l, int c) = At(line, "each");
                    Error(
                        "TDC209",
                        $"a named <data name=\"{columnName}\"> cannot sit inside an each= line",
                        "Typed columns are collected once per card. For columnar output keep the "
                        + "list as a list column (type=\"[]…\"); each= is for text and SQL.",
                        l, c);
                }
            }
        }

        foreach (TDCParser.ElementContext child in line.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is not null && self.name.Text == "gen")
            {
                Error(
                    "TDC131",
                    "a <gen> is not allowed inside <line> — the output block is for formatting only",
                    "Declare it as a <sequence> in <env> and reference it with ${{Name}}.",
                    Line(self), Column(self));
                continue;
            }

            if (child.dataElement() is TDCParser.DataWithBodyContext body)
            {
                CheckClosedTagAttrs("data", body.attr(), Line(line), Column(line));
                CheckDataType(body, Line(line), Column(line));
                // The <data> element, not the <line> around it: several <data> pieces can share a
                // line, and pointing at the line would name the wrong one whenever they do.
                CheckInterpolation(
                    PairedData.Restore(body.dataContent().GetText()),
                    body.Start.Line,
                    body.Start.Column);
                if (Attributes(body.attr()).TryGetValue("if", out string? condition))
                {
                    (int l, int c) = At(body.attr(), "if", Line(line), Column(line));
                    CheckIfExpression(condition, l, c);
                    _pendingExpressions.Add((_diagnostics.Count, condition, l, c, walksAList));
                }

                continue;
            }

            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text != "data")
            {
                Error(
                    "TDC132",
                    $"a <{open.name.Text}> is not allowed inside <line> — the output block is for "
                    + "formatting only",
                    "Move it into <env>.", Line(open), Column(open));
            }
        }
    }

    /// <summary>
    /// Every <c>${{…}}</c> in a line: the name has to exist, and each filter has to be one.
    /// </summary>
    /// <remarks>
    /// A name nobody declared is printed literally, so a typo reaches the output looking like data.
    /// An unknown filter is simply ignored, so the value comes out unformatted and correct enough to
    /// pass a glance.
    /// </remarks>
    private void CheckInterpolation(string text, int line, int column)
    {
        foreach (Match m in Interpolation.Matches(text))
        {
            string[] parts = m.Groups[1].Value.Split('|');
            string name = parts[0].Trim();
            if (_poolReferences.Contains(name))
            {
                // A reference draws a whole MEMBER, so it has no single value to print. Without
                // this it reached the output as literal text: a name that exists, resolves to
                // nothing, and says nothing.
                List<string> fields = _declaredNames
                    .Where(n => n.StartsWith(name + ".", StringComparison.Ordinal))
                    .Select(n => n.Substring(name.Length + 1))
                    .OrderBy(f => f, StringComparer.Ordinal)
                    .ToList();
                Error(
                    "TDC229",
                    $"\"{name}\" draws a whole member from a pool — it has no value of its own to print",
                    fields.Count == 0
                        ? $"Read one of its fields: ${{{{{name}.field}}}}."
                        : "Read a field: "
                            + string.Join(", ", fields.Select(f => $"${{{{{name}.{f}}}}}")) + ".",
                    line, column);
                continue;
            }

            if (name.Length > 0 && !_declaredNames.Contains(name) && !Checks.IsBuiltin(name))
            {
                Error(
                    "TDC193",
                    $"\"{name}\" is not a declared sequence — it would be printed literally",
                    "Declare it in <env>, or change the inject= pattern if the text is meant to be "
                    + "literal.",
                    line, column);
            }

            for (int i = 1; i < parts.Length; i++)
            {
                string filter = parts[i];
                int colon = filter.IndexOf(':');
                string kind = (colon < 0 ? filter : filter[..colon]).Trim();
                if (kind.Length > 0 && !Checks.IsKnownFilter(kind))
                {
                    Error(
                        "TDC192", $"unknown interpolation filter \"{kind}\"",
                        "Supported: " + string.Join(", ", Transforms.FilterNames) + ".",
                        line, column);
                }
            }
        }
    }

    /// <summary>The names an <c>if=</c> expression uses, checked against what exists.</summary>
    /// <remarks>
    /// <para>
    /// An identifier that names no sequence is not an error by itself — it is how a bare word
    /// works: <c>if="Gender == Male"</c> compares against the literal <c>Male</c>, and the
    /// documentation is written that way throughout. What decides is WHERE the identifier sits:
    /// the whole condition and the left of a comparison are names; anything arithmetic is a name;
    /// the right of a comparison is left alone, because <c>A == B</c> is a value comparison when B
    /// is declared and a bare word when it is not, and both are meant.
    /// </para>
    /// <para>
    /// A dot is read the same two ways the engine reads it: <c>Person.FirstName</c> is a field of
    /// a compound, <c>Gender.Male</c> asks whether Gender came out <c>Male</c>. So the root must
    /// always exist, and the tail is checked only where the root is a compound.
    /// </para>
    /// </remarks>
    private void CheckExpressionNames(string expression, int line, int column, bool each)
    {
        Expr.Expr parsed;
        try
        {
            parsed = Expr.Expr.Parse(expression);
        }
        catch (ArgumentException)
        {
            return; // Already reported as TDC100; there is no tree to walk.
        }

        WalkExpressionNames(parsed, line, column, each, asName: true);
    }

    private void WalkExpressionNames(
        Expr.Expr node, int line, int column, bool each, bool asName)
    {
        switch (node)
        {
            case Expr.Expr.Name name:
                if (asName)
                {
                    CheckExpressionName(name.Value, line, column, each);
                }

                return;
            case Expr.Expr.Member member:
                if (asName)
                {
                    CheckExpressionName(member.Dotted, line, column, each);
                }

                return;
            case Expr.Expr.Unary unary:
                WalkExpressionNames(unary.Operand, line, column, each, asName);
                return;
            case Expr.Expr.Binary binary:
            {
                // Each side of && or || is a condition in its own right; arithmetic on a bare word
                // is meaningless, so both sides are names there; on a comparison the right side may
                // be the word to match.
                bool logical = binary.Op is "&&" or "||";
                bool comparison = ComparisonOperators.Contains(binary.Op);
                WalkExpressionNames(binary.Left, line, column, each, true);
                WalkExpressionNames(binary.Right, line, column, each, logical || !comparison);
                return;
            }

            default:
                return;
        }
    }

    /// <summary>
    /// The values a sequence will actually produce, when the config says so outright.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only one unnamed <c>&lt;gen type="text" value="a,b,c"&gt;</c> qualifies — a text
    /// generator's list is always literal, never a file or a pack, so what is written is what
    /// comes out.
    /// </para>
    /// <para>
    /// Unless something rewrites it. <c>case="upper"</c> turns <c>Male</c> into <c>MALE</c> and
    /// <c>mask="xxxx"</c> turns <c>Female</c> into <c>Fema</c>, so a comparison against the
    /// written word would then be wrong in both directions. <c>repeat=</c> makes the value a list
    /// rather than a word. Any of the three, and the values stop being knowable from here.
    /// </para>
    /// </remarks>
    private static List<string>? FiniteTextValues(IReadOnlyDictionary<string, string> gen)
    {
        if (!gen.TryGetValue("type", out string? type) || type != "text")
        {
            return null;
        }

        foreach (string rewrites in new[] { "case", "mask", "repeat" })
        {
            if (gen.ContainsKey(rewrites))
            {
                return null;
            }
        }

        if (!gen.TryGetValue("value", out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        return raw.Split(',').Select(v => v.Trim()).ToList();
    }

    private void CheckExpressionName(string path, int line, int column, bool each)
    {
        int dot = path.IndexOf('.', StringComparison.Ordinal);
        string root = dot < 0 ? path : path[..dot];
        string? tail = dot < 0 ? null : path[(dot + 1)..];

        bool known = _declaredNames.Contains(root)
            || Checks.Builtins.Contains(root)
            || (each && (root == "_item" || root == "_item_id"));
        if (!known)
        {
            string hint = tail is null
                ? "A condition that is a bare word is always true. Name a sequence declared in "
                    + "<env>, or compare against the word: Gender == Male."
                : "Name a sequence declared in <env>. A word on the RIGHT of a comparison is a "
                    + "literal and needs no declaration.";
            Error(
                "TDC215",
                "\"" + path + "\" is not a declared sequence — the condition reads it as the "
                + "literal text \"" + path + "\"",
                hint,
                line,
                column);
            return;
        }

        if (tail is null)
        {
            return;
        }

        // On a plain sequence the tail is a VALUE — Gender.Male asks whether Gender came out Male
        // — and where the config says outright what it produces, a value that is not among them
        // makes a branch nothing can take.
        if (!_valuelessNames.Contains(root))
        {
            if (!_finiteValues.TryGetValue(root, out List<string>? values)
                || values.Contains(tail, StringComparer.Ordinal))
            {
                return;
            }

            Warn(
                "TDC216",
                "\"" + path + "\" — \"" + root + "\" never produces \"" + tail
                + "\", so this branch can never be taken",
                "\"" + root + "\" produces: " + string.Join(", ", values) + ".",
                line,
                column);
            return;
        }

        int inner = tail.IndexOf('.', StringComparison.Ordinal);
        string field = inner < 0 ? tail : tail[..inner];
        if (_declaredNames.Contains(root + "." + field))
        {
            return;
        }

        List<string> fields = _declaredNames
            .Where(n => n.StartsWith(root + ".", StringComparison.Ordinal))
            .Select(n => n[(root.Length + 1)..])
            .ToList();
        Error(
            "TDC215",
            "\"" + path + "\" is not a field of \"" + root + "\" — the condition can never be true",
            fields.Count == 0
                ? "\"" + root + "\" has no fields."
                : "Fields of \"" + root + "\": " + string.Join(", ", fields) + ".",
            line,
            column);
    }

    /// <summary>
    /// The XML entities somebody writes in an expression, and what they meant. The config LOOKS
    /// like XML, so <c>filter="price &amp;lt;= Budget"</c> is what a careful person writes. TDC
    /// does not expand entities, so the parser sees nine characters where a <c>&lt;</c> was meant
    /// and reports the character it tripped over, which tells the reader nothing about what to
    /// change.
    /// </summary>
    private static readonly (string Found, string Means)[] XmlEntities =
    {
        ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&quot;", "\""), ("&apos;", "'"),
    };

    private static (string Found, string Means)? XmlEntity(string expression)
    {
        foreach (var pair in XmlEntities)
        {
            if (expression.Contains(pair.Found, StringComparison.Ordinal))
            {
                return pair;
            }
        }

        return null;
    }

    private void CheckIfExpression(string expression, int line, int column)
    {
        Expr.Expr parsed;
        try
        {
            parsed = Expr.Expr.Parse(expression);
        }
        catch (ArgumentException e)
        {
            var entity = XmlEntity(expression);
            if (entity is null)
            {
                Error(
                    "TDC100", $"invalid if expression \"{Clip(expression)}\": {e.Message}",
                    "Supported: comparison, && || !, and arithmetic.", line, column);
            }
            else
            {
                Error(
                    "TDC100",
                    $"invalid if expression \"{Clip(expression)}\": TDC does not expand XML entities, "
                        + $"so \"{entity.Value.Found}\" is {entity.Value.Found.Length} literal characters, "
                        + $"not \"{entity.Value.Means}\"",
                    $"write {entity.Value.Means} directly — the config is XML-shaped but it is not XML, "
                        + "and the raw character is what the expression parser reads",
                    line, column);
            }
            return;
        }

        CheckExprNode(parsed, line, column);
    }

    /// <summary>
    /// Every operator in a parsed condition, checked against the ones the engine implements.
    /// </summary>
    /// <remarks>
    /// A parser that is more permissive than the evaluator is a trap: the config is accepted, and
    /// the operator it asked for is quietly not the operator it gets.
    /// </remarks>
    private void CheckExprNode(Expr.Expr node, int line, int column)
    {
        switch (node)
        {
            case Expr.Expr.Binary binary:
                if (!SupportedBinaryOperators.Contains(binary.Op))
                {
                    Error(
                        "TDC101", $"unsupported operator \"{binary.Op}\" in if expression",
                        "Supported binary operators: "
                        + string.Join(" ", SupportedBinaryOperators) + ".",
                        line, column);
                }

                CheckExprNode(binary.Left, line, column);
                CheckExprNode(binary.Right, line, column);
                return;

            case Expr.Expr.Computed computed:
                Error(
                    "TDC103", "computed member access is not supported in if expression",
                    "Use plain dotted access like Gender.Male or Person.FirstName.", line, column);
                CheckExprNode(computed.Object, line, column);
                return;

            case Expr.Expr.Unary unary:
                if (!SupportedUnaryOperators.Contains(unary.Op))
                {
                    Error(
                        "TDC102", $"unsupported unary operator \"{unary.Op}\" in if expression",
                        "Supported unary operators: "
                        + string.Join(" ", SupportedUnaryOperators) + ".",
                        line, column);
                }

                CheckExprNode(unary.Operand, line, column);
                return;
        }
    }

    // ── placement ────────────────────────────────────────────────────────────────────────────

    private void CheckChildren(
        TDCParser.ContentContext? content, string parent, IReadOnlySet<string> allowed) =>
        CheckChildren(content, parent, allowed, "TDC010", allowed);

    /// <summary>Report every child not on <paramref name="allowed"/>.</summary>
    /// <remarks>
    /// <paramref name="allowed"/> is what PASSES; <paramref name="shown"/> is what the note
    /// lists. They differ for <c>&lt;pool&gt;</c>, where several tags are refused by a
    /// diagnostic of their own (TDC230) and so must not be reported here — but must not be
    /// offered as allowed either.
    /// </remarks>
    private void CheckChildren(
        TDCParser.ContentContext? content, string parent, IReadOnlySet<string> allowed,
        string code, IReadOnlySet<string> shown)
    {
        string listed = string.Join(", ", shown.OrderBy(a => a, StringComparer.Ordinal));
        if (content is null)
        {
            return;
        }

        foreach (TDCParser.ElementContext child in content.element())
        {
            string? name = null;
            int line = 0;
            int column = 0;
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (open is not null)
            {
                name = open.name.Text;
                line = Line(open);
                column = Column(open);
            }
            else if (self is not null)
            {
                name = self.name.Text;
                line = Line(self);
                column = Column(self);
            }
            else if (child.mapElement() is not null)
            {
                name = "map";
                line = 1;
                column = 0;
            }

            if (name is null || allowed.Contains(name))
            {
                continue;
            }

            // Two different mistakes, and two different fixes. A construct this language knows is in
            // the wrong place and needs moving; a tag nobody has heard of is a typo and needs
            // correcting. One code for both would tell the author neither.
            if (PlacementHints.TryGetValue(name, out string? hint))
            {
                Error(
                    "TDC013", $"<{name}> is not allowed directly inside <{parent}>",
                    $"{hint} Allowed inside <{parent}>: {listed}.", line, column);
            }
            else if (code == "TDC013")
            {
                // TDC013 means "a tag this language knows, in the wrong place" and TDC010
                // "a tag nobody has heard of", so the sentence follows the code.
                Error(
                    "TDC013", $"<{name}> is not allowed directly inside <{parent}>",
                    $"Allowed inside <{parent}>: {listed}.", line, column);
            }
            else
            {
                Error(
                    // The note is what a reader acts on, so every container says it alike.
                    code, $"unknown child of <{parent}>: \"<{name}>\"",
                    $"Allowed inside <{parent}>: {listed}.", line, column);
            }
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    private void Error(string code, string message, string hint, int line, int column) =>
        _diagnostics.Add(Diagnostic.Error(code, message, hint, line, column));

    /// <summary>Worth saying, not worth stopping for: the run still produces usable data.</summary>
    private void Warn(string code, string message, string hint, int line, int column) =>
        _diagnostics.Add(Diagnostic.Warning(code, message, hint, line, column));

    /// <summary>
    /// Where an attribute's value sits, for a complaint that is about that value.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An editor underlines what a diagnostic points at, and a whole tag is not what is wrong when
    /// one attribute is. The position is the first character INSIDE the quotes, which is where the
    /// value the message is quoting actually begins.
    /// </para>
    /// <para>
    /// Falls back to the element when the attribute is absent — a complaint about a missing
    /// attribute has nowhere better to point.
    /// </para>
    /// </remarks>
    /// <summary><c>uniq="true"</c> where the value is not DRAWN, so there is no pool to take from.</summary>
    /// <remarks>
    /// Uniqueness is a property of a draw — without replacement on a simple sequence, a
    /// rearrangement of the columns on a compound one. A computed result and a conditional pick
    /// are neither, so the attribute could only be ignored, and it used to be in silence: the
    /// config claimed the column was unique and the data disagreed without a word.
    /// </remarks>
    /// <summary><c>uniq="true"</c> on a composed value that joins two or more DRAWN parts.</summary>
    /// <remarks>
    /// One drawn part plus constants is fine and honoured: appending a constant cannot make two
    /// different draws collide. Two drawn parts have no fixed widths, so a unique set of parts is
    /// not a unique join — <c>9</c> + <c>15</c> and <c>91</c> + <c>5</c> are the same three
    /// characters.
    /// </remarks>
    private void UniqOnComposed(
        TDCParser.OpenCloseElementContext open, string? name,
        List<IReadOnlyDictionary<string, string>> gens)
    {
        string? uniq = Attributes(open.attr()).GetValueOrDefault("uniq");
        if (uniq is null || !string.Equals(uniq.Trim(), "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        int drawn = gens.Count(g => !g.ContainsKey("name"));
        if (drawn < 2)
        {
            return;
        }

        (int line, int column) = At(open, "uniq");
        Error(
            "TDC220",
            $"uniq=\"true\" cannot be honoured on <sequence name=\"{name ?? "?"}\">: its value "
                + $"joins {drawn} drawn parts, and a unique set of parts is not a unique join when "
                + "the parts have no fixed width",
            "Give each part its own <sequence> and wrap them in <uniq>\u2026</uniq>, with a fixed "
                + "width per part (length= plus first_zero=\"true\" on a number). Then the join "
                + "can be split back one way only, so a unique combination is a unique result.",
            line, column);
    }

    private void UniqUnsupported(TDCParser.OpenCloseElementContext open, string? name, string why)
    {
        string? uniq = Attributes(open.attr()).GetValueOrDefault("uniq");
        if (uniq is null || !string.Equals(uniq.Trim(), "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        (int line, int column) = At(open, "uniq");
        Error(
            "TDC218",
            $"uniq=\"true\" is not allowed on <sequence name=\"{name ?? "?"}\">: {why}",
            "Put uniq= on the sequences this one reads, or wrap them in <uniq>…</uniq> so their "
                + "combination is unique across records. When the parts have fixed widths, a "
                + "unique combination means a unique result.",
            line, column);
    }

    private static (int Line, int Column) At(
        TDCParser.AttrContext[] attrs, string name, int line, int column)
    {
        foreach (TDCParser.AttrContext attr in attrs)
        {
            if (attr.attrName is not null && attr.attrName.Text == name && attr.attrValue is not null)
            {
                string text = attr.attrValue.Text;
                bool quoted = text.Length >= 2
                    && text.StartsWith('"') && text.EndsWith('"');
                return (attr.attrValue.Line, attr.attrValue.Column + (quoted ? 1 : 0));
            }
        }

        return (line, column);
    }

    private static (int Line, int Column) At(
        TDCParser.SelfClosingElementContext el, string name) =>
        At(el.attr(), name, Line(el), Column(el));

    private static (int Line, int Column) At(
        TDCParser.OpenCloseElementContext el, string name) =>
        At(el.attr(), name, Line(el), Column(el));

    private static IReadOnlyDictionary<string, string> Attributes(TDCParser.AttrContext[] attrs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TDCParser.AttrContext attr in attrs)
        {
            string raw = attr.attrValue.Text;
            result[attr.attrName.Text] = raw.Substring(1, raw.Length - 2);
        }

        return result;
    }

    private static int Line(TDCParser.OpenCloseElementContext el) => el.Start.Line;

    private static int Column(TDCParser.OpenCloseElementContext el) => el.Start.Column;

    private static int Line(TDCParser.SelfClosingElementContext el) => el.Start.Line;

    private static int Column(TDCParser.SelfClosingElementContext el) => el.Start.Column;

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

    private static IReadOnlySet<string> Set(params string[] values) =>
        new HashSet<string>(values, StringComparer.Ordinal);

    /// <summary>
    /// The most of an attribute value a message will quote. The full text is in the config the
    /// position already points at; a message quoting 100 KB of it buries every other diagnostic
    /// in the report. The same limit lives in the other four implementations; change them
    /// together.
    /// </summary>
    private const int MessageEchoLimit = 120;

    /// <summary>An attribute value, cut to fit inside a one-line message.</summary>
    private static string Clip(string value)
    {
        if (value.Length <= MessageEchoLimit)
        {
            return value;
        }
        int hidden = value.Length - MessageEchoLimit;
        return value[..MessageEchoLimit] + "\u2026 (" + hidden + " more chars)";
    }

    /// <summary>A <c>&lt;gen&gt;</c>'s attributes and where it starts, whichever way it was punctuated.</summary>
    private sealed record GenNode(TDCParser.AttrContext[] Attrs, int Line, int Column);

    /// <summary>
    /// The <c>&lt;gen&gt;</c> in this child, self-closing or open/close alike.
    /// </summary>
    /// <remarks>
    /// Matching only the self-closing form left <c>&lt;gen …&gt;&lt;/gen&gt;</c> unseen, and the
    /// sequence was then blamed for having no generator while one stood in plain sight.
    /// </remarks>
    private GenNode? GenNodeOf(TDCParser.ElementContext child)
    {
        TDCParser.SelfClosingElementContext self = child.selfClosingElement();
        if (self is not null && self.name.Text == "gen")
        {
            return new GenNode(self.attr(), Line(self), Column(self));
        }

        TDCParser.OpenCloseElementContext open = child.openCloseElement();
        if (open is not null && open.name.Text == "gen")
        {
            return new GenNode(open.attr(), Line(open), Column(open));
        }

        return null;
    }


    /// <summary>What may sit directly inside <c>&lt;sequence&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> SequenceChildren =
        new HashSet<string> { "gen", "data", "distinct", "compute" };

    /// <summary>
    /// <c>&lt;distinct&gt;</c>/<c>&lt;uniq&gt;</c> mean two different things by position: inside
    /// a <c>&lt;sequence&gt;</c> the FIELDS of one record, at <c>&lt;env&gt;</c> level whole
    /// COLUMNS. One list for both refuses working configs.
    /// </summary>
    private static readonly IReadOnlySet<string> DistinctChildren = new HashSet<string> { "gen" };

    /// <summary>Deliberately generous: too short a list refuses configs that work today.</summary>
    private static readonly IReadOnlySet<string> PoolChildren = new HashSet<string>
    {
        "sequence", "mix", "switch", "uniq", "distinct", "member", "data",
    };

    /// <summary>A fixture holds literal text and <c>&lt;line&gt;</c>s.</summary>
    private static readonly IReadOnlySet<string> FixtureChildren =
        new HashSet<string> { "data", "line" };

    /// <summary>What may sit directly inside <c>&lt;switch&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> SwitchChildren =
        new HashSet<string> { "map", "case", "default" };

    /// <summary>What may sit directly inside <c>&lt;block&gt;</c> and <c>&lt;line&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> BlockChildren =
        new HashSet<string> { "line", "data" };

    private static readonly IReadOnlySet<string> LineChildren =
        new HashSet<string> { "data", "gen", "mix", "switch" };

    private static readonly IReadOnlySet<string> FixtureTagNames = new HashSet<string>
    {
        "before", "after", "before_block", "after_block", "delimiter_block", "before_line",
        "after_line", "delimiter_line",
    };

}
