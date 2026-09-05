//! What the DSL accepts, spelled out.
//!
//! These are the lists the validator checks names against — where a tag may
//! live, what attributes it reads, which generator owns which knob. They are
//! data rather than code because the rule they encode is "this name is spelled
//! correctly and means something HERE", and a list is the honest shape of that.
//!
//! An attribute a tag does not read is a request the config made and silently
//! did not get, which is indistinguishable from a typo — and the data comes out
//! looking fine either way. `comment` is accepted everywhere: it is documented
//! as a note that never renders, and refusing it on a tag that happens not to
//! list it would be a pointless trap.

/// What may sit directly inside `<tdc>`.
pub const TDC_CHILDREN: [&str; 2] = ["env", "block"];

/// What may sit directly inside `<env>`.
pub const ENV_CHILDREN: [&str; 15] = [
    "sequence",
    "mix",
    "switch",
    "pool",
    "uniq",
    "distinct",
    "assert",
    "before",
    "after",
    "before_block",
    "after_block",
    "delimiter_block",
    "before_line",
    "after_line",
    "delimiter_line",
];

/// What may sit directly inside `<sequence>`: the generator(s), literal text
/// between them, a `<distinct>` wrapper grouping fields, or a `<compute>`.
pub const SEQUENCE_CHILDREN: [&str; 4] = ["gen", "data", "distinct", "compute"];

/// What a `<distinct>`/`<uniq>` wrapper holds INSIDE a sequence: the fields of
/// one record. At `<env>` level the same two tags group whole columns instead —
/// see `ENV_GROUP_CHILDREN`. One list for both refuses working configs.
pub const DISTINCT_CHILDREN: [&str; 1] = ["gen"];

/// Members of an `<env>`-level `<distinct>`/`<uniq>` group.
pub const ENV_GROUP_CHILDREN: [&str; 3] = ["sequence", "mix", "switch"];

/// What may sit inside `<pool>`. Deliberately generous: too SHORT a list refuses
/// configs that work, while too long a one merely leaves a little silence.
// A `<data>` inside a `<pool>` is accepted, so the refusal for a WRONG child has to name
// it among the allowed ones.
// No "data". A pool publishes NAMED fields — ${{Ref.a}} — and a bare <data> has no name, so
// nothing can address it. The composed form works one level in, inside the member's <sequence>.
pub const POOL_CHILDREN: [&str; 5] = ["sequence", "mix", "switch", "uniq", "distinct"];

/// What a fixture (`<before>`, `<after>`, the delimiters) holds: literal text.
/// A fixture body is made of `<line>`s and nothing else.
///
/// `data` used to be on this list, and every renderer only ever walks `<line>` —
/// so `<before><data>x</data></before>` validated and emitted nothing at all.
/// The list is what the "Allowed inside" note prints, so it has to say what the
/// renderer actually does.
pub const FIXTURE_CHILDREN: [&str; 1] = ["line"];

/// What may sit directly inside `<block>` and `<line>`.
pub const BLOCK_CHILDREN: [&str; 1] = ["line"];
pub const LINE_CHILDREN: [&str; 4] = ["data", "gen", "mix", "switch"];

/// What may sit directly inside `<switch>`.
pub const SWITCH_CHILDREN: [&str; 3] = ["map", "case", "default"];

