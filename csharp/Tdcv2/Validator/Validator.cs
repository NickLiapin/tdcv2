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

using Tdcv2.Expr;

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

            // An assertion is its two attributes and nothing else.
            ["assert"] = Set("that", "says", "comment"),
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
    /// <summary>
    /// What the ENGINE reads off a <c>&lt;gen type="template"&gt;</c> before the pack runs.
    /// </summary>
    /// <remarks>
    /// Kept in step with <c>MemoryEngine.ReservedTemplateAttrs</c>. A pack may claim any OTHER
    /// name, which is why the ownership table has no jurisdiction there: it refused
    /// <c>base=</c> on the 39 packs that declare a <c>&lt;sequence name="base"&gt;</c> — the
    /// whole check-digit family — on configs the engine would have run.
    /// </remarks>
    private static readonly IReadOnlySet<string> ReservedTemplateAttrs = Set(
        "type", "value", "local", "name", "if", "comment", "anomaly", "anomaly_factor",
        "anomaly_flag", "missing", "missing_as", "mask", "case", "order", "cycle");

    /// <summary>
    /// What the pack-parameter check may skip: the engine-reserved names plus the wrappers
    /// applied around the produced value. Using the union of EVERY generator's attributes
    /// instead meant a name like <c>points=</c> was reported by nobody once the ownership
    /// check stopped guessing.
    /// </summary>
    private static readonly IReadOnlySet<string> PackWrapperAttrs = Set(
        "anomaly", "anomaly_factor", "anomaly_flag", "case", "comment", "count", "cycle", "flag", "if", "local",
        "mask", "missing", "missing_as", "name", "order", "parent", "repeat", "separator", "type", "value", "distinct");

    /// <summary>The output wrappers a generator type does NOT put its value through.</summary>
    /// <remarks>
    /// <c>running</c> and <c>stat</c> are resolved before the formatting layer runs — they read
    /// a column that already exists and publish the number as it stands — so these sat on them
    /// doing nothing while <c>check</c> called the config valid. Refused rather than
    /// implemented: the interpolation filter runs where the value is PRINTED, so
    /// <c>${{Total|mask:x}}</c> works today.
    /// </remarks>
    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> WrappersNotRead =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            ["running"] = Set("mask", "case", "missing", "missing_as", "repeat", "anomaly", "anomaly_factor"),
            ["stat"] = Set("mask", "case", "missing", "missing_as", "repeat", "anomaly", "anomaly_factor"),
            // A pool reference hands the row a whole MEMBER from a table built before the run,
            // so there is no value of its own for the formatting layer to reach.
            ["pool"] = Set("mask", "case", "missing", "missing_as", "repeat", "anomaly", "anomaly_factor", "percent"),
        };

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

            // The seasonal wave's highest row.
            ["peak_at"] = Set("timeseries"),

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
            ["secret"] = Set("http"),

            // The drawn curve.
            ["points"] = Set("pattern"),
            ["upper"] = Set("pattern"),
            ["lower"] = Set("pattern"),
            ["y_range"] = Set("pattern"),
            ["fit"] = Set("pattern"),
            ["interp"] = Set("pattern"),
            ["spread"] = Set("pattern"),
            ["ink_threshold"] = Set("pattern"),

            // The synthetic series.
            // On a date, `of=` measures from a sibling instead of drawing, and `plus=` is the
            // distance.
            ["of"] = Set("running", "stat", "date"),
            ["plus"] = Set("date"),
            ["reset"] = Set("running"),
            ["op"] = Set("stat"),
            ["base"] = Set("timeseries", "running"),
            ["trend"] = Set("timeseries"),
            ["period"] = Set("timeseries"),
            ["amplitude"] = Set("timeseries"),
            ["noise"] = Set("timeseries"),

            // Zero-padding a numeric range.
            ["first_zero"] = Set("number"),

            // ── The date's own vocabulary ─────────────────────────────────────────────
            //
            // from=/to= are the trap that reopened this table. They are the natural words for
            // a numeric range, they are real attributes, and a number generator has never read
            // them: <gen type="number" from="1000" to="9999"/> produced 3 4 4 6 — four-digit
            // ids asked for, single digits produced, check calling the config valid.
            ["from"] = Set("date"),
            ["to"] = Set("date"),
            ["format"] = Set("date"),
            ["precision"] = Set("date"),

            // The birth window, read only where a birthday is drawn.
            ["oldest"] = Set("date"),
            ["youngest"] = Set("date"),

            // ── The shape of a drawn value ────────────────────────────────────────────
            //
            // length= on a text or a regex is the second-most natural thing to write and does
            // nothing: a text walks the list you gave it, and a regex is as long as its
            // pattern says.
            ["length"] = Set("number", "symbol"),
            ["include"] = Set("number", "symbol"),
            ["exclude"] = Set("number", "symbol"),

            // How many places the answer is printed to. Four generators produce a number they
            // may have to round; the rest produce text, which has no places.
            ["decimals"] = Set("number", "timeseries", "pattern", "stat", "formula", "file"),
            // How a file is READ, and how the distribution behind it is sampled.
            ["read"] = Set("file"),
            ["sample"] = Set("file"),
            // The shape of a repeat's LENGTHS — meaningless without `repeat=`, which the
            // validator checks separately.
            ["lengths"] = Set(
                "text", "number", "date", "regex", "advanced_regex", "symbol", "template", "file",
                "formula"),
            // The expression a formula evaluates. Only `formula` — `if=` and `filter=` hold one
            // too, but those are wrappers every type takes, not this one's own parameter.
            ["expr"] = Set("formula"),
            ["distribution"] = Set("number"),

            // The ceiling on what an unbounded pattern may expand to.
            ["regex_max_length"] = Set("regex", "advanced_regex"),

            // How a drawing is read — as a curve or as a density.
            ["mode"] = Set("pattern"),

            // percent= is deliberately ABSENT: only text and number read it as a share of
            // their own values, but the engine routes ANY generator carrying it through the
            // share machinery.

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
        new[]
        {
            "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/",
            // Euclidean, matching <mod>: -3 % 2 is 1 here and -1 in C#'s own %.
            "%",
            // Set membership: `Country in [US, CA, MX]`.
            "in",
        };

    /// <summary>
    /// What an <c>if=</c> may call: the name, then the smallest and largest argument count
    /// (<c>int.MaxValue</c> for variadic).
    ///
    /// The exact ones are built from comparisons and the arithmetic IEEE-754 pins down. The
    /// transcendental ones are computed by TDC itself (<c>Tdcv2.Maths.TdcMath</c>) rather than by
    /// the host libm, which is what keeps five implementations on one double.
    /// </summary>
    private static readonly IReadOnlyList<(string Name, int Low, int High)> ExprFunctions =
        new[]
        {
            ("abs", 1, 1), ("acos", 1, 1), ("acosh", 1, 1), ("asin", 1, 1), ("asinh", 1, 1),
            ("at", 2, 2), ("atan", 1, 1), ("atan2", 2, 2), ("atanh", 1, 1), ("beta", 2, 2),
            ("cbrt", 1, 1),
            ("ceil", 1, 1), ("contains", 2, 2), ("cos", 1, 1), ("cosh", 1, 1), ("count", 1, 1),
            ("degrees", 1, 1), ("digamma", 1, 1), ("ends_with", 2, 2),
            ("erf", 1, 1), ("erfc", 1, 1), ("exp", 1, 1), ("expm1", 1, 1), ("floor", 1, 1),
            ("gamma", 1, 1), ("gauss", 3, 3), ("hash", 2, 2), ("clamp", 3, 3), ("lerp", 3, 3), ("hypot", 2, 2),
            ("is_empty", 1, 1), ("join", 2, 2), ("len", 1, 1), ("lgamma", 1, 1), ("log", 1, 1),
            ("log10", 1, 1), ("log1p", 1, 1),
            ("log2", 1, 1), ("lower", 1, 1), ("max", 1, int.MaxValue), ("mean", 1, 1),
            ("median", 1, 1), ("min", 1, int.MaxValue),
            ("pow", 2, 2), ("radians", 1, 1), ("round", 1, 1), ("sign", 1, 1), ("sin", 1, 1),
            ("sinh", 1, 1), ("split", 2, 2), ("sqrt", 1, 1), ("starts_with", 2, 2),
            ("stddev", 1, 1), ("sum", 1, 1), ("tan", 1, 1), ("tanh", 1, 1),
            ("trunc", 1, 1), ("upper", 1, 1), ("zeta", 1, 1),
        };

    private static readonly IReadOnlyList<string> ExprFunctionNames =
        new[]
        {
            "abs", "acos", "acosh", "asin", "asinh", "at", "atan", "atan2", "atanh", "beta",
            "cbrt", "ceil", "contains", "cos", "cosh", "count", "degrees", "digamma",
            "ends_with", "erf", "erfc",
            "clamp", "exp", "expm1", "floor", "gamma", "gauss", "hash", "hypot", "is_empty", "join",
            "len",
            "lerp", "lgamma",
            "log", "log10", "log1p", "log2", "lower", "max", "mean", "median", "min", "pow",
            "radians", "round", "sign",
            "sin", "sinh", "split", "sqrt", "starts_with", "stddev", "sum", "tan", "tanh",
            "trunc", "upper", "zeta",
        };

    /// <summary>
    /// Not available, and not typos either. Someone writing <c>besselj(_count)</c> knows what they
    /// meant, and "did you mean beta?" is worse than saying nothing. What is left is the
    /// mathematics a data generator has no business carrying.
    ///
    /// <para>Every name here has to be built and pinned to its bits in five languages before it
    /// can be offered, which is the only thing keeping it on this list.</para>
    /// </summary>
    private static readonly IReadOnlyList<string> PlannedExprFunctions =
        new[] { "airy", "besselj", "bessely", "elliptic_e", "elliptic_k", "polygamma" };

    /// <summary>
    /// The functions that hand back a list. <c>at</c> reads one, and nothing else does today;
    /// when a second joins, it goes here and the check stays put.
    /// </summary>
    private static readonly IReadOnlySet<string> ListReturningFunctions = Set("split");

    private static readonly IReadOnlyList<string> SupportedUnaryOperators = new[] { "!", "-", "+" };

    /// <summary>What may sit directly inside <c>&lt;env&gt;</c>.</summary>
    private static readonly IReadOnlySet<string> EnvChildren = Set(
        "sequence", "mix", "switch", "pool", "uniq", "distinct", "assert", "before", "after",
        "before_block",
        "after_block", "delimiter_block", "before_line", "after_line", "delimiter_line");

    /// <summary>
    /// What an <c>&lt;env&gt;</c>-level <c>&lt;uniq&gt;</c> / <c>&lt;distinct&gt;</c> may wrap.
    /// </summary>
    /// <remarks>
    /// Inside a <c>&lt;sequence&gt;</c> those two group the FIELDS of one record; at env level
    /// they group whole COLUMNS, so their members are declarations. There was no list here at
    /// all, so an invented tag inside a group was accepted in silence while the reference
    /// refused it — measured with <c>&lt;banana/&gt;</c>: TDC010 in TypeScript, nothing here.
    /// </remarks>
    private static readonly IReadOnlySet<string> EnvGroupChildren =
        Set("sequence", "mix", "switch");

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
    /// <summary>parent= belongs on the &lt;sequence&gt;; count= and flag= belong to other tags.</summary>
    private const string MisplacedGenParent =
        "parent= selects which rows a whole <sequence> or <mix> builds on; move it there. "
        + "A <gen> inside one is already filtered by it.";

    /// <summary>Attributes a &lt;gen&gt; may carry that are not pack parameters.</summary>
    private static readonly IReadOnlySet<string> NotAPackParam =
        new HashSet<string> { "parent", "count", "flag" };

    private static readonly IReadOnlySet<string> GenAttrs = Set(
        "type", "value", "name", "if", "comment", "case", "mask", "order", "cycle", "repeat",
        "separator", "accumulate", "distinct", "of", "plus", "reset", "op", "missing",
        "missing_as", "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "local", "weight", "percent", "first_zero", "include", "exclude",
        "length", "decimals", "distribution", "regex_max_length", "alphabet", "format", "from",
        "to", "oldest", "youngest", "precision", "range", "step", "weekdays", "peak_at",
        "src", "column",
        "header",
        "delimiter", "row", "base", "trend", "period", "amplitude", "noise", "points", "upper",
        "lower", "y_range", "fit", "interp", "spread", "ink_threshold", "mode", "in", "on_error",
        "timeout", "secret", "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin",
        "shape", "scale",
        "lambda", "n", "s", "beta", "min", "max", "filter", "read", "sample", "expr", "lengths");

    private static readonly IReadOnlySet<string> GenTypes = Set(
        "text", "file", "template", "number", "regex", "advanced_regex", "symbol", "date",
        "increment", "decrement", "timeseries", "pattern", "http", "pool", "running",
        "stat", "formula");

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
    /// Every <c>&lt;gen&gt;</c> carrying a <c>row=</c>, wherever it sits. A link is checked once
    /// the whole <c>&lt;env&gt;</c> has been walked because its members are free to live in
    /// different sequences — which is exactly the case a per-sequence check misses.
    /// </summary>
    private readonly List<(string Key, string Src, GenNode Node)> _rowLinkGens = new();

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
    private readonly List<(int At, string Expression, int Line, int Column, bool Each,
        HashSet<string>? Scope)> _pendingExpressions = new();

    /// <summary>
    /// The names a deferred expression may see, where they are NOT the run's.
    /// </summary>
    /// <remarks>
    /// A <c>&lt;pool&gt;</c> member reads its own pool and nothing else: the table is built before
    /// any row exists, so a condition naming an env column is constant-false on every member. Null
    /// is every expression outside a pool.
    /// </remarks>
    private HashSet<string>? _exprScope;

    private readonly Dictionary<TDCParser.OpenCloseElementContext, HashSet<string>>
        _poolMemberScope = new();

    /// <summary>
    /// Put an expression aside, together with the names it will be checked against.
    /// </summary>
    /// <remarks>
    /// The scope is taken HERE rather than at the end: by then a pool's members have left the walk,
    /// and checking one of their conditions against the run's names got it wrong in both directions
    /// — a sibling field read as undeclared, and an env column read as fine.
    /// </remarks>
    private void DeferExpression(string expression, int line, int column, bool each) =>
        _pendingExpressions.Add((_diagnostics.Count, expression, line, column, each, _exprScope));

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
        var pending = new List<(int At, string Expression, int Line, int Column, bool Each,
            HashSet<string>? Scope)>(_pendingExpressions);
        _pendingExpressions.Clear();
        int shift = 0;
        foreach ((int at, string expression, int line, int column, bool each,
            HashSet<string>? scope) in pending)
        {
            int before = _diagnostics.Count;
            HashSet<string>? outer = null;
            if (scope is not null)
            {
                outer = new HashSet<string>(_declaredNames, StringComparer.Ordinal);
                _declaredNames.Clear();
                _declaredNames.UnionWith(scope);
            }

            CheckExpressionNames(expression, line, column, each);
            if (outer is not null)
            {
                _declaredNames.Clear();
                _declaredNames.UnionWith(outer);
            }

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
        // Both containers are read by taking the FIRST of their kind, so a second one is dropped
        // whole — every sequence it declares, every line it lays out — and the run finishes
        // looking healthy while half the config produced nothing. The same silent discard TDC014
        // refuses for the self-closing spelling, one level up. Reported on the SECOND one: the
        // first is what runs, so the second is the surprise.
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (TDCParser.ElementContext child in tdc.content().element())
        {
            TDCParser.OpenCloseElementContext here = child.openCloseElement();
            if (here is not null && here.name.Text is "env" or "block")
            {
                string tag = here.name.Text;
                seen[tag] = seen.GetValueOrDefault(tag) + 1;
                if (seen[tag] > 1)
                {
                    Error(
                        "TDC270",
                        $"<tdc> holds more than one <{tag}> — only the first is read, and this "
                        + "one is discarded whole",
                        tag == "env"
                            ? "Every sequence declared here would be missing at render time. "
                              + "Move them into the first <env>."
                            : "Every line laid out here would be missing from the output. Move "
                              + "them into the first <block>, or use <line if=\"\u2026\"> to "
                              + "switch layouts per row.",
                        Line(here), Column(here));
                }
            }

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

        // The renderer splits on `(.+)%(.+)`, so the pattern needs a `%` with something on
        // BOTH sides. Counting the `%` alone let "%%" and "%x" through: they have one, they
        // cannot be split, and the renderer quietly stopped interpolating.
        // Several holes is the other half of the same defect: the renderer takes the
        // RIGHTMOST, so the rest survive as a literal `%` in the wrapper and the text would
        // have to carry one to match. inject="[%]-[%]" with <data>[Id]-[Id]</data> came out as
        // [Id]-[Id] in five implementations and was refused by none.
        string? inject = envAttrs.GetValueOrDefault("inject");
        if (inject is not null)
        {
            int holes = 0;
            for (int i = 1; i + 1 < inject.Length; i++)
            {
                if (inject[i] == '%')
                {
                    holes++;
                }
            }

            (int line, int column) = At(env, "inject");
            if (holes == 0)
            {
                Error(
                    "TDC021",
                    inject.Contains('%')
                        ? $"inject pattern \"{inject}\" has nothing on both sides of its \"%\" — "
                            + "interpolation will never match"
                        : $"inject pattern \"{inject}\" has no \"%\" placeholder — interpolation will "
                            + "never match",
                    "The `%` is where the sequence name goes, and it needs an opening and a closing "
                    + "part around it: inject=\"${{%}}\", inject=\"[%]\", inject=\"%{%}%\".",
                    line, column);
            }
            else if (holes > 1)
            {
                Error(
                    "TDC021",
                    $"inject pattern \"{inject}\" marks {holes} holes — one marker has room for one",
                    "A `%` is the hole where the sequence name goes, and there is one of them. The "
                    + "engine reads the rightmost, so the others stay as a literal `%` in the "
                    + "wrapper and your text would have to contain one to match. Write a single "
                    + "hole — inject=\"[%]\" — and repeat the name in the <data> instead: "
                    + "<data>[Id]-[Id]</data>. inject=\"%{%}%\" is fine, because only its middle "
                    + "`%` has text on both sides.",
                    line, column);
            }
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
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.OpenCloseElementContext? group = child.openCloseElement();
            if (group is not null && (group.name.Text == "uniq" || group.name.Text == "distinct"))
            {
                CheckChildren(group.content(), group.name.Text, EnvGroupChildren);
            }
        }
        this.CheckAsserts(env);
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

            // Every expression deferred while this declaration is walked is a pool member's or the
            // run's, and the two see different names.
            _exprScope = this._poolMemberScope.GetValueOrDefault(open);
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

                    // A pool reference draws no column of its own — it hands the row a whole
                    // member from a table built before the run — so there is nothing to take
                    // without replacement.
                    bool drawsPool = open.content().element()
                        .Select(GenNodeOf)
                        .Any(gn => gn is not null
                            && Attributes(gn.Attrs).GetValueOrDefault("type") == "pool");
                    if (drawsPool)
                    {
                        this.UniqUnsupported(
                            open, name,
                            "it draws a whole member from a <pool> rather than a column of its own, so there is nothing to draw without replacement \u2014 put uniq= on a <sequence> inside the <pool> to make the members distinct");
                    }
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

        // Once, at the end: a row= link is free to span sequences, so its members are only all in
        // view now.
        RowLinkSource();
        _exprScope = null;
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

            // A COMPOUND member publishes Name.Field for each of its named gens, and the pool
            // exposes those under the same dotted name — the engine does it, so the CLI must
            // accept it. ${{Seen.addr.city}} printed Paris on a run and was TDC193 on a check.
            foreach (TDCParser.ElementContext child in node.content().element())
            {
                GenNode? gen = GenNodeOf(child);
                if (gen is null)
                {
                    continue;
                }

                string field = (Attributes(gen.Attrs).GetValueOrDefault("name") ?? string.Empty).Trim();
                if (field.Length > 0)
                {
                    fields.Add($"{name}.{field}");
                }
            }

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

            this.CheckPoolFilter(
                attrs, poolName, fields, line, column,
                self is not null ? self.attr() : open!.attr());
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
        int column,
        TDCParser.AttrContext[] attrNodes)
    {
        string? expression = attrs.GetValueOrDefault("filter");
        if (string.IsNullOrWhiteSpace(expression))
        {
            return;
        }

        // The little language itself. The name checks below are about THIS pool's fields and
        // say nothing about whether the expression is runnable at all.
        (int fl, int fc) = At(attrNodes, "filter", line, column);
        CheckIfExpression(expression, fl, fc, "filter= expression", "a");

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

            // Compared the way `==` compares two texts, so the check cannot refuse a config
            // the run would have answered. Raw text refused `code == Want` where the members
            // hold 01,02,03 and the column produces 1,2,3 — the same question written with one
            // extra term matched every row.
            var fieldKeys = new HashSet<string>(fieldValues.Select(MatchKey.Of), StringComparer.Ordinal);
            if (otherValues.Any(v => fieldKeys.Contains(MatchKey.Of(v))))
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

                // What a member of THIS pool may name in an `if=`: the pool's own fields, gathered
                // by the pre-pass. A condition naming an env column is not merely out of scope —
                // the pool is built before any row exists, so it is constant-false on every member,
                // and the column it guards came out empty on every row.
                var scope = new HashSet<string>(
                    declaredPool is not null && _poolFields.TryGetValue(declaredPool, out List<string>? poolOwn)
                        ? poolOwn
                        : Array.Empty<string>(),
                    StringComparer.Ordinal);
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
                        this._poolMemberScope[inner] = scope;
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
                                this._poolMemberScope[wrapped] = scope;
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
                        CheckGroupDerivedMember(wrapped, tag);
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

    /// <summary>A DERIVED column inside a <c>&lt;uniq&gt;</c> or <c>&lt;distinct&gt;</c> group.</summary>
    /// <remarks>
    /// <para>A group is a rearrangement: it keeps every member's multiset of values and permutes
    /// the columns until each record is unique. Sound for drawn columns — a draw means the same
    /// wherever it lands — and destructive for a derived one, whose value is a statement ABOUT the
    /// row it was computed for. Measured on the reference, <c>&lt;uniq&gt;</c> over <c>A</c> (1..5)
    /// and <c>F = A * 10</c> gave <c>2|20  3|20  3|30  2|30  5|50</c>: two rows of five saying that
    /// ten times three is twenty, with <c>check</c> calling the config valid.</para>
    ///
    /// <para>A <c>&lt;compute&gt;</c> is the same case from the other side — <c>f(x)</c> is
    /// <c>f(x)</c>, so it has no pool to draw from and no column of its own to rearrange.</para>
    /// </remarks>
    private void CheckGroupDerivedMember(TDCParser.OpenCloseElementContext sequence, string tag)
    {
        string name = Attributes(sequence.attr()).GetValueOrDefault("name") ?? "?";
        foreach (TDCParser.ElementContext child in sequence.content().element())
        {
            TDCParser.OpenCloseElementContext open = child.openCloseElement();
            if (open is not null && open.name.Text == "compute")
            {
                Error(
                    "TDC296",
                    $"<sequence name=\"{name}\"> holds a <compute>, which cannot be a member of "
                    + $"<{tag}>: it derives its value from other columns, so it has nothing of its "
                    + "own to rearrange and cannot keep the group's promise",
                    $"Put the <{tag}> around the <gen> sequences the <compute> READS. Its value "
                    + "follows them, so arranging the inputs arranges the result.",
                    Line(open), Column(open));
                return;
            }

            TDCParser.SelfClosingElementContext gen = child.selfClosingElement();
            if (gen is null || gen.name.Text != "gen")
            {
                continue;
            }

            IReadOnlyDictionary<string, string> attrs = Attributes(gen.attr());
            string? type = attrs.GetValueOrDefault("type");
            if (!IsDerived(type, attrs))
            {
                continue;
            }

            string described = type == "date"
                ? "a date measured from another column (of=)"
                : $"a type=\"{type}\" column";
            Error(
                "TDC296",
                $"<sequence name=\"{name}\"> holds {described}, which cannot be a member of "
                + $"<{tag}>: the group rearranges finished columns, and a computed value moved to "
                + "another row no longer describes that row",
                $"Put the {tag} group around the columns this one READS, and leave the computed "
                + "column outside it. It follows whatever the group arranges, so it stays true row "
                + "by row.",
                Line(gen), Column(gen));
            return;
        }
    }

    /// <summary>A <c>&lt;gen&gt;</c> whose whole COLUMN is read from other columns rather than drawn.</summary>
    /// <remarks>
    /// A date is on the list only when <c>of=</c> makes it one: without it a date draws like
    /// anything else.
    /// </remarks>
    private static bool IsDerived(string? type, IReadOnlyDictionary<string, string> attrs) =>
        type switch
        {
            "formula" or "running" or "stat" => true,
            "date" => (attrs.GetValueOrDefault("of") ?? "").Trim().Length > 0,
            _ => false,
        };

    /// <summary><c>expr=</c> is what a formula IS, and every name in it must be declared above.</summary>
    private void CheckFormula(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "formula")
        {
            return;
        }

        string source = (attrs.GetValueOrDefault("expr") ?? "").Trim();
        if (source.Length == 0)
        {
            // An ABSENT attribute has no value to underline, so the tag is the target —
            // as for every other missing-attribute refusal. Pointing at type= put the
            // caret on the one thing written correctly.
            (int line, int column) = (Line(gen), Column(gen));
            Error(
                "TDC294", "<gen type=\"formula\"> needs expr=\"\u2026\"",
                "The expression is what the column IS: expr=\"Weight / (Height * Height)\".",
                line, column);
            return;
        }

        CheckParamNames(gen, "expr", source);
    }

    /// <summary>A derived column cannot be ONE BRANCH of a per-row choice.</summary>
    /// <remarks>
    /// <c>running</c>, <c>stat</c>, a date offset and <c>formula</c> are built once, for the whole
    /// column, in declaration order. An <c>if=</c> asks for something else entirely: a value chosen
    /// row by row. The two cannot both be true, and the run used to die with a message that read
    /// like an unfinished engine rather than a config that cannot mean anything.
    /// </remarks>
    private void CheckDerivedNotConditional(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (!IsDerived(type, attrs)
            || (attrs.GetValueOrDefault("if") ?? "").Trim().Length == 0)
        {
            return;
        }

        (int line, int column) = At(gen, "if");
        Error(
            "TDC295",
            $"a type=\"{type}\" column is built for the whole run, so it cannot carry if=",
            "It reads other columns in declaration order and produces one column, not a value "
            + "chosen per row. Put the condition where the value is USED \u2014 `<data "
            + "if=\"\u2026\">` \u2014 or compute the column unconditionally and branch on it "
            + "afterwards.",
            line, column);
    }

    /// <summary><c>read="quantile"</c> — the file as a sorted sample rather than a bag of values.</summary>
    /// <remarks>
    /// Everything refused here asks for TWO readings of one file at once. <c>weight=</c> says the
    /// shares live in a second column; <c>read="quantile"</c> says the values ARE the distribution.
    /// <c>row=</c> links several columns to one LINE, and a quantile answer is a point between two
    /// of them. <c>order="sequential"</c> walks the list in order, which a distribution has no
    /// notion of.
    /// </remarks>
    private void CheckQuantileRead(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "file")
        {
            return;
        }

        string read = (attrs.GetValueOrDefault("read") ?? "").Trim();
        string sample = (attrs.GetValueOrDefault("sample") ?? "").Trim();

        if (attrs.ContainsKey("read") && read != "quantile")
        {
            (int line, int column) = At(gen, "read");
            Error(
                "TDC297",
                $"read=\"{read}\" is not a way of reading a file \u2014 the only one is "
                + "\"quantile\"",
                "Leave read= off to pick one of the file's values at random, or write "
                + "read=\"quantile\" to read the file as a sorted sample and land anywhere on it.",
                line, column);
            return;
        }

        if (attrs.ContainsKey("sample") && sample != "exact")
        {
            (int line, int column) = At(gen, "sample");
            Error(
                "TDC297",
                $"sample=\"{sample}\" is not a sampling mode \u2014 the only one is \"exact\"",
                "Leave sample= off to draw from the distribution row by row, or write "
                + "sample=\"exact\" to sweep it evenly so the run reproduces the sample with no "
                + "sampling noise.",
                line, column);
        }

        if (attrs.ContainsKey("sample") && read != "quantile")
        {
            (int line, int column) = At(gen, "sample");
            Error(
                "TDC297", "sample= only means something beside read=\"quantile\"",
                "It chooses between drawing from the distribution and sweeping it evenly, and a "
                + "file read as a plain list of values has no distribution to sweep.",
                line, column);
        }

        if (read != "quantile")
        {
            return;
        }

        foreach ((string name, string why, string hint) in new[]
        {
            ("weight",
                "weight= puts the shares in a COLUMN beside the values, and read=\"quantile\" "
                + "says the values are the distribution themselves \u2014 how often one appears "
                + "in the file IS its share",
                "Keep one of the two readings. A countable value wants weight= and its exact "
                + "quota; a measured one wants the quantile read, which also fills in the values "
                + "between the observations."),
            ("row",
                "row= links several columns to one LINE of the file, and a quantile answer is not "
                + "a line: it is a point between two of them",
                "To keep a record together, read the file as lines with row= and leave read= off."),
        })
        {
            if ((attrs.GetValueOrDefault(name) ?? "").Trim().Length == 0)
            {
                continue;
            }

            (int line, int column) = At(gen, name);
            Error(
                "TDC297", $"{name}= cannot be combined with read=\"quantile\": {why}", hint,
                line, column);
        }

        if ((attrs.GetValueOrDefault("order") ?? "").Trim() == "sequential")
        {
            (int line, int column) = At(gen, "order");
            Error(
                "TDC297", "order=\"sequential\" cannot be combined with read=\"quantile\"",
                "Walking a list in order and sampling a distribution are different jobs: one hands "
                + "out the file's lines one after another, the other says where on the sorted "
                + "sample a row lands.",
                line, column);
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
            "TDC299",
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

        for (int i = 0; i < gens.Count; i++)
        {
            string rowKey = (gens[i].GetValueOrDefault("row") ?? string.Empty).Trim();
            if (rowKey.Length != 0)
            {
                _rowLinkGens.Add(
                    (rowKey, (gens[i].GetValueOrDefault("src") ?? string.Empty).Trim(),
                     genNodes[i]));
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
        UniqDropsGenAttrs(open, name, gens);
        UniqWithDistinct(open, name);
        RowLinkOrder(gens, genNodes);

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

        // The shape TDC246 refuses inside a <case>, one level out. A sequence mints the
        // ground-truth column only where the flagged gen IS its value: a name= turns the gen into
        // a FIELD and a second part makes it one piece of a joined string, and in both the engine
        // minted nothing while `check` called the config valid. The anomaly still fired — the
        // values came out perturbed — so the only thing missing was the record of WHICH rows, and
        // ${{NAME}} reached the output as its own literal text.
        if (gens.Count != 1 || fieldNames.Count > 0 || composes)
        {
            for (int g = 0; g < gens.Count; g++)
            {
                string? flag = gens[g].GetValueOrDefault("anomaly_flag");
                if (flag is null)
                {
                    continue;
                }

                (int line, int column) =
                    At(genNodes[g].Attrs, "anomaly_flag", genNodes[g].Line, genNodes[g].Column);
                Error(
                    "TDC283",
                    $"anomaly_flag=\"{flag.Trim()}\" is not read on a <gen> that is one part of "
                    + "its <sequence>",
                    "The flag records which ROWS were made outliers, and a sequence built from "
                    + "several parts has no row-level column to put it in. Move this <gen> into a "
                    + "<sequence> of its own \u2014 that also gives you the value as its own "
                    + "column.",
                    line, column);
            }
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
            this.DeferExpression(genCondition, gl, gc, false);

            // A pool reference publishes a whole MEMBER, and a <gen> carrying `if` becomes a
            // conditional branch the pool resolver does not recognise — so no Ref.field column
            // was registered and ${{Ref.name}} reached the output as its own literal text, on
            // every row including the ones the condition selected.
            if (Attributes(gen.attr()).GetValueOrDefault("type") == "pool")
            {
                Error(
                    "TDC268",
                    "if= is not supported on <gen type=\"pool\">: the reference publishes a "
                        + "whole MEMBER, and a conditional one would register no fields at all",
                    "To leave some rows without a member, use parent=\"\u2026\" \u2014 it masks "
                        + "the reference the same way it masks any other sequence, and the fields "
                        + "come out empty on the rows it excludes.",
                    gl, gc);
            }
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

        // Before the per-type checks, and INSTEAD of them when it fires: a value holding

        // ${{…}} is not the value its generator will try to parse, so letting the generator

        // also complain would put a wrong explanation beside the right one.

        if (CheckAttrInterpolation(gen, attrs, type))

        {

            return;

        }


        CheckRequiredValue(gen, attrs, type);
        CheckNumber(gen, attrs, type);
        CheckRegexes(gen, attrs, type);
        CheckSymbol(gen, attrs, type);
        CheckDate(gen, attrs, type);
        this.CheckTimeseries(gen, attrs, type);
        this.CheckSequentialRepeat(gen, attrs);
        CheckRepeat(gen, attrs, type);

        CheckGenAttributes(gen, attrs, type);

        CheckWeight(gen, attrs, type);
        // Before the source path is resolved: a file read the wrong way is a mistake about the
        // READING, and hearing "no such file" first would send the reader looking in the wrong
        // place.
        CheckQuantileRead(gen, attrs, type);
        CheckSource(gen, attrs, type);
        CheckHttp(gen, attrs, type);
        CheckRunning(gen, attrs, type);
        CheckStat(gen, attrs, type);
        CheckFormula(gen, attrs, type);
        CheckDerivedNotConditional(gen, attrs, type);
        CheckMask(gen, attrs);
        CheckCounter(gen, attrs, type);
        CheckDateTemplates(gen, attrs, type);
        CheckCaseAndOrder(gen, attrs);
        this.CheckImperfections(gen, attrs, type);

        // order="sequential" gives row r element `r mod N` — a rule about POSITION, which leaves
        // no room for a rule about SHARE. The engine ignores the percent outright, and nothing
        // told the user: percent="98,1,1" over a hundred rows came out 34/33/33 from a config
        // check had called valid.
        if (type is "text" or "file"
            && attrs.GetValueOrDefault("order")?.Trim() == "sequential"
            && attrs.ContainsKey("percent"))
        {
            (int line, int column) = At(gen, "percent");
            Error(
                "TDC271",
                $"percent=\"{attrs["percent"]}\" is not read beside order=\"sequential\": "
                + "walking the list in order fixes which value each row gets, so there is no "
                + "share left to apportion",
                "Drop order=\"sequential\" to have the shares apportioned exactly, or drop "
                + "percent= and take the values in the order they are written \u2014 each one "
                + "as often as the others.",
                line, column);
        }

        if (type == "text" && attrs.ContainsKey("percent"))
        {
            (int line, int column) = At(gen, "percent");
            CheckPercentMask(
                attrs["percent"], SplitCount(attrs.GetValueOrDefault("value", "")),
                new[] { "TDC051", "TDC052", "TDC053" }, line, column);
            WarnInferredZeros(
                attrs["percent"], attrs.GetValueOrDefault("value", ""), line, column);
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

        // `timeout=` is SECONDS. Left unchecked, the five implementations
        // disagreed twice: four fell back to the default in silence, Python threw
        // at run time — and Python read it as milliseconds, so the documented
        // `timeout="30"` gave up after 30ms.
        string? timeout = attrs.GetValueOrDefault("timeout");
        if (timeout is not null && !IsPositiveSeconds(timeout))
        {
            (int line, int column) = At(gen, "timeout");
            Error(
                "TDC069",
                $"invalid timeout \"{timeout.Trim()}\" — expected a positive number of seconds",
                "timeout=\"30\" waits thirty seconds for one answer. Omit it for the default of 30.",
                line, column);
        }

        // secret — the key a request is signed with. Three spellings, and only the literal is
        // worth saying anything about: a config travels into version control, and the secret would
        // travel with it. A warning rather than an error, because a service on 127.0.0.1 for an
        // afternoon is a real use and refusing it would only teach people to write it somewhere
        // worse.
        string? secret = attrs.GetValueOrDefault("secret");
        if (secret is not null)
        {
            string raw = secret.Trim();
            (int line, int column) = At(gen, "secret");
            if (raw.Length == 0)
            {
                Error(
                    "TDC284",
                    "secret=\"\" has no key to sign with",
                    "Name where the key lives: secret=\"env:TDC_HTTP_SECRET\" or "
                    + "secret=\"file:~/.tdc/service.key\". Remove the attribute to send the "
                    + "request unsigned.",
                    line, column);
            }
            else if (!raw.StartsWith("env:", StringComparison.Ordinal)
                && !raw.StartsWith("file:", StringComparison.Ordinal))
            {
                Warn(
                    "TDC284",
                    "secret= is written into the config, so it travels wherever the config does",
                    "A config goes into version control and the key goes with it. "
                    + "secret=\"env:TDC_HTTP_SECRET\" reads it from the environment, "
                    + "secret=\"file:~/.tdc/service.key\" from a file the repository does not hold.",
                    line, column);
            }
        }
    }

    private static bool IsPositiveSeconds(string raw) =>
        double.TryParse(raw.Trim(), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double v) && v > 0;

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

    /// <summary>
    /// <c>fit="low..high"</c> — where a drawing read from a FILE lands on the value axis.
    /// </summary>
    /// <remarks>
    /// A file carries a shape and nothing else, so its own lowest and highest point are the only
    /// two things that can be measured; <c>fit=</c> says what they become. Typed points already
    /// carry a board, so the two spellings cannot both be right about the same drawing.
    /// </remarks>
    private void CheckFit(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        string? value = attrs.GetValueOrDefault("fit");
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        string raw = value.Trim();
        (int line, int column) = At(gen, "fit");

        string[] drawn = new[] { "points", "upper", "lower" }
            .Where(name => !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault(name)))
            .Select(name => name + "=")
            .ToArray();
        if (drawn.Length > 0)
        {
            Error(
                "TDC300",
                $"fit= is not read beside {string.Join(" and ", drawn)} — those points already "
                + "carry a board",
                "A typed point is a percentage of the 0..100 board, so 80 already means 80% of "
                + "y_range and there is nothing left for fit= to place. fit= is for a drawing "
                + "read from src=, whose numbers are in some other tool's units. Drop one of the "
                + "two.",
                line, column);
            return;
        }

        string[] parts = raw.Split("..");
        if (parts.Length != 2
            || !double.TryParse(parts[0].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double low)
            || !double.TryParse(parts[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double high)
            || !double.IsFinite(low) || !double.IsFinite(high))
        {
            Error(
                "TDC300",
                $"fit=\"{raw}\" is not a band",
                "Write fit=\"low..high\" with two numbers — the values the drawing's lowest and "
                + "highest point become. Omit it entirely to have the drawing fill y_range.",
                line, column);
            return;
        }

        if (low > high)
        {
            Error(
                "TDC300",
                $"fit=\"{raw}\" counts down — the low bound is above the high one",
                "Write the smaller number first. Turning the drawing upside down is a different "
                + "request, and it is not what this attribute does.",
                line, column);
        }
    }

    private void CheckSource(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type is not ("file" or "pattern"))
        {
            return;
        }

        if (type == "pattern")
        {
            CheckFit(gen, attrs);
        }

        // `y_range=` is the value axis a drawing is brought into, and a drawing has no scale of
        // its own. The generator refuses without it, but a refusal at run time is not enough: a
        // config that passes `check` and then dies is the exact defect this validator closes.
        if (type == "pattern" && string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("y_range")))
        {
            Error(
                "TDC293",
                "<gen type=\"pattern\"> needs y_range — a drawing has no scale of its own",
                "y_range=\"min..max\" is the value axis the picture is brought into: its floor "
                + "is the minimum, its top is the maximum, and nothing leaves the range. Without "
                + "it the drawing would be measured against its own ink, so a flat line halfway "
                + "up would come out at the floor. Write y_range=\"0..100\" for a percentage "
                + "canvas, or the units you actually mean.",
                Line(gen), Column(gen));
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

        // `mode=`, `interp=`, `spread=` and `decimals=` — the four drawing attributes whose
        // value is a fixed word or a number. They used to be read only by the generator, so
        // `check` called mode="banana" valid and the run then refused it with a bare sentence
        // and no code. The GENERATOR's own readers are called here rather than their rules
        // repeated: a second copy is a second thing to keep in step, and drifting apart is
        // exactly the failure being closed.
        if (type == "pattern")
        {
            foreach (string name in new[] { "points", "upper", "lower", "mode", "interp", "spread", "decimals" })
            {
                if (!attrs.ContainsKey(name))
                {
                    continue;
                }

                try
                {
                    switch (name)
                    {
                        // The three that carry a DRAWING, read by the same code the run
                        // uses: a `;` that becomes one curve, and points with no width.
                        case "points":
                        case "upper":
                        case "lower":
                            Pattern.Curve.Of(Pattern.PatternGen.Points(attrs[name]), null, 0, null, Pattern.Interp.Linear);
                            break;
                        case "mode": Pattern.PatternGen.Mode(attrs[name]); break;
                        case "interp": Pattern.PatternGen.InterpOf(attrs[name]); break;
                        case "spread": Pattern.PatternGen.Spread(attrs); break;
                        default: Pattern.PatternGen.DecimalsOf(attrs); break;
                    }
                }
                catch (Exception e) when (e is ArgumentException or FormatException)
                {
                    (int line, int column) = At(gen, name);
                    Error(
                        "TDC285", e.Message,
                        "Every drawing attribute is checked before the run, so `check` and the "
                        + "run agree.", line, column);
                }
            }
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
            // A pack's parameters are open-ended, so the "is this a known name" half cannot run
            // here — but which type reads order= does not depend on the pack, and that half is
            // why order= and parent= sat on a template generator doing nothing.
            foreach (string name in attrs.Keys)
            {
                if (name == "parent")
                {
                    Ignored(gen, name, MisplacedGenParent);
                }
                else if (ReservedTemplateAttrs.Contains(name)
                    && AttributeOwners.TryGetValue(name, out IReadOnlySet<string>? owns)
                    && !owns.Contains("template"))
                {
                    // A name the pack may claim is the pack's business, and the pack-parameter
                    // check judges it with the registry in hand. The line is drawn by what the
                    // ENGINE reads before the pack runs; everything else is handed to the pack.
                    string owned = string.Join(
                        ", ",
                        owns.OrderBy(o => o, StringComparer.Ordinal).Select(o => $"type=\"{o}\""));
                    Ignored(
                        gen, name,
                        $"\"{name}\" belongs to {owned} — a type=\"template\" generator ignores it.");
                }
            }
            return;
        }

        bool hasDistribution =
            !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("distribution"));
        string order = attrs.GetValueOrDefault("order", string.Empty).Trim();

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

            // cycle= says what happens when a WALK runs out. Without a walk there is nothing
            // to run out of: the generator draws, and a draw never ends.
            if (name == "cycle" && order != "sequential")
            {
                Ignored(
                    gen, name,
                    "cycle= says what happens when order=\"sequential\" reaches the end of its "
                    + "source. Without order=\"sequential\" the generator draws, and a draw never "
                    + "runs out.");
                continue;
            }

            // A wrapper the type never puts its value through. Separate from the ownership
            // table because the name IS a general wrapper — it works on almost every type,
            // and these two resolve before the layer that applies it.
            if (type is not null
                && WrappersNotRead.TryGetValue(type, out IReadOnlySet<string>? unread)
                && unread.Contains(name))
            {
                Ignored(
                    gen, name,
                    $"a type=\"{type}\" generator publishes its number as it stands — the "
                    + "formatting layer does not run for it. Apply it where the value is printed "
                    + "instead: ${{Total|mask:x}}, ${{Total|upper}}.");
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

        IReadOnlyDictionary<string, int> widths = _packs.ParameterWidths(path, _locale);

        foreach (KeyValuePair<string, string> attr in attrs)
        {
            // parent, count and flag may sit on a <gen> and are each reported by their own
            // rule; a pack-parameter check must not read them as typos.
            if (PackWrapperAttrs.Contains(attr.Key) || NotAPackParam.Contains(attr.Key))
            {
                continue;
            }

            if (declared.Contains(attr.Key))
            {
                // A parameter the pack DOES accept, pinned to a value of the wrong width.
                //
                // The packs that carry a check digit compute it over a fixed layout, so a
                // wrong-width value does not shift the layout — it breaks it. Measured on
                // usa.finance.aba_routing, whose own prefix is 2 characters: prefix="12345"
                // aborted the run with "<at>: index 8 is out of range", naming no file, line
                // or code, and tail="678" said nothing at all and wrote a six-digit number
                // that is not a routing number. check passed on both. Only reported where the
                // width is a FACT read off the pack's own body.
                if (widths.TryGetValue(attr.Key, out int want)
                    && attr.Value.Length != want)
                {
                    (int wl, int wc) = At(gen, attr.Key);
                    Error(
                        "TDC276",
                        $"\"{attr.Key}\" is pinned to {attr.Value.Length} characters, and "
                        + $"\"{path}\" builds its value around a {attr.Key}= of exactly {want}",
                        "A pinned parameter replaces the pack's own value, and this pack has a "
                        + "fixed layout — a check digit is computed over the whole of it. Use a "
                        + $"{attr.Key}= of {want} characters, or drop it and let the pack draw "
                        + "its own.",
                        wl,
                        wc);
                }

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
        Error("TDC015", $"<gen> has no \"{name}\" attribute", why, line, column);
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

            // A parameter written as an EXPRESSION is resolved per row against the other columns,
            // so its VALUE is not knowable here. Stand a plausible number in its place and check
            // everything else — the distribution's name, the parameters it requires, the
            // attributes it refuses — so writing `lambda="Traffic * 0.5"` does not buy silence
            // about the rest of the generator.
            //
            // `1` is the stand-in because every parameter of every distribution accepts it: the
            // positive ones are happy, the unbounded ones do not care. A parameter that resolves
            // to something the distribution rejects — a negative `sd` — is caught by the run,
            // where the value finally exists, with this same message.
            IReadOnlyList<string> dynamic = Stats.DistParams.ExpressionParams(attrs);
            foreach (string param in dynamic)
            {
                CheckParamNames(gen, param, attrs.GetValueOrDefault(param) ?? "");
            }

            var forCheck = new Dictionary<string, string>(attrs, StringComparer.Ordinal);
            foreach (string param in dynamic)
            {
                forCheck[param] = "1";
            }

            // The distribution's own parameters: a shape nobody can draw from is an error before the
            // run, not a surprise on the first row.
            try
            {
                Stats.Distribution.Parse(forCheck);
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

        // A blank value= is a written attribute, not an absent one. Skipping it here let the
        // generator fall back to its default range and invent numbers for a config that had
        // named none: value="" produced 4 2 8 while the reference refused the same file.
        string? value = attrs.GetValueOrDefault("value");
        if (value is not null && Checks.NumberRangeProblem(value) is not null)
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

        bool hasInclude = !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("include"));
        bool hasExclude = !string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("exclude"));
        bool hasModifier = hasInclude || hasExclude;

        // include/exclude turn the draw into a pick from an explicit set of WHOLE numbers, so a
        // fractional value can never be in it: decimals described a draw that is no longer
        // happening. The engine dropped it and emitted integers, and a config asking for 7.71
        // got 8 without a word.
        string decimalsRaw = attrs.GetValueOrDefault("decimals", string.Empty).Trim();
        if (hasModifier && decimalsRaw.Length > 0 && decimalsRaw != "0")
        {
            string which = hasInclude && hasExclude ? "include/exclude"
                : hasInclude ? "include" : "exclude";
            (int decLine, int decColumn) = At(gen, "decimals");
            Error(
                "TDC255",
                $"decimals=\"{decimalsRaw}\" cannot be combined with {which}",
                "include= and exclude= build a set of whole numbers and pick one uniformly, so "
                + "there are no fractional values to round. Drop decimals=, or bound the range "
                + "with value= instead of a set.",
                decLine, decColumn);
        }

        if (hasModifier && string.IsNullOrWhiteSpace(value))
        {
            Error(
                "TDC087",
                "<gen type=\"number\"> include/exclude require a numeric range in \"value\"",
                "Add a range first, e.g. value=\"0..9\" exclude=\"3\".", Line(gen), Column(gen));
        }

        this.CheckDecimalsReachSomething(gen, attrs);
        this.CheckFirstZeroIsReachable(gen, attrs);
    }

    /// <summary>
    /// <c>decimals=</c> only describes a draw that HAS a fractional part.
    /// </summary>
    /// <remarks>
    /// Two shapes reached the generator and were dropped there:
    /// <c>&lt;gen type="number" length="4" decimals="2"/&gt;</c> emitted 4566, and
    /// <c>&lt;gen type="number" value="1..9" length="3" decimals="2"/&gt;</c> emitted 3.78. The
    /// first has no range, so the generator produces a digit STRING — an identifier — and
    /// there is nothing to round. The second has one, so decimals wins and length is discarded
    /// instead: a fractional value has no integer width to pad to.
    /// </remarks>
    private void CheckDecimalsReachSomething(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        string decimals = (attrs.GetValueOrDefault("decimals") ?? "").Trim();
        if (decimals.Length == 0 || decimals == "0")
        {
            return;
        }

        string range = (attrs.GetValueOrDefault("value") ?? "").Trim();
        if (range.Length == 0)
        {
            (int line, int column) = At(gen, "decimals");
            Error(
                "TDC277",
                $"decimals=\"{decimals}\" has nothing to round — without value= this generator "
                + "produces a digit string",
                "Give it a range to draw from: value=\"0..100\" decimals=\"2\". A number with "
                + "only length= is an identifier of that many digits, and an identifier has no "
                + "decimal places.",
                line, column);
            return;
        }

        string length = (attrs.GetValueOrDefault("length") ?? "").Trim();
        if (length.Length > 0)
        {
            (int line, int column) = At(gen, "length");
            Error(
                "TDC278",
                $"length=\"{length}\" is not read beside decimals=\"{decimals}\" — a fractional "
                + "value has no integer width to pad",
                "Keep one of them: decimals= for a fractional value over the range, or length= "
                + "for a whole number padded to a fixed width.",
                line, column);
        }
    }

    /// <summary>
    /// <c>first_zero="false"</c> the range can never satisfy.
    /// </summary>
    /// <remarks>
    /// A drawn value is padded to <c>length</c> with zeros, so it avoids a leading one only by
    /// being wide enough on its own. When the range's largest value has fewer digits than the
    /// width, EVERY draw needs padding — and the generator answered by redrawing a hundred
    /// times and emitting the forbidden shape anyway.
    /// </remarks>
    private void CheckFirstZeroIsReachable(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if ((attrs.GetValueOrDefault("first_zero") ?? "").Trim() != "false")
        {
            return;
        }

        string range = (attrs.GetValueOrDefault("value") ?? "").Trim();
        string length = (attrs.GetValueOrDefault("length") ?? "").Trim();
        if (range.Length == 0 || length.Length == 0)
        {
            return;
        }

        List<int> widths = new();
        long biggest;
        try
        {
            foreach (var choice in NumberGen.ParseLengthChoices(length))
            {
                for (int w = choice.Min; w <= choice.Max; w++)
                {
                    widths.Add(w);
                }
            }

            biggest = NumberGen.ParseRanges(range).Max(r => r.Max);
        }
        catch (Exception)
        {
            return; // a malformed range or length is already reported above
        }

        // A value renders without a leading zero at width W only if it has at least W digits
        // of its own, which needs max >= 10^(W-1).
        List<int> unreachable = widths.Where(w => w > 1 && biggest < Math.Pow(10, w - 1)).ToList();
        if (unreachable.Count == 0)
        {
            return;
        }

        int smallest = unreachable.Min();
        string digits = unreachable.Count == 1 ? $"{unreachable[0]} digits" : $"{smallest} digits";
        long low = (long)Math.Pow(10, smallest - 1);
        long high = (long)Math.Pow(10, smallest) - 1;
        (int fzLine, int fzColumn) = At(gen, "first_zero");
        Error(
            "TDC279",
            $"first_zero=\"false\" cannot be honoured — no value in \"{range}\" reaches {digits}, "
            + "so every draw has to be padded",
            $"The widest value the range offers is {biggest}. Widen the range — "
            + $"value=\"{low}..{high}\" — or drop length=, or allow the zero.",
            fzLine, fzColumn);
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
    /// <summary>`plus=` on a date that is not measured from anything.</summary>
    /// <remarks>
    /// <c>plus=</c> belongs to the offset and nothing else reads it, so a lone
    /// <c>plus="3d"</c> was dropped in silence and the column came out as ordinary drawn dates.
    /// "Shift this column by three days" is the natural misreading of it — and this generator
    /// already refuses <c>step=</c> and <c>weekdays=</c> on a drawn date for exactly that reason.
    /// </remarks>
    private void CheckDatePlusWithoutOf(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (!attrs.ContainsKey("plus"))
        {
            return;
        }

        (int line, int column) = At(gen, "plus");
        Error(
            "TDC264",
            "<gen type=\"date\" plus=\"…\"> does not say what it is measured from",
            "Add of=\"Name\" to measure from another date column — plus= is how far from it, "
            + "and on its own there is nothing to be far from. To move every drawn date, move "
            + "the range.",
            line, column);
    }

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
            // Two different reasons wear one code, and they must not wear one sentence.
            //
            // A whole number of weeks really does land on the same weekday every time, so the
            // filter matches every row or none. Measured on the STEP rather than on its spelling,
            // so `14d` is caught as surely as `2w`.
            //
            // A CALENDAR step does not: 15 January 2026 is a Thursday, 15 February a Sunday,
            // 15 March a Sunday, 15 April a Wednesday. The combination is still refused — a month
            // holds a different number of days each time — but for its own reason.
            string written = (attrs.GetValueOrDefault("step") ?? "").Trim();
            bool wholeWeeks = spec.Months == 0;
            Error(
                "TDC250",
                wholeWeeks
                    ? $"weekdays=\"{raw}\" cannot narrow step=\"{written}\" — that step already "
                        + "fixes the weekday"
                    : $"weekdays=\"{raw}\" cannot narrow step=\"{written}\" — a calendar step is "
                        + "not measured in days",
                wholeWeeks
                    ? "A whole number of weeks lands on the same weekday every time, so this "
                        + "would match every row or none. Use a step that is not a multiple of a "
                        + "week, or drop weekdays=."
                    : "A month and a year hold a different number of days each time, so which "
                        + "rows survive the filter follows the calendar rather than anything "
                        + "written here. Use a step measured in days or hours, or drop weekdays=.",
                line, column);
        }
    }

    /// <summary><c>repeat=</c> together with <c>order="sequential"</c>.</summary>
    /// <remarks>
    /// Well defined apart, undefined together — and the engines proved it by disagreeing:
    /// engine 1 gave the row several elements that were all the SAME value and never advanced,
    /// engines 2 and 3 dropped the repeat list and emitted one walking value. <c>check</c> called
    /// that valid, so the author got data that looks plausible and is wrong differently depending
    /// on which engine answered.
    /// </remarks>
    private void CheckSequentialRepeat(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (!attrs.TryGetValue("order", out string? order) || order.Trim() != "sequential")
        {
            return;
        }
        if (!attrs.TryGetValue("repeat", out string? rawRepeat))
        {
            return;
        }
        string repeat = rawRepeat.Trim();
        if (repeat.Length == 0)
        {
            return;
        }

        // Point at `repeat=`: a walked column is what the author asked for and can keep.
        (int line, int column) = At(gen, "repeat");
        Error(
            "TDC254",
            "repeat=\"" + repeat + "\" cannot be combined with order=\"sequential\"",
            "A walked list and a repeating list are two different columns, and together they have "
                + "no one answer — the engines disagree about what they produce. Keep "
                + "order=\"sequential\" for a column that walks its source one value per row, or "
                + "keep repeat= for several drawn values per row.",
            line,
            column);
    }

    /// <summary><c>peak_at=</c> — which row the seasonal wave is highest on.</summary>
    /// <remarks>
    /// Without it the peak sits a quarter period in, which is where a plain sine already peaked —
    /// and for a year of daily rows that is early April, the one season nobody means by "warmer in
    /// summer". It is a ROW, not a shift: 182 of 365 is the first of July, and <c>period</c> is
    /// already counted in rows.
    /// </remarks>
    private void CheckTimeseries(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "timeseries" || !attrs.TryGetValue("peak_at", out string? rawPeak))
        {
            return;
        }

        string raw = rawPeak.Trim();
        (int line, int column) = At(gen, "peak_at");

        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double _))
        {
            Error(
                "TDC252", $"peak_at=\"{raw}\" is not a number",
                "peak_at is the row the seasonal wave peaks on, counted like period= — "
                + "peak_at=\"182\" over period=\"365\" puts the peak at the first of July.",
                line, column);
            return;
        }

        // A wave needs a length before it can have a highest point. Without `period` there is no
        // wave at all, so `peak_at` would be read by nobody.
        string rawPeriod = attrs.GetValueOrDefault("period", string.Empty).Trim();
        if (!double.TryParse(
                rawPeriod, NumberStyles.Float, CultureInfo.InvariantCulture, out double period)
            || period <= 0)
        {
            Error(
                "TDC253",
                $"peak_at=\"{raw}\" has no period= on the same <gen> — there is no wave to "
                + "place a peak on",
                "Add period= (the length of one season, in rows), or remove peak_at=.",
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

        // `of=` makes this an OFFSET rather than a draw: a different set of attributes configures
        // it, and a different set of mistakes is possible. Its own checks REPLACE the ones below
        // rather than joining them — everything here is about how a draw is bounded, so it would
        // be a second complaint about the same attribute, naming a rule that no longer applies.
        if ((attrs.GetValueOrDefault("of") ?? "").Trim().Length != 0)
        {
            CheckDateOffset(gen, attrs);
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

        CheckDatePlusWithoutOf(gen, attrs);
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

        CheckEnvLocaleHasDates(gen, attrs);
        CheckDateCommonAttrs(gen, attrs);
        CheckDateValues(gen, attrs);
        this.CheckOneDateSpelling(gen, attrs);
        this.CheckDateRangeNotReversed(gen, attrs);
    }

    /// <summary>
    /// <c>&lt;env local="af"&gt;</c> with a date the run will render in ENGLISH.
    /// </summary>
    /// <remarks>
    /// The same value is refused outright on <c>&lt;gen type="date" local="af"&gt;</c> (TDC153)
    /// and was silently downgraded here. Refusing it on <c>&lt;env local=&gt;</c> would be wrong —
    /// a locale can be a perfectly good source of NAMES and still ship no month names, and
    /// refusing would forbid the Afrikaans name pack because Afrikaans dates are missing. So this
    /// warns, and only when the format actually reads the locale: <c>YYYY-MM-DD</c> is the same
    /// in every language, while a missing <c>format=</c> is not, because the default <c>L</c> is
    /// a layout the locale chooses. Bracketed text is stripped first — <c>[LL]</c> is a literal.
    /// </remarks>
    private void CheckEnvLocaleHasDates(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        if (string.IsNullOrEmpty(_locale) || Checks.IsKnownDateLocale(_locale))
        {
            return;
        }

        if (attrs.ContainsKey("local"))
        {
            return; // its own local= is TDC153's business
        }

        string? format = attrs.GetValueOrDefault("format");
        if (!string.IsNullOrWhiteSpace(format))
        {
            var outside = new System.Text.StringBuilder();
            bool inside = false;
            foreach (char ch in format)
            {
                if (ch == '[') { inside = true; }
                else if (ch == ']') { inside = false; }
                else if (!inside) { outside.Append(ch); }
            }

            string plain = outside.ToString();
            bool readsLocale = new[] { "MMMM", "MMM", "dddd", "ddd", "L" }
                .Any(t => plain.Contains(t, StringComparison.Ordinal));
            if (!readsLocale)
            {
                return;
            }
        }

        Warn(
            "TDC272",
            $"<env local=\"{_locale}\"> ships no date translations, so this date renders in "
            + "English",
            $"Date locales: {string.Join(", ", DateLocales.Names)}. Use format=\"YYYY-MM-DD\" "
            + "\u2014 or any format without month or weekday names \u2014 to get the same text "
            + "in every language, or accept the English month names.",
            Line(gen), Column(gen));
    }

    /// <summary>
    /// The dates themselves parse.
    /// </summary>
    /// <remarks>
    /// Without this a <c>from="notadate"</c> reached the generator and failed there, which is a
    /// crash at render time instead of a diagnostic at validation time — and the reference reports
    /// it here.
    /// </remarks>
    /// <summary>One spelling of the range, not two.</summary>
    /// <remarks>
    /// <c>value=</c>, the <c>from</c>/<c>to</c> pair and <c>range=</c> are three ways to say the
    /// same thing, and the generator reads them in that order and stops. Writing two put one of
    /// them in the file and did nothing with the other, without a word: <c>value="2020-05-05"
    /// from="1990-01-01" to="1990-12-31"</c> produced 1990-05-11.
    /// </remarks>
    private void CheckOneDateSpelling(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        var spellings = new List<string>();
        if (!string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("value")))
        {
            spellings.Add("value=");
        }

        if (attrs.ContainsKey("from") || attrs.ContainsKey("to"))
        {
            spellings.Add("from=/to=");
        }

        if (attrs.ContainsKey("range"))
        {
            spellings.Add("range=");
        }

        if (spellings.Count < 2)
        {
            return;
        }

        string listed = string.Join(", ", spellings.Take(spellings.Count - 1))
            + " and " + spellings[^1];
        string count = spellings.Count == 2 ? "two spellings" : "three spellings";
        Error(
            "TDC280",
            $"<gen type=\"date\"> carries {listed} — they are {count} of the same range, and "
            + "only the first is read",
            "Keep one: value=\"2020-01-01..2025-12-31\", or from=\"2020-01-01\" to=\"2025-12-31\", "
                + "or range=\"2020-01-01..2025-12-31\". value=\"today\", \"now\" and \"birth\" are "
                + "spellings too, so they cannot carry a from/to either.",
            Line(gen), Column(gen));
    }

    /// <summary>A range whose end is before its start, refused rather than swapped.</summary>
    /// <remarks>
    /// The draw took min and max of the two ends, so <c>from="2020-01-01" to="2010-01-01"</c>
    /// produced perfectly plausible dates from the range the author did NOT write. The date page
    /// already states the rule for <c>plus=</c>: write the smaller bound first, and a typo is
    /// refused rather than quietly swapped.
    /// </remarks>
    private void CheckDateRangeNotReversed(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        var pairs = new List<(string Start, string End, string Where)>
        {
            ((attrs.GetValueOrDefault("from") ?? "").Trim(),
             (attrs.GetValueOrDefault("to") ?? "").Trim(), "to"),
        };
        string raw = (attrs.GetValueOrDefault("range") ?? attrs.GetValueOrDefault("value") ?? "")
            .Trim();
        int dots = raw.IndexOf("..", StringComparison.Ordinal);
        if (dots > 0)
        {
            pairs.Add((raw[..dots], raw[(dots + 2)..],
                attrs.ContainsKey("range") ? "range" : "value"));
        }

        foreach ((string startRaw, string endRaw, string where) in pairs)
        {
            if (startRaw.Length == 0 || endRaw.Length == 0)
            {
                continue;
            }

            DateParse.Parsed start;
            DateParse.Parsed end;
            try
            {
                start = DateParse.DateTime(startRaw);
                end = DateParse.DateTime(endRaw);
            }
            catch (Exception)
            {
                continue; // already reported by the value checks above
            }

            if (Tdcv2.Date.Calendar.ToEpochMillis(start.Value) <= Tdcv2.Date.Calendar.ToEpochMillis(end.Value))
            {
                continue;
            }

            (int line, int column) = At(gen, where);
            Error(
                "TDC281",
                $"the range ends before it starts — \"{endRaw}\" is earlier than \"{startRaw}\"",
                $"Write the smaller bound first: \"{endRaw}\"..\"{startRaw}\". A reversed range "
                + "used to be swapped silently, which meant drawing from a range nobody wrote.",
                line, column);
        }
    }

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
    /// Every column an expression-valued parameter names must be declared ABOVE it.
    /// </summary>
    /// <remarks>
    /// The same rule <c>formula</c>, <c>running</c> and <c>of=</c> follow, and for a sharper
    /// reason than a typo: a FORWARD reference makes the two engines disagree — the streaming
    /// registry answers it and the in-memory one does not — so one config would mean two
    /// datasets. TDC240 is shared with them on purpose; it is the same complaint about the same
    /// thing.
    /// </remarks>
    private void CheckParamNames(
        TDCParser.SelfClosingElementContext gen, string param, string source)
    {
        // The little language itself. The name loop below is about which COLUMNS a parameter
        // reads and says nothing about whether the expression is one the evaluator can run.
        (int pl, int pc) = At(gen, param);
        string kind = param == "expr" ? "expression" : "parameter";
        string article = "aeiou".Contains(char.ToLowerInvariant(param[0])) ? "an" : "a";
        CheckIfExpression(source, pl, pc, $"{param}= {kind}", article);

        Expr.Expr parsed;
        try
        {
            parsed = Expr.Expr.Parse(source);
        }
        catch (Exception)
        {
            return; // Not an expression at all — TDC089 reports it.
        }

        var names = new SortedSet<string>(StringComparer.Ordinal);
        CollectIdentifiers(parsed, names);
        foreach (string name in names)
        {
            if (Checks.IsBuiltin(name) || _declaredOrder.Contains(name, StringComparer.Ordinal))
            {
                continue;
            }

            (int line, int column) = At(gen, param);
            Error(
                "TDC240", $"\"{name}\" in {param}= is not a sequence declared above this one",
                _declaredOrder.Count == 0
                    ? "A parameter reads a column that already exists, so the column it reads "
                      + "has to come first."
                    : "Declared above: " + string.Join(", ", _declaredOrder) + ".",
                line, column);
        }
    }

    /// <summary>Every bare name an expression mentions, the root of a dotted path included.</summary>
    /// <remarks>
    /// A distribution parameter is a NUMBER, so every identifier in one has to be a column —
    /// unlike <c>if=</c>, where an unknown name is a legitimate bare word. That is what makes
    /// checking them all correct here and wrong there.
    /// </remarks>
    private static void CollectIdentifiers(Expr.Expr node, ISet<string> found)
    {
        switch (node)
        {
            case Expr.Expr.Name n:
                found.Add(n.Value);
                break;
            case Expr.Expr.Member m:
                found.Add(m.Dotted.Split('.')[0]);
                break;
            case Expr.Expr.Unary u:
                CollectIdentifiers(u.Operand, found);
                break;
            case Expr.Expr.Binary b:
                CollectIdentifiers(b.Left, found);
                CollectIdentifiers(b.Right, found);
                break;
            case Expr.Expr.Conditional t:
                CollectIdentifiers(t.Test, found);
                CollectIdentifiers(t.Consequent, found);
                CollectIdentifiers(t.Alternate, found);
                break;
            case Expr.Expr.Call c:
                foreach (Expr.Expr arg in c.Args)
                {
                    CollectIdentifiers(arg, found);
                }

                break;
            case Expr.Expr.Arr a:
                foreach (Expr.Expr item in a.Items)
                {
                    CollectIdentifiers(item, found);
                }

                break;
            default:
                break;
        }
    }

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

    /// <summary>
    /// Everything a statistic cannot do without.
    /// </summary>
    /// <remarks>
    /// The same two things a running total needs, for the same two reasons: it has to say WHAT to
    /// summarise and WHICH statistic, and the column it reads has to be declared ABOVE it. The
    /// declaration-order complaint is TDC240, shared with <c>running</c> on purpose — the same
    /// rule with the same fix.
    /// </remarks>
    /// <summary>
    /// <c>${{Name}}</c> written into an attribute that does not read it.
    /// </summary>
    /// <remarks>
    /// Interpolation reaches exactly two places: the TEXT inside <c>&lt;data&gt;</c>, and
    /// <c>&lt;gen type="template" value=&gt;</c>. Everywhere else the braces are eight literal
    /// characters — and the generator that receives them complains about whatever it happens to
    /// be parsing: an invalid number range, an invalid date, a bad quantifier, an unknown
    /// alphabet — while <c>type="text"</c> said nothing at all and emitted the braces. Five
    /// messages and one silence for one mistake, none of them naming it.
    /// </remarks>
    private bool CheckAttrInterpolation(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        bool found = false;
        foreach (KeyValuePair<string, string> entry in attrs)
        {
            if (entry.Value is null || !entry.Value.Contains("${{", StringComparison.Ordinal))
            {
                continue;
            }

            // The one place it works: a pack path finished by another column.
            if (entry.Key == "value" && type == "template")
            {
                continue;
            }

            (int line, int column) = At(gen, entry.Key);
            Error(
                "TDC263",
                $"${{{{…}}}} in {entry.Key}= is not expanded — the braces are literal text here",
                "Interpolation reaches the text inside <data> and <gen type=\"template\" value=>, "
                + "and nowhere else. To make one column depend on another, read it in an if= "
                + "condition, or build the value in a <compute> sequence.",
                line, column);
            found = true;
        }

        return found;
    }

    private void CheckStat(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        string? type)
    {
        if (type != "stat")
        {
            return;
        }

        string of = (attrs.GetValueOrDefault("of") ?? "").Trim();
        if (of.Length == 0)
        {
            Error(
                "TDC262", "<gen type=\"stat\"> does not say what to summarise",
                "Name the column it reads: of=\"Price\". A statistic reads another sequence — "
                + "it draws nothing of its own.",
                Line(gen), Column(gen));
        }

        string rawOp = (attrs.GetValueOrDefault("op") ?? "").Trim();
        if (rawOp.Length == 0)
        {
            Error(
                "TDC262", "<gen type=\"stat\"> does not say which statistic",
                "Add op=\"…\" — one of: " + string.Join(", ", Stat.Ops) + ".",
                Line(gen), Column(gen));
        }
        else
        {
            try
            {
                Stat.ParseOp(attrs);
            }
            catch (StatException e)
            {
                (int line, int column) = At(gen, "op");
                Error(
                    "TDC262", e.Message, "One of: " + string.Join(", ", Stat.Ops) + ".",
                    line, column);
            }
        }

        try
        {
            Stat.ParseDecimals(attrs);
        }
        catch (StatException e)
        {
            (int line, int column) = At(gen, "decimals");
            Error(
                "TDC262", e.Message,
                "decimals= rounds the answer. A mean, a median and a standard deviation are "
                + "ratios and print in full without it; sum, min and max keep the exact scale of "
                + "the column.",
                line, column);
        }

        if (of.Length != 0 && !_declaredOrder.Contains(of, StringComparer.Ordinal))
        {
            (int line, int column) = At(gen, "of");
            Error(
                "TDC240", $"of=\"{of}\" is not a sequence declared above this one",
                _declaredOrder.Count == 0
                    ? "A statistic is built from a column that already exists, so the column it "
                      + "reads has to come first."
                    : "Declared above: " + string.Join(", ", _declaredOrder) + ".",
                line, column);
        }
    }

    /// <summary>Everything a date offset needs said, and nothing that contradicts it.</summary>
    /// <remarks>
    /// <c>of=</c> is what turns a date generator from a DRAW into an OFFSET, and the two are
    /// configured by different attributes entirely. That makes the mistakes here silent ones by
    /// nature: a <c>from=</c> written beside an <c>of=</c> looks like it bounds the result and does
    /// nothing at all, because the result is wherever the source plus the offset lands.
    /// <para>
    /// The declaration-order complaint is TDC240, shared with <c>running</c> and <c>stat</c> — the
    /// same rule with the same fix.
    /// </para>
    /// </remarks>
    private void CheckDateOffset(
        TDCParser.SelfClosingElementContext gen, IReadOnlyDictionary<string, string> attrs)
    {
        string of = (attrs.GetValueOrDefault("of") ?? "").Trim();
        string plus = (attrs.GetValueOrDefault("plus") ?? "").Trim();
        if (plus.Length == 0)
        {
            Error(
                "TDC264", $"<gen type=\"date\" of=\"{of}\"> does not say how far from it",
                $"Add plus=\"…\" — {DateStep.OffsetSyntax}. A range is drawn per row, so "
                + "plus=\"3..10d\" is the length of the stay; a single value is the same distance "
                + "on every row.",
                Line(gen), Column(gen));
        }
        else
        {
            DateStep.OffsetResult parsed = DateStep.ParseOffset(plus);
            if (!parsed.Ok)
            {
                (int line, int column) = At(gen, "plus");
                bool order = parsed.Why == DateStep.OffsetReason.Order;
                Error(
                    "TDC264",
                    order
                        ? $"plus=\"{plus}\" counts down, not up — the low bound is above the high one"
                        : $"plus=\"{plus}\" is not an offset",
                    order
                        ? "Write the smaller number first. To measure BACKWARDS, make both "
                          + "negative: plus=\"-10..-3d\"."
                        : $"One of: {DateStep.OffsetSyntax}. A bare number means days.",
                    line, column);
            }
        }

        // Attributes that place a date generator's OWN draw, and so say nothing once `of=` has
        // placed it relative to another column. Listed by name because ignoring them is exactly
        // the failure this exists to prevent.
        foreach (string name in new[]
                 { "value", "from", "to", "range", "oldest", "youngest", "order", "step" })
        {
            if (!attrs.ContainsKey(name))
            {
                continue;
            }

            (int line, int column) = At(gen, name);
            Error(
                "TDC264",
                $"{name}= is not read when the date is measured from of=\"{of}\"",
                $"An offset lands wherever {of} plus the offset lands — {name}= would have to "
                + "contradict that to mean anything. Drop it, or drop of= and bound the draw "
                + "itself.",
                line, column);
        }

        // A repeat= source is a LIST in one cell, and an offset measures from a DATE. The run said
        // so in the worst possible words — it quoted the joined text and blamed the format, sending
        // the reader to look for a format= mistake that was never there. The cause is the
        // repetition, so name it.
        if (of.Length != 0 && _repeatingNames.Contains(of))
        {
            (int line, int column) = At(gen, "of");
            Error(
                "TDC240",
                $"of=\"{of}\" repeats, so each cell holds a LIST of dates rather than one date",
                "An offset measures from a single date. Drop repeat= on that column, or measure "
                + "from one that does not repeat.",
                line, column);
        }

        if (of.Length != 0 && !_declaredOrder.Contains(of, StringComparer.Ordinal))
        {
            (int line, int column) = At(gen, "of");
            Error(
                "TDC240", $"of=\"{of}\" is not a sequence declared above this one",
                _declaredOrder.Count == 0
                    ? "A date is measured from a column that already exists, so the column it "
                      + "reads has to come first."
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
        CheckDistinct(gen, attrs, repeats, type);

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

    /// <summary><c>distinct="true"</c> — the row's values are drawn without replacement.</summary>
    /// <remarks>
    /// Four refusals, and each one is a proof rather than a guess. They exist because the
    /// alternative in every case is a config that says something and silently gets something
    /// else.
    /// </remarks>
    private void CheckDistinct(
        TDCParser.SelfClosingElementContext gen,
        IReadOnlyDictionary<string, string> attrs,
        bool repeats,
        string? type)
    {
        if (!attrs.TryGetValue("distinct", out string? raw))
        {
            return;
        }

        string word = raw.Trim();
        if (word != "true" && word != "false")
        {
            (int line, int column) = At(gen, "distinct");
            Error(
                "TDC289", $"\"distinct\" takes true or false, not \"{word}\"",
                "distinct=\"true\" draws a repeat list without replacement. Omit it, or write "
                + "distinct=\"false\".",
                line, column);
            return;
        }

        if (word == "false")
        {
            return;
        }

        // One value cannot repeat itself, so the attribute would be read and then do nothing —
        // the accepted-and-ignored failure this project keeps closing.
        if (!repeats)
        {
            (int line, int column) = At(gen, "distinct");
            Error(
                "TDC290", "\"distinct\" has no effect without \"repeat\"",
                "distinct= stops one cell holding the same value twice, so there has to be a "
                + "list. Add repeat=\"N\" or repeat=\"A..B\", or drop distinct=.",
                line, column);
            return;
        }

        // `percent` is an EXACT quota over the whole run; `distinct` is a guarantee inside one
        // row. Holding both would cost either streaming or the randomness of the sample, so the
        // pair is refused.
        if (attrs.ContainsKey("percent"))
        {
            (int line, int column) = At(gen, "percent");
            Error(
                "TDC291", "\"percent\" and \"distinct\" cannot both be on one <gen>",
                "percent= promises exact proportions across the whole run; distinct= trades that "
                + "promise away for a guarantee inside each row, so the two cannot both hold. "
                + "Drop one — or put the proportions on a <mix> or <switch> outside, with "
                + "repeat= on the <gen> inside.",
                line, column);
        }

        // The pool is only knowable up front for the types that carry it in the config. Where it
        // is not — a pack file, a regex — the same refusal fires at run time.
        int? pool = Checks.DistinctPoolSize(type, attrs);
        if (pool is null)
        {
            return;
        }

        int longest;
        try
        {
            longest = Repeat.Parse(attrs)!.Value.Max;
        }
        catch (ArgumentException)
        {
            return; // A malformed repeat= is already reported as TDC195.
        }

        if (longest > pool.Value)
        {
            (int line, int column) = At(gen, "repeat");
            Error(
                "TDC292",
                $"\"repeat\" asks for up to {longest} different values, but the list holds only "
                + $"{pool.Value}",
                $"With distinct=\"true\" a value cannot be used twice in one cell, so {longest} "
                + "of them cannot be found. Lower repeat=, or widen value=.",
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
                    "TDC015", $"<{tag}> has no \"{attr.Key}\" attribute",
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
    /// <c>if=</c> on a <c>&lt;gen&gt;</c> inside a <c>&lt;case&gt;</c> — accepted by the grammar,
    /// read by nothing.
    /// </summary>
    /// <remarks>
    /// A case body is several parts JOINED into one value, so a condition on one part has no
    /// answer to give: if it were false, the part would have to become something, and there is
    /// no honest candidate. The branch already carries its own condition. It used to be accepted
    /// and ignored, so the value appeared on EVERY row.
    /// </remarks>
    private void CheckCaseGenIf(string? condition, (int Line, int Column) at)
    {
        if (condition is null)
        {
            return;
        }

        Error(
            "TDC269",
            "if= is not read on a <gen> inside a <case>: a case body is several parts joined, "
            + "so a condition on one part has no value to fall back to",
            "Put the condition on the branch \u2014 <case if=\"\u2026\"> \u2014 or move the "
            + "<gen> into a <sequence> of its own, where a false condition falls through to the "
            + "next <gen>.",
            at.Line, at.Column);
    }

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
                CheckCaseGenIf(
                    Attributes(self.attr()).GetValueOrDefault("if"), At(self, "if"));
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
                CheckCaseGenIf(
                    Attributes(open.attr()).GetValueOrDefault("if"), At(open, "if"));
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
        string? lineCondition = lineAttrs.GetValueOrDefault("if");
        if (lineCondition is not null)
        {
            (int l, int c) = At(line.attr(), "if", Line(line), Column(line));
            CheckIfExpression(lineCondition, l, c);
            this.DeferExpression(lineCondition, l, c, walksAList);
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
                // The same rule one level up: a conditional <line> holding a typed column. The
                // column is collected once per card either way, so the condition is dropped.
                string lineColumn =
                    (Attributes(body.attr()).GetValueOrDefault("name") ?? string.Empty).Trim();
                if (lineCondition is not null && lineColumn.Length > 0)
                {
                    (int lw, int cw) = At(line, "if");
                    Error(
                        "TDC209",
                        $"<line if=\"\u2026\"> holds the typed column <data name=\"{lineColumn}\">, "
                            + "so the condition cannot be honoured",
                        "A column has one cell per card, collected whether or not the line was "
                            + "rendered \u2014 the condition would be dropped and the typed file "
                            + "would disagree with the text one. Put the condition on the sequence "
                            + "instead (<gen if=\u2026>) and declare the column nullable: an empty "
                            + "cell in a nullable column is a NULL.",
                        lw, cw);
                    lineCondition = null;
                }

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

                    // A named <data> declares a typed output COLUMN, and a column has one cell per
                    // card — the columnar writer collects it whether or not the line was rendered,
                    // so the condition was dropped and the typed file disagreed with the text one.
                    string conditionalColumn =
                        (Attributes(body.attr()).GetValueOrDefault("name") ?? string.Empty).Trim();
                    if (conditionalColumn.Length > 0)
                    {
                        Error(
                            "TDC209",
                            $"<data name=\"{conditionalColumn}\"> declares a typed column, so its "
                                + "if= cannot be honoured",
                            "A column has one cell per card, collected whether or not the line was "
                                + "rendered \u2014 the condition would be dropped and the typed "
                                + "file would disagree with the text one. Put the condition on the "
                                + "sequence instead (<gen if=\u2026>) and declare the column "
                                + "nullable: an empty cell in a nullable column is a NULL.",
                            l, c);
                    }

                    CheckIfExpression(condition, l, c);
                    this.DeferExpression(condition, l, c, walksAList);
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
                string? arg = colon < 0 ? null : filter[(colon + 1)..];

                // A mask with no pattern has nothing to keep, and the engine answered that
                // literally: it returned the empty string and the column came out blank. Every
                // other bare filter is a whole transform on its own, so this one reads like them
                // and is not.
                if (kind == "mask" && string.IsNullOrWhiteSpace(arg))
                {
                    Error(
                        "TDC256",
                        "the \"mask\" filter needs a pattern — ${{X|mask}} empties the column",
                        "Write the pattern after a colon: ${{X|mask:xxx-xx}}. `x` keeps a "
                        + "character, `w` keeps a whole word, `*` hides one — see the masks guide.",
                        line, column);
                    continue;
                }

                // The same parse the mask= attribute gets. Written as a filter it reached the
                // renderer unchecked.
                if (kind == "mask")
                {
                    try
                    {
                        Format.Mask.Check(arg!);
                    }
                    catch (Exception e)
                    {
                        Error(
                            "TDC199", e.Message,
                            "Indices are 0-based; ranges use \"..\", e.g. mask:x[0..3] or "
                            + "mask:w[-1], w[0].",
                            line, column);
                    }

                    continue;
                }

                if (kind.Length > 0 && !Checks.IsKnownFilter(kind))
                {
                    Error(
                        "TDC192", $"unknown interpolation filter \"{kind}\"",
                        "Supported: " + string.Join(", ", Transforms.FilterNames) + ".",
                        line, column);
                    continue;
                }

                // The name is known. Now the part after the colon, which reached the renderer
                // unread until TDC273/TDC274/TDC275.
                CheckFilterArg(kind, arg, line, column);
            }
        }
    }

    /// <summary>Filters whose whole job is the transform; an argument reaches nothing.</summary>
    private static readonly string[] NoArgumentFilters =
        new[] { "trim", "sql", "upper", "lower", "capitalize", "title" };

    /// <summary><c>-3</c>, <c>0</c>, <c>12</c> — nothing else.</summary>
    private static long? WholeNumber(string text)
    {
        string t = text.Trim();
        string body = t.StartsWith("-", StringComparison.Ordinal) ? t.Substring(1) : t;
        if (body.Length == 0)
        {
            return null;
        }

        foreach (char ch in body)
        {
            if (ch < '0' || ch > '9')
            {
                return null;
            }
        }

        return long.TryParse(t, out long value) ? value : null;
    }

    /// <summary>The ARGUMENT of an interpolation filter — the part after the colon.</summary>
    /// <remarks>
    /// The filter NAME has been checked since TDC192, and a mask pattern since TDC199/TDC256.
    /// The argument of every other filter reached the renderer unread, and the renderer is
    /// lenient by design: <c>ApplyGroup</c> returns the value untouched when the size is not a
    /// usable number, <c>ApplyCompact</c> when the base is outside 2..36. That leniency is right
    /// at render time — one bad row must not abort a million-row run — but it means the config
    /// says one thing and the output does another, with nothing said anywhere.
    /// <para>
    /// Not refused, deliberately: <c>group</c> and <c>compact</c> with no argument (both have a
    /// documented default), <c>csv:;</c> (the delimiter is accepted and ignored on purpose), and
    /// a negative <c>slice</c> index. Only a from/to pair of the SAME sign can be proven empty;
    /// with mixed signs the answer depends on the value's length, and a refusal has to be a
    /// proof.
    /// </para>
    /// </remarks>
    private void CheckFilterArg(string kind, string? arg, int line, int column)
    {
        if (Array.IndexOf(NoArgumentFilters, kind) >= 0)
        {
            if (arg != null)
            {
                Error(
                    "TDC274",
                    $"the \"{kind}\" filter takes no argument — \":{arg}\" is read by nothing",
                    $"Write ${{{{X|{kind}}}}}. Chain filters with more pipes instead: "
                    + $"${{{{X|trim|{kind}}}}}.",
                    line, column);
            }

            return;
        }

        if (kind == "replace" && (arg == null || arg.Length == 0 || arg[0] == ','))
        {
            Error(
                "TDC275",
                "the \"replace\" filter needs something to look for — ${{X|replace}} changes "
                + "nothing",
                "Write both parts: ${{X|replace:from,to}}. Leave the second empty to delete: "
                + "${{X|replace:-,}}.",
                line, column);
            return;
        }

        if (kind == "slice")
        {
            if (string.IsNullOrWhiteSpace(arg))
            {
                Error(
                    "TDC273",
                    "the \"slice\" filter needs a start index — ${{X|slice}} keeps the whole "
                    + "value",
                    "Write ${{X|slice:0,4}} for the first four characters, or ${{X|slice:-3}} "
                    + "for the last three. Indices are 0-based and the end is exclusive.",
                    line, column);
                return;
            }

            string[] parts = arg!.Split(',');
            long? start = WholeNumber(parts[0]);
            string? rawTo = parts.Length > 1 ? parts[1] : null;
            bool hasTo = rawTo != null && rawTo.Trim().Length > 0;
            long? end = hasTo ? WholeNumber(rawTo!) : null;
            if (start == null || (hasTo && end == null))
            {
                Error(
                    "TDC273",
                    $"\"slice:{arg}\" is not a pair of indices — the value comes out unsliced",
                    "Indices are whole numbers, 0-based, end exclusive: ${{X|slice:0,4}}. A "
                    + "negative index counts from the end: ${{X|slice:-3}}.",
                    line, column);
                return;
            }

            // Same sign, so the ORDER is decidable without knowing the value's length.
            if (end != null && (start >= 0) == (end >= 0) && start > end)
            {
                Error(
                    "TDC273",
                    $"\"slice:{arg}\" ends before it starts — the column comes out empty",
                    $"Swap them: ${{{{X|slice:{end},{start}}}}}. The end is exclusive, so 0,4 is "
                    + "four characters.",
                    line, column);
            }

            return;
        }

        if (kind == "group" && !string.IsNullOrEmpty(arg))
        {
            long? size = WholeNumber(arg!.Split(',')[0]);
            if (size == null || size <= 0)
            {
                Error(
                    "TDC273",
                    $"\"group:{arg}\" is not a group size — the value comes out ungrouped",
                    "The size is a whole number above zero, counted from the RIGHT: "
                    + "${{X|group:3}} \u2192 1 234 567. A separator follows it: ${{X|group:4,-}}.",
                    line, column);
            }

            return;
        }

        if (kind == "compact" && !string.IsNullOrEmpty(arg))
        {
            long? logBase = WholeNumber(arg!);
            if (logBase == null || logBase < 2 || logBase > 36)
            {
                Error(
                    "TDC273",
                    $"\"compact:{arg}\" is not a base between 2 and 36 — the number comes out "
                    + "unchanged",
                    "The base is a whole number from 2 to 36; 36 is the default and the "
                    + "shortest. Base 1 has no digits to write with, and there are only 36 "
                    + "letters and digits.",
                    line, column);
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

    /// <summary>
    /// <c>&lt;assert that="…" says="…"/&gt;</c> — the two attributes it cannot do without.
    /// </summary>
    /// <remarks>
    /// An assertion is the one construct whose whole worth is that it FAILS, so a half-written one
    /// is worse than none: the config carries a check, the reader believes the run was verified, and
    /// nothing was ever compared. The expression is not re-checked here — <c>that=</c> is the
    /// <c>if=</c> language, so a typo in a column name is reported exactly as it is there.
    /// </remarks>
    private void CheckAsserts(TDCParser.OpenCloseElementContext env)
    {
        foreach (TDCParser.ElementContext child in env.content().element())
        {
            TDCParser.SelfClosingElementContext self = child.selfClosingElement();
            if (self is null || self.name.Text != "assert")
            {
                continue;
            }

            // A self-closing tag is not reached by the walk that checks closed-tag attributes,
            // so an unknown one on <assert> would pass in silence.
            this.CheckClosedTagAttrs("assert", self.attr(), Line(self), Column(self));
            IReadOnlyDictionary<string, string> attrs = Attributes(self.attr());
            string that = (attrs.GetValueOrDefault("that") ?? "").Trim();
            string says = (attrs.GetValueOrDefault("says") ?? "").Trim();
            if (that.Length == 0)
            {
                (int l, int c) = At(self.attr(), "that", Line(self), Column(self));
                this.Error(
                    "TDC265",
                    "<assert> has no condition — that= is required",
                    "Write the property the run must have, in the if= language, over whole-run "
                    + "columns: <assert that=\"Rows == 700\" says=\"…\"/>. The numbers come from "
                    + "<gen type=\"stat\">.",
                    l,
                    c);
                continue;
            }

            if (says.Length == 0)
            {
                (int l, int c) = At(self.attr(), "says", Line(self), Column(self));
                this.Error(
                    "TDC266",
                    $"<assert that=\"{that}\"> has no message — says= is required",
                    "When this fails, says= is what the reader is told. An expression alone leaves "
                    + "them to work out what it was for, months later, in a CI log.",
                    l,
                    c);
            }

            (int tl, int tc) = At(self.attr(), "that", Line(self), Column(self));
            this.CheckIfExpression(that, tl, tc);
            this.DeferExpression(that, tl, tc, false);
        }
    }

    /// <summary>The little language, wherever it is written.</summary>
    /// <remarks>
    /// <c>if=</c> is the oldest home and its wording is quoted in the docs, so it keeps the
    /// default. <c>expr=</c>, <c>filter=</c> and a distribution parameter reach the same
    /// evaluator and so have to be refused by the same list — until they were wired in here, a
    /// misspelled function passed <c>check</c> and killed the run with a bare
    /// <c>unknown function</c>.
    /// </remarks>
    private void CheckIfExpression(
        string expression, int line, int column,
        string label = "if expression", string article = "an")
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
                    "TDC100", $"invalid {label} \"{Clip(expression)}\": {e.Message}",
                    "Supported: comparison, && || !, and arithmetic.", line, column);
            }
            else
            {
                Error(
                    "TDC100",
                    $"invalid {label} \"{Clip(expression)}\": TDC does not expand XML entities, "
                        + $"so \"{entity.Value.Found}\" is {entity.Value.Found.Length} literal characters, "
                        + $"not \"{entity.Value.Means}\"",
                    $"write {entity.Value.Means} directly — the config is XML-shaped but it is not XML, "
                        + "and the raw character is what the expression parser reads",
                    line, column);
            }
            return;
        }

        CheckExprNode(parsed, line, column, label, article);
    }

    /// <summary>
    /// Every operator in a parsed condition, checked against the ones the engine implements.
    /// </summary>
    /// <remarks>
    /// A parser that is more permissive than the evaluator is a trap: the config is accepted, and
    /// the operator it asked for is quietly not the operator it gets.
    /// </remarks>
    private void CheckExprNode(Expr.Expr node, int line, int column, string label, string article)
    {
        switch (node)
        {
            case Expr.Expr.Arr array:
                // Reached only when nothing marked it as an `in` right-hand side: the Binary
                // arm checks its own right operand before recursing.
                Error(
                    "TDC259", "a [list] is only allowed on the right of \"in\"",
                    "Write Country in [US, CA, MX]. A list has no meaning on its own.",
                    line, column);
                foreach (Expr.Expr item in array.Items)
                {
                    CheckExprNode(item, line, column, label, article);
                }

                return;

            case Expr.Expr.Conditional ternary:
                CheckExprNode(ternary.Test, line, column, label, article);
                CheckExprNode(ternary.Consequent, line, column, label, article);
                CheckExprNode(ternary.Alternate, line, column, label, article);
                return;

            case Expr.Expr.Binary binary:
                if (binary.Op == "in" && binary.Right is Expr.Expr.Arr members)
                {
                    // The one place a list belongs: check its items, not the list.
                    CheckExprNode(binary.Left, line, column, label, article);
                    foreach (Expr.Expr item in members.Items)
                    {
                        CheckExprNode(item, line, column, label, article);
                    }

                    return;
                }

                if (!SupportedBinaryOperators.Contains(binary.Op))
                {
                    Error(
                        "TDC101", $"unsupported operator \"{binary.Op}\" in {article} {label}",
                        "Supported binary operators: "
                        + string.Join(" ", SupportedBinaryOperators)
                        + ". Functions: " + string.Join(", ", ExprFunctionNames)
                        + ". Anything an expression cannot say, a <compute> sequence can — it has "
                        + "integer division, remainders, string surgery and checksums — and the "
                        + "sequence it produces is what if= then compares.",
                        line, column);
                }

                CheckExprNode(binary.Left, line, column, label, article);
                CheckExprNode(binary.Right, line, column, label, article);
                return;

            case Expr.Expr.Call call:
                (string Name, int Low, int High)? spec =
                    ExprFunctions.Cast<(string Name, int Low, int High)?>()
                        .FirstOrDefault(f => f!.Value.Name == call.Callee);
                if (spec is null)
                {
                    bool planned = PlannedExprFunctions.Contains(call.Callee);
                    Error(
                        "TDC257",
                        planned
                            ? $"{call.Callee}() is not available yet in {article} {label}"
                            : $"unknown function \"{call.Callee}\" in {article} {label}",
                        planned
                            ? "TDC computes its own mathematics rather than calling each "
                              + "language's, because the libms disagree in the last bit and a "
                              + $"comparison turns that bit into a different row. So {call.Callee} "
                              + "arrives once it has been built and pinned to its bits in all five "
                              + "implementations, not before. Available today: "
                              + string.Join(", ", ExprFunctionNames) + "."
                            : "Available: " + string.Join(", ", ExprFunctionNames) + ".",
                        line, column);
                    return;
                }

                int given = call.Args.Count;
                if (given < spec.Value.Low || given > spec.Value.High)
                {
                    string wants = spec.Value.High == int.MaxValue
                        ? $"at least {spec.Value.Low}"
                        : spec.Value.Low == spec.Value.High
                            ? $"exactly {spec.Value.Low}"
                            : $"{spec.Value.Low} to {spec.Value.High}";
                    Error(
                        "TDC258",
                        $"{call.Callee}() takes {wants} argument{(spec.Value.High == 1 ? "" : "s")}, "
                        + $"got {given}",
                        string.Empty, line, column);
                }

                if (call.Callee == "at")
                {
                    CheckAtCall(call, line, column);
                }

                foreach (Expr.Expr arg in call.Args)
                {
                    CheckExprNode(arg, line, column, label, article);
                }

                return;

            case Expr.Expr.Computed computed:
                Error(
                    "TDC103", "computed member access is not supported in {article} {label}",
                    "Use plain dotted access like Gender.Male or Person.FirstName.", line, column);
                CheckExprNode(computed.Object, line, column, label, article);
                return;

            case Expr.Expr.Unary unary:
                if (!SupportedUnaryOperators.Contains(unary.Op))
                {
                    Error(
                        "TDC102", $"unsupported unary operator \"{unary.Op}\" in {article} {label}",
                        "Supported unary operators: "
                        + string.Join(" ", SupportedUnaryOperators) + ".",
                        line, column);
                }

                CheckExprNode(unary.Operand, line, column, label, article);
                return;
        }
    }

    /// <summary>
    /// <c>at(subject, index)</c>, checked before the run rather than during it.
    /// </summary>
    /// <remarks>
    /// Both halves are provable from the text alone. A name always resolves to a STRING — a
    /// <c>repeat</c> list arrives joined, never as a list — so <c>at(Items, 1)</c> can only ever
    /// answer with nothing, and that nothing is indistinguishable from a legitimately short row.
    /// An index written out as <c>-1</c>, <c>1.5</c> or <c>"one"</c> is the same kind of mistake
    /// one level down. The engine refuses both at run time as well; this is the earlier,
    /// better-placed half of the same rule, because <c>check</c> points at the character.
    /// </remarks>
    private void CheckAtCall(Expr.Expr.Call call, int line, int column)
    {
        if (call.Args.Count > 0 && ProvablyNotAList(call.Args[0]))
        {
            Error(
                "TDC260", "at() needs a list, and this argument is a single value",
                "A repeat list reaches an expression as its joined text, so cut it first: "
                + "at(split(Items, \",\"), 1).",
                line, column);
        }

        if (call.Args.Count > 1 && BadIndexLiteral(call.Args[1]) is string bad)
        {
            Error(
                "TDC261", $"at() index must be a whole number of zero or more, not {bad}",
                "Elements count from zero: at(list, 0) is the first. Past the end is empty text "
                + "— ask count(list) first.",
                line, column);
        }
    }

    /// <summary>Whether a subexpression can be shown, from the text alone, never to be a list.</summary>
    private static bool ProvablyNotAList(Expr.Expr node) => node switch
    {
        Expr.Expr.Name or Expr.Expr.Member or Expr.Expr.Num or Expr.Expr.Int
            or Expr.Expr.Str or Expr.Expr.Bool or Expr.Expr.Null => true,
        Expr.Expr.Call call => !ListReturningFunctions.Contains(call.Callee),
        _ => false,
    };

    /// <summary>A written-out index that is not one, as it should read back in the message.</summary>
    private static string? BadIndexLiteral(Expr.Expr node) => node switch
    {
        Expr.Expr.Str s => $"\"{s.Value}\"",
        Expr.Expr.Int n => n.Value < 0 ? n.Value.ToString(CultureInfo.InvariantCulture) : null,
        Expr.Expr.Num d => d.Value != Math.Floor(d.Value) || d.Value < 0
            ? LiteralText(d.Value)
            : null,
        // A parser that does not fold a sign into the literal leaves a minus in front of it;
        // this one folds, so the branch is a belt to the braces.
        Expr.Expr.Unary unary when unary.Op == "-" => unary.Operand switch
        {
            Expr.Expr.Int n => "-" + n.Value.ToString(CultureInfo.InvariantCulture),
            Expr.Expr.Num d => "-" + LiteralText(d.Value),
            _ => null,
        },
        _ => null,
    };

    /// <summary>A double as a person wrote it: whole numbers without a point, as JavaScript prints.</summary>
    private static string LiteralText(double value) =>
        value == Math.Floor(value) && !double.IsInfinity(value)
            ? ((long)value).ToString(CultureInfo.InvariantCulture)
            : value.ToString("R", CultureInfo.InvariantCulture);

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
            else if (child.dataElement() is not null)
            {
                // `<data>` is its own node in the grammar, so this walk used to step over it in
                // silence — which is how `<before><data>x</data></before>` came to validate and
                // render nothing at all. Parents that take a `<data>` have it on `allowed` and
                // pass the check below; the fixtures do not, and now say so.
                TDCParser.DataElementContext data = child.dataElement();
                name = "data";
                line = data.Start.Line;
                column = data.Start.Column;
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
    /// <summary>A value that is declared and can never be drawn.</summary>
    /// <remarks>
    /// A warning rather than a refusal: the run is well defined and somebody may want exactly
    /// this. What is not acceptable is saying it in silence.
    /// </remarks>
    private void WarnInferredZeros(string mask, string value, int line, int column)
    {
        string[] values = value.Split(',').Select(v => v.Trim()).ToArray();
        IReadOnlyList<int> zeros = PercentMask.InferredZeros(mask, values.Length);
        if (zeros.Count == 0)
        {
            return;
        }

        string named = string.Join(", ", zeros.Select(i => $"\"{values[i]}\""));
        string plural = zeros.Count == 1 ? "a value that is" : "values that are";
        Warn(
            "TDC301",
            $"percent leaves {named} at 0% — {plural} declared and never drawn",
            "A percent shorter than the list is fine: what is left over goes to the positions "
            + "you did not write. Here the ones you did write already total 100, so there is "
            + "nothing left. Give it the share you meant, drop it from value=, or write the 0 "
            + "yourself to say you meant it.",
            line, column);
    }

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

    /// <summary>
    /// Attributes that reach the value AFTER it is drawn, and so cannot survive a draw without
    /// replacement. Each can make two distinct draws print the same text.
    /// </summary>
    private static readonly string[] DroppedByUniq =
    {
        "mask", "case", "missing", "missing_as", "repeat", "separator", "distinct", "anomaly",
        "anomaly_flag",
    };

    /// <summary>
    /// <c>uniq="true"</c> on a simple sequence whose <c>&lt;gen&gt;</c> also asks for formatting.
    /// </summary>
    /// <remarks>
    /// The uniq path produces the column directly and never reaches the pipeline that applies
    /// these attributes, so they used to vanish in silence. Applying them instead would break the
    /// promise the other way round: a mask maps two distinct draws onto the same characters. So
    /// the combination is refused and the attribute is named. <c>increment</c> and
    /// <c>decrement</c> are exempt — unique by construction, they keep their ordinary build.
    /// </remarks>
    private void UniqDropsGenAttrs(
        TDCParser.OpenCloseElementContext open, string? name,
        List<IReadOnlyDictionary<string, string>> gens)
    {
        string? uniq = Attributes(open.attr()).GetValueOrDefault("uniq");
        if (uniq is null || !string.Equals(uniq.Trim(), "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        // Every <gen> the uniq construction replaces: the ONE unnamed gen of a simple sequence,
        // or ALL the fields of a compound one. Looking only at the simple shape missed the case
        // that mattered — a compound carrying missing="0.4" produced ZERO blanks over twelve rows.
        bool simple = gens.Count == 1 && !gens[0].ContainsKey("name");
        List<IReadOnlyDictionary<string, string>> members = simple
            ? new List<IReadOnlyDictionary<string, string>> { gens[0] }
            : gens.Where(g => g.ContainsKey("name")).ToList();
        if (members.Count == 0)
        {
            return;
        }

        var askedList = new List<string>();
        foreach (IReadOnlyDictionary<string, string> gen in members)
        {
            string kind = gen.GetValueOrDefault("type") ?? string.Empty;
            if (kind is "increment" or "decrement")
            {
                continue;
            }

            foreach (string a in DroppedByUniq.Where(gen.ContainsKey))
            {
                if (!askedList.Contains(a))
                {
                    askedList.Add(a);
                }
            }
        }

        string[] asked = askedList.ToArray();
        if (asked.Length == 0)
        {
            return;
        }

        string listed = string.Join(", ", asked.Select(a => a + "="));
        (int line, int column) = At(open, "uniq");
        Error(
            "TDC267",
            $"uniq=\"true\" on <sequence name=\"{name ?? "?"}\"> cannot be combined with "
                + $"{listed} on its <gen>: a draw without replacement produces the values "
                + "directly, so nothing that rewrites them afterwards runs",
            "Two ways out. Drop the attribute if the uniqueness is what you wanted \u2014 or drop "
                + "uniq= and keep the formatting, since a masked, blanked or repeated column "
                + "cannot be unique as text anyway: a mask maps different values onto the same "
                + "characters.",
            line, column);
    }

    /// <summary><c>&lt;distinct&gt;</c> inside a <c>uniq="true"</c> sequence.</summary>
    /// <remarks>
    /// Documented as independent and they are not: <c>&lt;distinct&gt;</c> repairs a row so its
    /// fields differ, and <c>uniq</c> afterwards rearranges the whole columns without knowing
    /// which pairings the repair ruled out. Measured on twelve rows over exactly twelve legal
    /// distinct pairs, the run still produced <c>s,s</c> and <c>q,q</c>.
    /// </remarks>
    private void UniqWithDistinct(TDCParser.OpenCloseElementContext open, string? name)
    {
        string? uniq = Attributes(open.attr()).GetValueOrDefault("uniq");
        if (uniq is null || !string.Equals(uniq.Trim(), "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        bool hasDistinct = open.content().element()
            .Any(c => c.openCloseElement()?.name.Text == "distinct");
        if (!hasDistinct)
        {
            return;
        }

        (int line, int column) = At(open, "uniq");
        Error(
            "TDC267",
            $"uniq=\"true\" on <sequence name=\"{name ?? "?"}\"> cannot be combined with "
                + "<distinct>: the uniq arrangement rearranges the finished columns and does not "
                + "know which pairings <distinct> ruled out, so the repair is undone",
            "Keep one of the two. <distinct> is about a single record (its fields differ); uniq= "
                + "is about the whole column (no record repeats). For both at once, give each "
                + "field its own <sequence>, wrap them in <uniq>\u2026</uniq>, and put the "
                + "<distinct> at env level.",
            line, column);
    }

    /// <summary><c>order="sequential"</c> on SOME members of a <c>row=</c> link.</summary>
    /// <remarks>
    /// <c>row="k"</c> exists to keep a record together; <c>order="sequential"</c> picks a line by
    /// position. Two rules choosing the same line, and only one can win — measured on the files
    /// guide's own users.csv, John was paired with Johnson when John is Smith. Narrow on purpose:
    /// when EVERY member is sequential they agree and the records hold.
    /// </remarks>
    private void RowLinkOrder(
        List<IReadOnlyDictionary<string, string>> gens, List<GenNode> genNodes)
    {
        var links = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        for (int i = 0; i < gens.Count; i++)
        {
            string key = (gens[i].GetValueOrDefault("row") ?? string.Empty).Trim();
            if (key.Length == 0)
            {
                continue;
            }

            if (!links.TryGetValue(key, out List<int>? group))
            {
                group = new List<int>();
                links[key] = group;
            }

            group.Add(i);
        }

        foreach ((string key, List<int> group) in links)
        {
            if (group.Count < 2)
            {
                continue;
            }

            List<int> walking = group
                .Where(i => (gens[i].GetValueOrDefault("order") ?? string.Empty).Trim()
                    == "sequential")
                .ToList();
            if (walking.Count == 0 || walking.Count == group.Count)
            {
                continue;
            }

            int plain = group.Count - walking.Count;
            GenNode node = genNodes[walking[0]];
            (int line, int column) = At(node.Attrs, "order", node.Line, node.Column);
            Error(
                "TDC282",
                $"order=\"sequential\" on part of the row=\"{key}\" link: {walking.Count} of "
                    + $"{group.Count} members walk the file in order and {plain} pick a line per "
                    + "record, so they stop reading the same line",
                "row= exists to keep the fields of one record together. Either give every member "
                    + "of the link order=\"sequential\", so they walk in step, or drop it from "
                    + "this one.",
                line, column);
        }
    }

    /// <summary>Members of one <c>row=</c> link that read DIFFERENT files.</summary>
    /// <remarks>
    /// One line of one file is what a link is, so two files under one key is not a request the
    /// engine can grant — and the two engines did not agree on how to fail it. The in-memory
    /// engine threw <c>row link "k" cannot mix different file sources</c>: no code, no line, no
    /// file. The streaming engine granted it, pairing the two files by proportion, which for a
    /// 3-row file and a 2-row file gave ann/10, ann/10, ann/10, cal/20 — a join nobody asked for,
    /// printed as data. Only <c>src</c> is compared: two members legitimately read different
    /// columns of one file, and a link is exactly what makes that a record.
    /// </remarks>
    private void RowLinkSource()
    {
        var links = new Dictionary<string, List<(string Key, string Src, GenNode Node)>>(
            StringComparer.Ordinal);
        foreach ((string Key, string Src, GenNode Node) member in _rowLinkGens)
        {
            if (!links.TryGetValue(member.Key, out var group))
            {
                group = new List<(string, string, GenNode)>();
                links[member.Key] = group;
            }

            group.Add(member);
        }

        foreach ((string key, var group) in links)
        {
            if (group.Count < 2)
            {
                continue;
            }

            string firstSrc = group[0].Src;
            for (int i = 1; i < group.Count; i++)
            {
                if (string.Equals(group[i].Src, firstSrc, StringComparison.Ordinal))
                {
                    continue;
                }

                GenNode node = group[i].Node;
                (int line, int column) = At(node.Attrs, "src", node.Line, node.Column);
                Error(
                    "TDC298",
                    $"row=\"{key}\" links two different files: this one reads "
                        + $"\"{group[i].Src}\" and another member reads \"{firstSrc}\"",
                    "A link is one LINE of one file, so there is no line that belongs to both. "
                        + "Point every member of the link at the same src=, or give this one its "
                        + "own row= key.",
                    line, column);
            }
        }
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
        "sequence", "mix", "switch", "uniq", "distinct", "data",
    };

    /// <summary>A fixture holds literal text and <c>&lt;line&gt;</c>s.</summary>
    /// <summary>
    /// A fixture body is made of <c>&lt;line&gt;</c>s and nothing else.
    /// </summary>
    /// <remarks>
    /// <c>data</c> used to be on this list, and every renderer only ever walks <c>&lt;line&gt;</c>
    /// — so <c>&lt;before&gt;&lt;data&gt;x&lt;/data&gt;&lt;/before&gt;</c> validated and emitted
    /// nothing at all. The list is what the "Allowed inside" note prints, so it has to say what
    /// the renderer actually does.
    /// </remarks>
    private static readonly IReadOnlySet<string> FixtureChildren =
        new HashSet<string> { "line" };

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
