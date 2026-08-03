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
pub const ENV_CHILDREN: [&str; 14] = [
    "sequence",
    "mix",
    "switch",
    "pool",
    "uniq",
    "distinct",
    "before",
    "after",
    "before_block",
    "after_block",
    "delimiter_block",
    "before_line",
    "after_line",
    "delimiter_line",
];

/// What each closed tag reads.
pub const CLOSED_TAG_ATTRIBUTES: [(&str, &[&str]); 13] = [
    (
        "env",
        &[
            "count", "seed", "local", "inject", "mode", "engine", "comment",
        ],
    ),
    ("sequence", &["name", "parent", "uniq", "comment"]),
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
pub const GEN_ATTRS: [&str; 77] = [
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
    "repeat",
    "separator",
    "accumulate",
    "of",
    "reset",
    "missing",
    "missing_as",
    "anomaly",
    "anomaly_factor",
    "anomaly_flag",
    "flag",
    "local",
    "count",
    "weight",
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
    "points",
    "upper",
    "lower",
    "y_range",
    "interp",
    "spread",
    "ink_threshold",
    "mode",
    "in",
    "on_error",
    "timeout",
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

pub const GEN_TYPES: [&str; 15] = [
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
];

/// Which generator types actually read a given attribute.
///
/// An attribute in [`GEN_ATTRS`] is spelled correctly for SOME generator; this
/// says whether it means anything for THIS one. Without it a `min=`/`max=` on a
/// number and a `range=` on anything but a date pass silently and are dropped.
pub const ATTRIBUTE_OWNERS: [(&str, &[&str]); 24] = [
    // A list to walk. A range-based generator draws instead of stepping.
    ("order", &["text", "file"]),
    ("cycle", &["text", "file"]),
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
    // The drawn curve.
    ("points", &["pattern"]),
    ("upper", &["pattern"]),
    ("lower", &["pattern"]),
    ("y_range", &["pattern"]),
    ("interp", &["pattern"]),
    ("spread", &["pattern"]),
    ("ink_threshold", &["pattern"]),
    // The synthetic series.
    ("base", &["timeseries", "running"]),
    ("trend", &["timeseries"]),
    ("period", &["timeseries"]),
    ("amplitude", &["timeseries"]),
    ("noise", &["timeseries"]),
    // Zero-padding a numeric range.
    ("first_zero", &["number"]),
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
pub const BUILTIN_TEMPLATE_PATHS: [&str; 2] = ["person.b_day", "date.range"];

pub const PLACEMENT_HINTS: [(&str, &str); 8] = [
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
];

/// The binary operators the evaluator implements. Anything else is refused, not
/// ignored.
/// Operators whose right side may be a bare word rather than a name.
pub const COMPARISON_OPERATORS: &[&str] = &["==", "!=", "===", "!==", "<", ">", "<=", ">="];

pub const SUPPORTED_BINARY_OPERATORS: [&str; 14] = [
    "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/",
];

pub const SUPPORTED_UNARY_OPERATORS: [&str; 3] = ["!", "-", "+"];

pub fn lookup<'a>(table: &'a [(&'a str, &'a [&'a str])], key: &str) -> Option<&'a [&'a str]> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}