/// What each closed tag reads.
pub const CLOSED_TAG_ATTRIBUTES: [(&str, &[&str]); 14] = [
    (
        "env",
        &[
            "count", "seed", "local", "inject", "mode", "engine", "comment",
        ],
    ),
    ("sequence", &["name", "parent", "uniq", "comment"]),
    // An assertion is its two attributes and nothing else.
    ("assert", &["that", "says", "comment"]),
    ("line", &["if", "each", "comment"]),
    ("tdc", &["version", "v", "regex_max_length", "comment"]),
    ("mix", &["name", "percent", "parent", "flag", "comment"]),
    // `percent` is NOT here: a <switch> picks its case from `on=`, and <case> requires
    // `is=` (TDC137). The percentage short-form belongs to <mix>.
    ("switch", &["name", "on", "comment"]),
    ("case", &["is", "if", "anomaly", "default", "comment"]),
    ("map", &["comment"]),
    ("default", &["comment"]),
    ("pool", &["name", "count", "comment"]),
    // A group wrapper says what must hold BETWEEN the sequences inside it; it has
    // no settings of its own. `uniq="true"` is an attribute of <sequence>, not of
    // <uniq> — writing it on the wrapper is a common slip and now says so.
    ("uniq", &["comment"]),
    ("distinct", &["comment"]),
    ("data", &["if", "pair", "name", "type", "comment"]),
];

/// Constructs that live at env level; inside a `<sequence>` they are simply
/// misplaced.
pub const MISPLACED_IN_SEQUENCE: [&str; 5] = ["mix", "switch", "case", "default", "map"];

/// Everything a `<gen>` may carry, whatever its type.
/// These eight are NOT here, and their absence is deliberate: `seed`, `engine`,
/// `version`, `inject` belong to `<env>` or `<tdc>`; `uniq` to `<sequence>`; `is`
/// to `<case>`; `on` to `<switch>`; `v` to `<tdc>`. The list was one flat union of
/// every attribute name in the language, so writing any of them on a `<gen>`
/// passed in silence while the reference refused it.
pub const GEN_ATTRS: [&str; 88] = [
    "type",
    "value",
    "name",
    "filter",
    "if",
    "comment",
    "case",
    "mask",
    "order",
    "cycle",
    "weekdays",
    "peak_at",
    "repeat",
    "separator",
    "accumulate",
    "distinct",
    "of",
    "plus",
    "reset",
    "op",
    "missing",
    "missing_as",
    "missing_when",
    "anomaly",
    "anomaly_factor",
    "anomaly_flag",
    "local",
    "weight",
    "read",
    "sample",
    "expr",
    "lengths",
    "percent",
    "first_zero",
    "include",
    "exclude",
    "length",
    "decimals",
    "distribution",
    "regex_max_length",
    "alphabet",
    "format",
    "from",
    "to",
    "oldest",
    "youngest",
    "precision",
    "range",
    "step",
    "src",
    "column",
    "header",
    "delimiter",
    "row",
    "base",
    "trend",
    "period",
    "amplitude",
    "noise",
    "noise_correlation",
    "points",
    "upper",
    "lower",
    "y_range",
    "fit",
    "interp",
    "spread",
    "ink_threshold",
    "mode",
    "in",
    "on_error",
    "timeout",
    "secret",
    "mean",
    "sd",
    "meanlog",
    "sdlog",
    "rate",
    "alpha",
    "xmin",
    "shape",
    "scale",
    "lambda",
    "n",
    "s",
    "beta",
    "min",
    "max",
];

pub const GEN_TYPES: [&str; 17] = [
    "formula",
    "text",
    "file",
    "template",
    "number",
    "regex",
    "advanced_regex",
    "symbol",
    "date",
    "increment",
    "decrement",
    "timeseries",
    "pattern",
    "http",
    "pool",
    "running",
    "stat",
];

/// Which generator types actually read a given attribute.
///
/// An attribute in [`GEN_ATTRS`] is spelled correctly for SOME generator; this
/// says whether it means anything for THIS one. Without it a `min=`/`max=` on a
/// number and a `range=` on anything but a date pass silently and are dropped.
pub const ATTRIBUTE_OWNERS: [(&str, &[&str]); 51] = [
    // A list to walk — or, on a date, a range walked instead of drawn.
    ("order", &["text", "file", "date"]),
    ("cycle", &["text", "file", "date"]),
    // How far each row moves. A counter's stride and a walked date range mean the
    // same thing in their own units, which is why they borrow one word.
    ("step", &["date", "increment", "decrement"]),
    ("weekdays", &["date"]),
    // The seasonal wave's highest row.
    ("peak_at", &["timeseries"]),
    // Where the characters come from.
    ("alphabet", &["symbol"]),
    // The external source and how to read it. `pattern` is here because a drawn
    // curve is loaded the same way — src="curve.svg", src="curve.png".
    ("src", &["file", "http", "pattern"]),
    ("column", &["file"]),
    ("header", &["file"]),
    ("delimiter", &["file"]),
    ("row", &["file"]),
    // The network generator's own knobs.
    ("in", &["http"]),
    ("on_error", &["http"]),
    ("timeout", &["http"]),
    ("secret", &["http"]),
    // The drawn curve.
    ("points", &["pattern"]),
    ("upper", &["pattern"]),
    ("lower", &["pattern"]),
    ("y_range", &["pattern"]),
    ("fit", &["pattern"]),
    ("interp", &["pattern"]),
    ("spread", &["pattern"]),
    ("ink_threshold", &["pattern"]),
    // The synthetic series.
    // On a date, `of=` measures from a sibling instead of drawing, and `plus=` is
    // the distance.
    ("of", &["running", "stat", "date"]),
    ("plus", &["date"]),
    ("reset", &["running"]),
    ("op", &["stat"]),
    ("base", &["timeseries", "running"]),
    ("trend", &["timeseries"]),
    ("period", &["timeseries"]),
    ("amplitude", &["timeseries"]),
    ("noise", &["timeseries"]),
    ("noise_correlation", &["timeseries"]),
    // Zero-padding a numeric range.
    ("first_zero", &["number"]),
    // ── The date's own vocabulary ───────────────────────────────────────────
    //
    // from=/to= are the trap that reopened this table. They are the natural
    // words for a numeric range, they are real attributes, and a number
    // generator has never read them: `<gen type="number" from="1000"
    // to="9999"/>` produced 3 4 4 6 — four-digit ids asked for, single digits
    // produced, `check` calling the config valid.
    ("from", &["date"]),
    ("to", &["date"]),
    ("format", &["date"]),
    ("precision", &["date"]),
    // The birth window, read only where a birthday is drawn.
    ("oldest", &["date"]),
    ("youngest", &["date"]),
    // ── The shape of a drawn value ──────────────────────────────────────────
    //
    // `length=` on a text or a regex is the second-most natural thing to write
    // and does nothing: a text walks the list you gave it, and a regex is as
    // long as its pattern says.
    ("length", &["number", "symbol"]),
    ("include", &["number", "symbol"]),
    ("exclude", &["number", "symbol"]),
    // How many places the answer is printed to. Four generators produce a
    // number they may have to round; the rest produce text, which has none.
    // `file` is on the list only because `read="quantile"` makes it produce a number — an
    // interpolated point between two observations, written to the source's precision.
    (
        "decimals",
        &["number", "timeseries", "pattern", "stat", "formula", "file"],
    ),
    // How a source file is READ, and whether the quantile read draws or sweeps.
    ("read", &["file"]),
    ("sample", &["file"]),
    ("expr", &["formula"]),
    (
        "lengths",
        &["number", "text", "template", "file", "symbol", "regex"],
    ),
    ("distribution", &["number"]),
    // The ceiling on what an unbounded pattern may expand to.
    ("regex_max_length", &["regex", "advanced_regex"]),
    // How a drawing is read — as a curve or as a density.
    ("mode", &["pattern"]),
    // `percent` is deliberately ABSENT: only text and number read it as a share
    // of their own values, but the engine routes ANY generator carrying it
    // through the share machinery.
];

/// `range=` is read by the date generator and by the `date.range` builtin
/// template. On a number it is the wrong word for `value="10..99"` — and
/// silently gave single digits.
pub const RANGE_OWNERS: [&str; 2] = ["date", "template"];

/// Parameters of the named distributions.
///
/// They shape the DRAW, so they mean nothing unless `distribution=` asked for
/// one — `min="10" max="20"` on a plain number is the trap this catches. Gated
/// on the attribute rather than on the type, because that is how the engine
/// reads them.
pub const DISTRIBUTION_PARAMS: [&str; 14] = [
    "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale", "min", "max",
    "lambda", "beta", "s",
];

/// The two template paths no pack backs, and the parameters each reads.
///
/// A pack declares its own parameters and is judged against the registry; these
/// two would otherwise be checked by nobody, and `oldst="30"` for `oldest` is
/// the same silent failure `persent` used to be.
pub const BUILTIN_TEMPLATE_PARAMS: [(&str, &[&str]); 2] = [
    (
        "person.b_day",
        &["oldest", "youngest", "format", "precision"],
    ),
    ("date.range", &["range", "format", "precision"]),
];

/// What any template takes regardless of which path it names.
pub const TEMPLATE_COMMON_ATTRS: [&str; 8] = [
    "type", "value", "name", "local", "count", "percent", "weight", "if",
];

/// Template paths that are generators rather than pack files.
/// The generator types in the order the reference lists them — the common ones first.
///
/// The order is the answer on a list the refusal CUTS: sorted, the six a reader is shown open with `advanced_regex` where the reference opens with `text`. Declaration order — the common types first — is what the reference prints.
pub const GEN_TYPE_ORDER: [&str; 17] = [
    "text",
    "file",
    "template",
    "number",
    "regex",
    "advanced_regex",
    "symbol",
    "date",
    "increment",
    "decrement",
    "timeseries",
    "pattern",
    "http",
    "pool",
    "running",
    "stat",
    "formula",
];

/// The nine builtin template paths, in the order the reference lists them.
///
/// Named here rather than derived from the pack registry: this is the list a REFUSAL offers when
/// no path was given at all, and it has to be the same nine everywhere. Offering one example
/// where the reference offers three told a reader the language is narrower than it is.
pub const KNOWN_TEMPLATE_PATHS: [&str; 9] = [
    "person.male.firstName",
    "person.female.firstName",
    "person.lastName",
    "person.male.diagnosis",
    "person.female.diagnosis",
    "person.gender",
    "person.b_day",
    "location.country",
    "date.range",
];

pub const BUILTIN_TEMPLATE_PATHS: [&str; 2] = ["person.b_day", "date.range"];

pub const PLACEMENT_HINTS: [(&str, &str); 9] = [
    (
        "gen",
        "A <gen> lives inside a <sequence> (or a <case> of a <mix>/<switch>).",
    ),
    (
        "mix",
        "A <mix> is a named env-level construct — declare it directly in <env> and use ${{Name}}.",
    ),
    (
        "switch",
        "A <switch> is a named env-level construct — declare it directly in <env> and use \
         ${{Name}}.",
    ),
    ("case", "A <case> belongs inside a <mix> or a <switch>."),
    ("map", "A <map> belongs inside a <switch>."),
    ("default", "A <default> belongs inside a <switch>."),
    (
        "line",
        "A <line> belongs inside a <block> (or a before/after fixture).",
    ),
    ("sequence", "A <sequence> belongs directly inside <env>."),
    // A <data> has no value of its own: it JOINS the value of the thing around it. Written
    // where there is nothing to join — straight into <tdc>, <env>, <block> or <pool> — it
    // rendered nothing and said nothing.
    (
        "data",
        "A <data> joins the value of the <line>, <sequence> or <case> it sits in — on its own \
         there is nothing for it to join.",
    ),
];

/// The binary operators the evaluator implements. Anything else is refused, not
/// ignored.
/// Operators whose right side may be a bare word rather than a name.
pub const COMPARISON_OPERATORS: &[&str] = &["==", "!=", "===", "!==", "<", ">", "<=", ">="];

pub const SUPPORTED_BINARY_OPERATORS: [&str; 16] = [
    "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/",
    // Euclidean, matching <mod>: -3 % 2 is 1 here and -1 in Rust's own `%`.
    "%", // Set membership: `Country in [US, CA, MX]`.
    "in",
];

pub const SUPPORTED_UNARY_OPERATORS: [&str; 3] = ["!", "-", "+"];

/// What an `if=` may call: the name, then the smallest and largest argument
/// count (`usize::MAX` for variadic).
///
/// The exact ones are built from comparisons and the arithmetic IEEE-754 pins
/// down. The transcendental ones are computed by TDC itself (`crate::math`)
/// rather than by the host libm, which is what keeps five implementations on
/// one double.
pub const EXPR_FUNCTIONS: [(&str, usize, usize); 61] = [
    ("abs", 1, 1),
    ("acos", 1, 1),
    ("acosh", 1, 1),
    ("asin", 1, 1),
    ("asinh", 1, 1),
    ("atan", 1, 1),
    ("atan2", 2, 2),
    ("at", 2, 2),
    ("atanh", 1, 1),
    ("beta", 2, 2),
    ("cbrt", 1, 1),
    ("ceil", 1, 1),
    ("clamp", 3, 3),
    ("contains", 2, 2),
    ("cos", 1, 1),
    ("cosh", 1, 1),
    ("count", 1, 1),
    ("degrees", 1, 1),
    ("digamma", 1, 1),
    ("ends_with", 2, 2),
    ("erf", 1, 1),
    ("erfc", 1, 1),
    ("exp", 1, 1),
    ("expm1", 1, 1),
    ("floor", 1, 1),
    ("gamma", 1, 1),
    ("gauss", 3, 3),
    ("hash", 2, 2),
    ("noise", 3, 3),
    ("prev", 2, 2),
    ("hypot", 2, 2),
    ("is_empty", 1, 1),
    ("join", 2, 2),
    ("len", 1, 1),
    ("lerp", 3, 3),
    ("lgamma", 1, 1),
    ("log", 1, 1),
    ("log10", 1, 1),
    ("log1p", 1, 1),
    ("log2", 1, 1),
    ("lower", 1, 1),
    ("max", 1, usize::MAX),
    ("mean", 1, 1),
    ("median", 1, 1),
    ("min", 1, usize::MAX),
    ("pow", 2, 2),
    ("radians", 1, 1),
    ("round", 1, 1),
    ("sign", 1, 1),
    ("sin", 1, 1),
    ("sinh", 1, 1),
    ("split", 2, 2),
    ("sqrt", 1, 1),
    ("starts_with", 2, 2),
    ("stddev", 1, 1),
    ("sum", 1, 1),
    ("tan", 1, 1),
    ("tanh", 1, 1),
    ("trunc", 1, 1),
    ("upper", 1, 1),
    ("zeta", 1, 1),
];

// Every name is one the evaluator answers to. Eight were implemented and left off this
// list -- `at`, `count`, `join`, `mean`, `median`, `split`, `stddev`, `sum` -- so the
// refusal for an unknown function offered a shorter language than the one that runs, and
// a reader looking for `count` in it concluded it does not exist.
pub const EXPR_FUNCTION_NAMES: [&str; 61] = [
    "abs",
    "acos",
    "acosh",
    "asin",
    "asinh",
    "at",
    "atan",
    "atan2",
    "atanh",
    "beta",
    "cbrt",
    "ceil",
    "clamp",
    "contains",
    "cos",
    "cosh",
    "count",
    "degrees",
    "digamma",
    "ends_with",
    "erf",
    "erfc",
    "exp",
    "expm1",
    "floor",
    "gamma",
    "gauss",
    "hash",
    "hypot",
    "is_empty",
    "join",
    "len",
    "lerp",
    "lgamma",
    "log",
    "log10",
    "log1p",
    "log2",
    "lower",
    "max",
    "mean",
    "median",
    "min",
    "noise",
    "pow",
    "prev",
    "radians",
    "round",
    "sign",
    "sin",
    "sinh",
    "split",
    "sqrt",
    "starts_with",
    "stddev",
    "sum",
    "tan",
    "tanh",
    "trunc",
    "upper",
    "zeta",
];

/// Not available, and not typos either. Someone writing `besselj(_count)` knows
/// what they meant, and "did you mean beta?" is worse than saying nothing.
///
/// What is left here is the mathematics a data generator has no business
/// carrying: each is a project rather than a function, and none has ever
/// plausibly belonged in a row predicate.
pub const PLANNED_EXPR_FUNCTIONS: [&str; 6] = [
    "airy",
    "besselj",
    "bessely",
    "elliptic_e",
    "elliptic_k",
    "polygamma",
];

pub fn lookup<'a>(table: &'a [(&'a str, &'a [&'a str])], key: &str) -> Option<&'a [&'a str]> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// What the ENGINE reads off a `<gen type="template">` before the pack runs.
///
/// Kept in step with `engine::memory::RESERVED_TEMPLATE_ATTRS`. A pack may claim
/// any OTHER name, which is why the ownership table has no jurisdiction there:
/// it refused `base=` on the 39 packs that declare a `<sequence name="base">`,
/// the whole check-digit family, on configs the engine would have run.
pub const RESERVED_TEMPLATE_ATTRS: [&str; 16] = [
    "type",
    "value",
    "local",
    "name",
    "if",
    "comment",
    "anomaly",
    "anomaly_factor",
    "anomaly_flag",
    "missing",
    "missing_as",
    "missing_when",
    "mask",
    "case",
    "order",
    "cycle",
];

/// What the pack-parameter check may skip: the engine-reserved names plus the
/// wrappers applied around the produced value. Using the union of EVERY
/// generator's attributes instead meant a name like `points=` was reported by
/// nobody once the ownership check stopped guessing.
pub const PACK_WRAPPER_ATTRS: [&str; 22] = [
    "anomaly",
    "anomaly_factor",
    "anomaly_flag",
    "case",
    "comment",
    "count",
    "cycle",
    "flag",
    "if",
    "local",
    "mask",
    "missing",
    "missing_as",
    "missing_when",
    "name",
    "order",
    "parent",
    "repeat",
    "separator",
    "type",
    "value",
    "distinct",
];

/// The output wrappers a generator type does NOT put its value through.
///
/// `running` and `stat` are resolved before the formatting layer runs — they
/// read a column that already exists and publish the number as it stands — so
/// these sat on them doing nothing while `check` called the config valid.
/// Refused rather than implemented: the interpolation filter runs where the
/// value is PRINTED, so `${{Total|mask:x}}` works today.
/// The same, for a date measured from another column — keyed on `of=`, not on a type.
///
/// `percent=` is here and not in the table below because the other three are numbers and a
/// quota over a derived number is a different argument; a date offset is a DATE, and a quota
/// over "row N plus seven days" would have to invent which rows get the offset and which keep
/// the original. Refused, like the rest.
pub const OFFSET_WRAPPERS_NOT_READ: [&str; 9] = [
    "mask",
    "case",
    "missing",
    "missing_as",
    "missing_when",
    "repeat",
    "anomaly",
    "anomaly_factor",
    "percent",
];

pub const WRAPPERS_NOT_READ: [(&str, &[&str]); 3] = [
    (
        "running",
        &[
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
        ],
    ),
    (
        "stat",
        &[
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
        ],
    ),
    // A pool reference hands the row a whole MEMBER from a table built before the
    // run, so there is no value of its own for the formatting layer to reach.
    (
        "pool",
        &[
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
            "percent",
        ],
    ),
];
