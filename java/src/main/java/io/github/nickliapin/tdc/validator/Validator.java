package io.github.nickliapin.tdc.validator;

import io.github.nickliapin.tdc.expr.MatchKey;
import io.github.nickliapin.tdc.date.DateParse;
import io.github.nickliapin.tdc.date.DateStep;
import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.generators.Accumulate;
import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.generators.Stat;
import io.github.nickliapin.tdc.parser.PairedData;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import io.github.nickliapin.tdc.sequence.Pool;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.HashSet;
import java.util.Set;
import org.antlr.v4.runtime.Token;
import org.antlr.v4.runtime.tree.ParseTree;

/**
 * Checks a config before it runs, and reports what is wrong by stable code.
 *
 * <p>This exists because "the same config produces the same data everywhere" is only half a
 * promise if one implementation accepts what another refuses. A config that runs in Java and
 * fails in TypeScript is a portability bug even when no value was ever wrong.
 *
 * <p>The grammar is deliberately permissive — it lets any element nest anywhere — so every rule
 * about <em>where</em> a tag may live is owned here rather than by the parser. That keeps the
 * grammar shared and small while the rules stay readable.
 *
 * <p>Codes and their meanings come from the reference. Nothing is invented here: a rule that
 * exists in one implementation and not the other is exactly the divergence this file is meant to
 * prevent.
 */
public final class Validator {

  /** What may sit directly inside {@code <tdc>}. */
  private static final Set<String> TDC_CHILDREN = Set.of("env", "block");

  /**
   * What each closed tag reads.
   *
   * <p>An attribute a tag does not read is a request the config made and silently did not get,
   * which is indistinguishable from a typo — and the data comes out looking fine either way.
   * {@code comment} is accepted everywhere: it is documented as a note that never renders, and
   * refusing it on a tag that happens not to list it would be a pointless trap.
   */
  private static final Map<String, Set<String>> CLOSED_TAG_ATTRIBUTES =
      Map.ofEntries(
          Map.entry("env", Set.of("count", "seed", "local", "inject", "mode", "engine", "comment")),
          Map.entry("sequence", Set.of("name", "parent", "uniq", "comment")),
          Map.entry("line", Set.of("if", "each", "comment")),
          Map.entry("tdc", Set.of("version", "v", "regex_max_length", "comment")),
          Map.entry("mix", Set.of("name", "percent", "parent", "flag", "comment")),
          // `percent` is NOT here: a <switch> picks its case from `on=`, and <case>
          // requires `is=` (TDC137). The percentage short-form belongs to <mix>.
          Map.entry("switch", Set.of("name", "on", "comment")),
          Map.entry("case", Set.of("is", "if", "anomaly", "default", "comment")),
          Map.entry("map", Set.of("comment")),
          Map.entry("default", Set.of("comment")),
          Map.entry("data", Set.of("if", "pair", "name", "type", "comment")),
          Map.entry("pool", Set.of("name", "count", "comment")),
          // A group wrapper says what must hold BETWEEN the sequences inside it; it has no
          // settings of its own. uniq="true" is an attribute of <sequence>, not of <uniq> —
          // writing it on the wrapper is a common slip and now says so.
          Map.entry("uniq", Set.of("comment")),
          // An assertion is its two attributes and nothing else.
          Map.entry("assert", Set.of("that", "says", "comment")),
          Map.entry("distinct", Set.of("comment")));

  /** Where each construct belongs — the "put it in X" half of a placement complaint. */
  /** Constructs that live at env level; inside a <sequence> they are simply misplaced. */
  private static final java.util.Set<String> MISPLACED_IN_SEQUENCE =
      java.util.Set.of("mix", "switch", "case", "default", "map");


  /**
   * Which generator types actually read a given attribute.
   *
   * <p>An attribute in {@code GEN_ATTRS} is spelled correctly for SOME generator; this says
   * whether it means anything for THIS one. Without it a {@code min=}/{@code max=} on a number
   * and a {@code range=} on anything but a date pass silently and are dropped.
   */
  /**
   * What the ENGINE reads off a {@code <gen type="template">} before the pack runs.
   *
   * <p>Kept in step with {@code MemoryEngine.RESERVED_TEMPLATE_ATTRS}. A pack may claim any
   * OTHER name, which is why the ownership table has no jurisdiction there: it refused
   * {@code base=} on the 39 packs that declare a {@code <sequence name="base">} — the whole
   * check-digit family — on configs the engine would have run.
   */
  private static final java.util.Set<String> RESERVED_TEMPLATE_ATTRS =
      java.util.Set.of("type", "value", "local", "name", "if", "comment", "anomaly",
          "anomaly_factor", "anomaly_flag", "missing", "missing_as", "mask", "case", "order",
          "cycle");

  /**
   * What the pack-parameter check may skip: the engine-reserved names plus the wrappers applied
   * around the produced value. Using the union of EVERY generator's attributes instead meant a
   * name like {@code points=} was reported by nobody once the ownership check stopped guessing.
   */
  private static final java.util.Set<String> PACK_WRAPPER_ATTRS =
      java.util.Set.of(
          "anomaly", "anomaly_factor", "anomaly_flag", "case", "comment", "count", "cycle", "flag",
          "if", "local", "mask", "missing", "missing_as", "name", "order", "parent",
          "repeat", "separator", "type", "value");

  /**
   * The output wrappers a generator type does NOT put its value through.
   *
   * <p>{@code running} and {@code stat} are resolved before the formatting layer runs — they
   * read a column that already exists and publish the number as it stands — so these sat on
   * them doing nothing while {@code check} called the config valid. Refused rather than
   * implemented: the interpolation filter runs where the value is PRINTED, so
   * {@code ${{Total|mask:x}}} works today.
   */
  private static final Map<String, java.util.Set<String>> WRAPPERS_NOT_READ =
      Map.of(
          "running", java.util.Set.of("mask", "case", "missing", "missing_as", "repeat", "anomaly", "anomaly_factor"),
          "stat", java.util.Set.of("mask", "case", "missing", "missing_as", "repeat", "anomaly", "anomaly_factor"));

  private static final Map<String, java.util.Set<String>> ATTRIBUTE_OWNERS =
      Map.ofEntries(
          // A list to walk — or, on a date, a range walked instead of drawn.
          Map.entry("order", java.util.Set.of("text", "file", "date")),
          Map.entry("cycle", java.util.Set.of("text", "file", "date")),
          // How far each row moves. A counter's stride and a walked date range mean the same
          // thing in their own units, which is why they borrow one word.
          Map.entry("step", java.util.Set.of("date", "increment", "decrement")),
          Map.entry("weekdays", java.util.Set.of("date")),
          // The seasonal wave's highest row.
          Map.entry("peak_at", java.util.Set.of("timeseries")),
          // Where the characters come from.
          Map.entry("alphabet", java.util.Set.of("symbol")),
          // Only `pool` takes a filter: everywhere else there are no candidates to narrow, and
          // the row-level question is `if=`.
          Map.entry("filter", java.util.Set.of("pool")),
          // The external source and how to read it. `pattern` is here because a drawn curve is
          // loaded the same way — src="curve.svg", src="curve.png".
          Map.entry("src", java.util.Set.of("file", "http", "pattern")),
          Map.entry("column", java.util.Set.of("file")),
          Map.entry("header", java.util.Set.of("file")),
          Map.entry("delimiter", java.util.Set.of("file")),
          Map.entry("row", java.util.Set.of("file")),
          // The network generator's own knobs.
          Map.entry("in", java.util.Set.of("http")),
          Map.entry("on_error", java.util.Set.of("http")),
          Map.entry("timeout", java.util.Set.of("http")),
          // The drawn curve.
          Map.entry("points", java.util.Set.of("pattern")),
          Map.entry("upper", java.util.Set.of("pattern")),
          Map.entry("lower", java.util.Set.of("pattern")),
          Map.entry("y_range", java.util.Set.of("pattern")),
          Map.entry("interp", java.util.Set.of("pattern")),
          Map.entry("spread", java.util.Set.of("pattern")),
          Map.entry("ink_threshold", java.util.Set.of("pattern")),
          // The synthetic series.
          Map.entry("base", java.util.Set.of("timeseries", "running")),
          // On a date, `of=` measures from a sibling instead of drawing, and `plus=` is the
          // distance.
          Map.entry("of", java.util.Set.of("running", "stat", "date")),
          Map.entry("plus", java.util.Set.of("date")),
          Map.entry("op", java.util.Set.of("stat")),
          Map.entry("reset", java.util.Set.of("running")),
          Map.entry("trend", java.util.Set.of("timeseries")),
          Map.entry("period", java.util.Set.of("timeseries")),
          Map.entry("amplitude", java.util.Set.of("timeseries")),
          Map.entry("noise", java.util.Set.of("timeseries")),
          // Zero-padding a numeric range.
          Map.entry("first_zero", java.util.Set.of("number")),
          // ── The date's own vocabulary ───────────────────────────────────────────────
          //
          // from=/to= are the trap that reopened this table. They are the natural words for a
          // numeric range, they are real attributes, and a number generator has never read
          // them: <gen type="number" from="1000" to="9999"/> produced 3 4 4 6 — four-digit ids
          // asked for, single digits produced, check calling the config valid.
          Map.entry("from", java.util.Set.of("date")),
          Map.entry("to", java.util.Set.of("date")),
          Map.entry("format", java.util.Set.of("date")),
          Map.entry("precision", java.util.Set.of("date")),
          // The birth window, read only where a birthday is drawn.
          Map.entry("oldest", java.util.Set.of("date")),
          Map.entry("youngest", java.util.Set.of("date")),
          // ── The shape of a drawn value ──────────────────────────────────────────────
          //
          // length= on a text or a regex is the second-most natural thing to write and does
          // nothing: a text walks the list you gave it, and a regex is as long as its pattern
          // says.
          Map.entry("length", java.util.Set.of("number", "symbol")),
          Map.entry("include", java.util.Set.of("number", "symbol")),
          Map.entry("exclude", java.util.Set.of("number", "symbol")),
          // How many places the answer is printed to. Four generators produce a number they may
          // have to round; the rest produce text, which has no places.
          Map.entry("decimals", java.util.Set.of("number", "timeseries", "pattern", "stat")),
          Map.entry("distribution", java.util.Set.of("number")),
          // The ceiling on what an unbounded pattern may expand to.
          Map.entry("regex_max_length", java.util.Set.of("regex", "advanced_regex")),
          // How a drawing is read — as a curve or as a density.
          Map.entry("mode", java.util.Set.of("pattern")),
          // percent= is deliberately ABSENT: only text and number read it as a share of their
          // own values, but the engine routes ANY generator carrying it through the share
          // machinery.
          // The legacy two-date span, read by the date generator and by the `date.range` builtin
          // template. On a number it is the wrong word for value="10..99" — and silently gave
          // single digits.
          Map.entry("range", java.util.Set.of("date", "template")));

  /**
   * Parameters of the named distributions. They shape the DRAW, so they mean nothing unless
   * {@code distribution=} asked for one — {@code min="10" max="20"} on a plain number is the trap
   * this catches. Gated on the attribute rather than on the type, because that is how the engine
   * reads them.
   */
  private static final java.util.Set<String> DISTRIBUTION_PARAMS =
      java.util.Set.of(
          "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
          "min", "max", "lambda", "beta", "s", "n");

  /**
   * The two template paths no pack backs, and the parameters each reads. A pack declares its own
   * parameters and is judged against the registry; these two would otherwise be checked by
   * nobody, and {@code oldst="30"} for {@code oldest} is the same silent failure {@code persent}
   * used to be.
   */
  private static final Map<String, java.util.Set<String>> BUILTIN_TEMPLATE_PARAMS =
      Map.of(
          "person.b_day", java.util.Set.of("oldest", "youngest", "format", "precision"),
          "date.range", java.util.Set.of("range", "format", "precision"));

  /** What any template takes regardless of which path it names. */
  private static final java.util.Set<String> TEMPLATE_COMMON_ATTRS =
      java.util.Set.of("type", "value", "name", "local", "count", "percent", "weight", "if");

  private static final Map<String, String> PLACEMENT_HINTS =
      Map.of(
          "gen", "A <gen> lives inside a <sequence> (or a <case> of a <mix>/<switch>).",
          "mix",
          "A <mix> is a named env-level construct — declare it directly in <env> and use "
              + "${{Name}}.",
          "switch",
          "A <switch> is a named env-level construct — declare it directly in <env> and use "
              + "${{Name}}.",
          "case", "A <case> belongs inside a <mix> or a <switch>.",
          "map", "A <map> belongs inside a <switch>.",
          "default", "A <default> belongs inside a <switch>.",
          "line", "A <line> belongs inside a <block> (or a before/after fixture).",
          "sequence", "A <sequence> belongs directly inside <env>.");

  /** The binary operators the evaluator implements. Anything else is refused, not ignored. */
  /** Operators whose right side may be a bare word rather than a name. */
  private static final List<String> COMPARISON_OPERATORS =
      List.of("==", "!=", "===", "!==", "<", ">", "<=", ">=");

  private static final List<String> SUPPORTED_BINARY_OPERATORS =
      // `%` is EUCLIDEAN, matching <mod>: -3 % 2 is 1 here and -1 in Java's own %.
      List.of(
          "==", "!=", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%",
          // Set membership: `Country in [US, CA, MX]`.
          "in");

  /**
   * What an {@code if=} may call: the name, then the smallest and largest argument count
   * ({@code Integer.MAX_VALUE} for variadic).
   *
   * <p>The exact ones are built from comparisons and the arithmetic IEEE-754 pins down. The
   * transcendental ones are computed by TDC itself ({@code mathx.TdcMath}) rather than by the host
   * libm, which is what keeps five implementations on one double.
   */
  private static final Map<String, int[]> EXPR_FUNCTIONS =
      Map.ofEntries(
          Map.entry("abs", new int[] {1, 1}),
          Map.entry("acos", new int[] {1, 1}),
          Map.entry("beta", new int[] {2, 2}),
          Map.entry("degrees", new int[] {1, 1}),
          Map.entry("digamma", new int[] {1, 1}),
          Map.entry("radians", new int[] {1, 1}),
          Map.entry("zeta", new int[] {1, 1}),
          Map.entry("erf", new int[] {1, 1}),
          Map.entry("erfc", new int[] {1, 1}),
          Map.entry("gamma", new int[] {1, 1}),
          Map.entry("lgamma", new int[] {1, 1}),
          Map.entry("acosh", new int[] {1, 1}),
          Map.entry("asinh", new int[] {1, 1}),
          Map.entry("atanh", new int[] {1, 1}),
          Map.entry("expm1", new int[] {1, 1}),
          Map.entry("hypot", new int[] {2, 2}),
          Map.entry("log1p", new int[] {1, 1}),
          Map.entry("log2", new int[] {1, 1}),
          Map.entry("sign", new int[] {1, 1}),
          Map.entry("asin", new int[] {1, 1}),
          Map.entry("atan", new int[] {1, 1}),
          Map.entry("atan2", new int[] {2, 2}),
          Map.entry("cbrt", new int[] {1, 1}),
          Map.entry("ceil", new int[] {1, 1}),
          Map.entry("contains", new int[] {2, 2}),
          Map.entry("cos", new int[] {1, 1}),
          Map.entry("cosh", new int[] {1, 1}),
          Map.entry("ends_with", new int[] {2, 2}),
          Map.entry("exp", new int[] {1, 1}),
          Map.entry("floor", new int[] {1, 1}),
          Map.entry("is_empty", new int[] {1, 1}),
          Map.entry("len", new int[] {1, 1}),
          Map.entry("log", new int[] {1, 1}),
          Map.entry("log10", new int[] {1, 1}),
          Map.entry("lower", new int[] {1, 1}),
          Map.entry("max", new int[] {1, Integer.MAX_VALUE}),
          Map.entry("min", new int[] {1, Integer.MAX_VALUE}),
          Map.entry("pow", new int[] {2, 2}),
          Map.entry("round", new int[] {1, 1}),
          Map.entry("sin", new int[] {1, 1}),
          Map.entry("sinh", new int[] {1, 1}),
          Map.entry("sqrt", new int[] {1, 1}),
          Map.entry("starts_with", new int[] {2, 2}),
          Map.entry("tan", new int[] {1, 1}),
          Map.entry("tanh", new int[] {1, 1}),
          Map.entry("trunc", new int[] {1, 1}),
          Map.entry("upper", new int[] {1, 1}),
          Map.entry("at", new int[] {2, 2}),
          Map.entry("count", new int[] {1, 1}),
          Map.entry("join", new int[] {2, 2}),
          Map.entry("mean", new int[] {1, 1}),
          Map.entry("median", new int[] {1, 1}),
          Map.entry("split", new int[] {2, 2}),
          Map.entry("stddev", new int[] {1, 1}),
          Map.entry("sum", new int[] {1, 1}));

  private static final List<String> EXPR_FUNCTION_NAMES =
      List.of(
          "abs", "acos", "acosh", "asin", "asinh", "at", "atan", "atan2", "atanh", "beta",
          "cbrt", "ceil", "contains", "cos", "cosh", "count", "degrees", "digamma", "ends_with",
          "erf", "erfc", "exp", "expm1", "floor", "gamma", "hypot", "is_empty", "join", "len",
          "lgamma", "log", "log10", "log1p", "log2", "lower", "max", "mean", "median", "min",
          "pow", "radians", "round", "sign", "sin", "sinh", "split", "sqrt", "starts_with",
          "stddev", "sum", "tan", "tanh", "trunc", "upper", "zeta");

  /**
   * Not available, and not typos either. Someone writing {@code besselj(_count)} knows what they
   * meant, and "did you mean beta?" is worse than saying nothing. What is left is the mathematics
   * a data generator has no business carrying.
   *
   * <p>Every name here has to be built and pinned to its bits in five languages before it can be
   * offered, which is the only thing keeping it on this list.
   */
  private static final List<String> PLANNED_EXPR_FUNCTIONS =
      List.of("airy", "besselj", "bessely", "elliptic_e", "elliptic_k", "polygamma");

  /**
   * The functions that hand back a list. {@code at} reads one, and nothing else does today; when a
   * second joins, it goes here and the check stays put.
   */
  private static final List<String> LIST_RETURNING_FUNCTIONS = List.of("split");

  private static final List<String> SUPPORTED_UNARY_OPERATORS = List.of("!", "-", "+");

  /** What may sit directly inside {@code <env>}. */
  private static final Set<String> ENV_CHILDREN =
      Set.of(
          "sequence", "mix", "switch", "uniq", "distinct", "pool", "assert", "before", "after",
          "before_block", "after_block", "delimiter_block", "before_line", "after_line",
          "delimiter_line");

  /** Everything a {@code <gen>} may carry, whatever its type. */
  /**
   * Everything a {@code <gen>} may carry, whatever its type.
   *
   * <p>Eight names are deliberately ABSENT: {@code seed}, {@code engine}, {@code version} and
   * {@code inject} belong to {@code <env>} or {@code <tdc>}, {@code uniq} to {@code <sequence>},
   * {@code is} to {@code <case>}, {@code on} to {@code <switch>}, {@code v} to {@code <tdc>}. This
   * was one flat union of every attribute name in the language, so writing any of them on a
   * {@code <gen>} passed in silence here while the reference refused it.
   */
  /** parent= belongs on the <sequence>; count= and flag= belong to other tags entirely. */
  private static final String MISPLACED_GEN_PARENT =
      "parent= selects which rows a whole <sequence> or <mix> builds on; move it there. "
          + "A <gen> inside one is already filtered by it.";

  /** Attributes a &lt;gen&gt; may carry that are not pack parameters. */
  private static final Set<String> NOT_A_PACK_PARAM = Set.of("parent", "count", "flag");

  private static final Set<String> GEN_ATTRS =
      Set.of(
          "type", "value", "name", "if", "comment", "case", "mask", "order", "cycle", "repeat",
          "separator", "missing", "missing_as", "anomaly", "anomaly_factor", "anomaly_flag",
          "local", "weight", "percent", "first_zero", "include", "exclude",
          "accumulate", "of", "plus", "reset", "op", "length", "decimals", "distribution", "regex_max_length", "alphabet",
          "format", "from",
          "to", "oldest", "youngest", "precision", "range", "step", "weekdays", "peak_at", "src",
          "column",
          "header",
          "delimiter", "row", "base", "trend", "period", "amplitude", "noise", "points", "upper",
          "lower", "y_range", "interp", "spread", "ink_threshold", "mode", "in", "on_error",
          "timeout", "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
          "lambda", "n", "s", "beta", "min", "max", "filter");

  private static final Set<String> GEN_TYPES =
      Set.of(
          "text", "file", "template", "number", "regex", "advanced_regex", "symbol", "date",
          "increment", "decrement", "timeseries", "pattern", "http", "pool", "running",
          "stat");

  /**
   * Template paths that are generators rather than pack files.
   *
   * <p>No pack is named after them, so looking them up on disk would report a missing address
   * for the two paths that always work.
   */
  private static final Set<String> BUILTIN_TEMPLATE_PATHS = Set.of("person.b_day", "date.range");

  /** The document versions this runtime understands. */
  private static final String SUPPORTED_VERSION = "0.1.0";

  private final List<Diagnostic> diagnostics = new ArrayList<>();
  private final java.nio.file.Path baseDir;
  private final io.github.nickliapin.tdc.packs.DataPacks packs;
  private int documentRegexMaxLength = RegexGen.DEFAULT_MAX_LENGTH;
  private String locale = "en";

  /**
   * The run length from {@code <env count="…">}. Needed by checks whose answer depends on SIZE
   * rather than shape — a {@code uniq} column costs nothing at a hundred rows and gigabytes at ten
   * million.
   */
  private long envCount = 0;
  /** Every sequence name the config declares — what an interpolation may refer to. */
  private final Set<String> declaredNames = new LinkedHashSet<>();
  /** Those of them that produce a list, which is what each= may walk. */
  private final Set<String> repeatingNames = new LinkedHashSet<>();

  /**
   * Of the declared names, the compounds: every {@code <gen>} named, so the sequence is a group of
   * fields and produces no value of its own — which is what {@code parent=} filters on.
   */
  private final Set<String> valuelessNames = new LinkedHashSet<>();

  /** Sequence names declared at the top level — a pool's members are NOT among them. */
  private final Set<String> envNames = new LinkedHashSet<>();

  /** The sequences declared BEFORE the one being walked — see {@link #checkRunning}. */
  private List<String> declaredOrder = new ArrayList<>();

  /** Field names per pool, gathered before the members are walked. */
  private final Map<String, List<String>> poolFields = new LinkedHashMap<>();

  /** Of those fields, the ones whose value list the config writes down — see TDC225. */
  private final Map<String, Map<String, List<String>>> poolFieldValues = new LinkedHashMap<>();

  /** Every pool a {@code <gen type="pool">} names, gathered before the walk — see TDC231. */
  private final Set<String> poolsRead = new LinkedHashSet<>();

  /** Sequences that draw a whole member: {@code Ref.field} is readable, {@code Ref} is not. */
  private final Set<String> poolReferences = new LinkedHashSet<>();

  /** The member declarations of every pool, by identity — they are scoped to their pool. */
  private final Set<TDCParser.OpenCloseElementContext> poolMemberNodes =
      java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());

  /**
   * Sequences whose produced values are plainly the list in their {@code value=}.
   *
   * <p>Which is what lets {@code if="Gender.Mail"} be caught: the dot on a plain sequence asks
   * about a VALUE, and here the values are known. Only recorded where nothing rewrites them — see
   * {@link #finiteTextValues}.
   */
  private final Map<String, List<String>> finiteValues = new LinkedHashMap<>();

  /**
   * Every {@code if=} seen, where its complaint belongs in the report, and whether the builtins of
   * an {@code each=} line are in scope.
   *
   * <p>The names cannot be checked as the walk passes: an expression may name a sequence declared
   * BELOW it, and the run resolves that happily, so checking mid-walk would invent errors on
   * configs that work.
   */
  private record Pending(int at, String expression, int line, int column, boolean each) {}

  private final List<Pending> pendingExpressions = new ArrayList<>();

  /**
   * A {@code filter=} put aside, and where its complaint belongs in the report.
   *
   * <p>Held back for the same reason an {@code if=} is: the column a filter compares against may
   * be declared BELOW the reference, and the run resolves that happily.
   */
  private record PendingFilter(
      int at, String expression, String pool, String field, String other, int line, int column) {}

  private final List<PendingFilter> pendingPoolFilters = new ArrayList<>();

  private static final java.util.regex.Pattern INTERPOLATION =
      java.util.regex.Pattern.compile("\\$\\{\\{([^}]+)}}");

  /** {@code Pool.field} in a {@code filter=} — the qualified form that says what it means. */
  private static final java.util.regex.Pattern QUALIFIED_NAME =
      java.util.regex.Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)");

  private static final java.util.regex.Pattern PLAIN_NAME =
      java.util.regex.Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");

  private Validator(java.nio.file.Path baseDir, io.github.nickliapin.tdc.packs.DataPacks packs) {
    this.baseDir = baseDir;
    this.packs = packs;
  }

  public static List<Diagnostic> validate(TDCParser.DocumentContext document) {
    return validate(document, null, null);
  }

  /**
   * @param baseDir where a relative {@code src=} resolves from — the config file's own folder.
   */
  public static List<Diagnostic> validate(
      TDCParser.DocumentContext document,
      java.nio.file.Path baseDir,
      io.github.nickliapin.tdc.packs.DataPacks packs) {
    Validator v = new Validator(baseDir, packs);
    v.run(document);
    List<Diagnostic> found = new java.util.ArrayList<>(v.diagnostics);
    // A pack file the address scan read and could not place — TDC171. Reported after the walk
    // because the scan is what the walk's own lookups trigger: asking before it has run would
    // always find nothing.
    if (packs != null) {
      found.addAll(packs.headerWarnings());
    }
    return List.copyOf(found);
  }


  /** The folders a file source may name. Absent packs mean none were configured. */
  private java.util.List<java.nio.file.Path> dataRoots() {
    return packs == null ? java.util.List.of() : packs.dataRoots();
  }

  private void run(TDCParser.DocumentContext document) {
    TDCParser.OpenCloseElementContext tdc = findElement(document, "tdc");
    if (tdc == null) {
      error("TDC001", "document has no <tdc> root element",
          "Wrap your configuration in a single <tdc>…</tdc> root tag.", 1, 0);
      return;
    }

    checkVersion(tdc);
    checkRegexMaxLength(tdc);
    try {
      documentRegexMaxLength = RegexGen.parseMaxLength(attributes(tdc.attr()).get("regex_max_length"));
    } catch (RuntimeException e) {
      documentRegexMaxLength = RegexGen.DEFAULT_MAX_LENGTH;
    }

    TDCParser.OpenCloseElementContext env = findElement(tdc.content(), "env");
    TDCParser.OpenCloseElementContext block = findElement(tdc.content(), "block");
    if (block == null) {
      error("TDC002", "<tdc> has no <block> child — nothing to render",
          "<block> describes the layout of each generated card. Add a <block>…</block> inside <tdc>.",
          line(tdc), column(tdc));
    }

    checkTdcChildren(tdc);
    if (env != null) {
      checkEnv(env);
    }
    if (block != null) {
      checkBlock(block);
    }

    // Two second passes, pools before expressions. Both splice their complaints back at the
    // position the attribute was found, so the report still reads top to bottom; running the pool
    // pass first is what makes the two independent — an expression's recorded position is
    // relative to the walk, and re-splicing it after another pass has inserted would need that
    // pass's shifts as well.
    runPendingPoolFilters();

    // Now that every name is known, the expressions can be checked — and each complaint goes back
    // where its attribute was, so the report stays in source order.
    List<Pending> pending = new ArrayList<>(pendingExpressions);
    pendingExpressions.clear();
    int shift = 0;
    for (Pending item : pending) {
      int before = diagnostics.size();
      checkExpressionNames(item.expression(), item.line(), item.column(), item.each());
      List<Diagnostic> found = new ArrayList<>(diagnostics.subList(before, diagnostics.size()));
      diagnostics.subList(before, diagnostics.size()).clear();
      for (int i = 0; i < found.size(); i++) {
        diagnostics.add(item.at() + shift + i, found.get(i));
      }
      shift += found.size();
    }
  }

  /**
   * {@code <tdc>} holds {@code <env>} and {@code <block>}, and a self-closing spelling of either
   * is refused rather than honoured in part.
   *
   * <p>{@code <env count="3" seed="demo"/>} parses, and then every attribute on it is discarded:
   * the run silently falls back to a default count on a random seed. Half-honouring it is worse
   * than refusing it.
   */
  private void checkTdcChildren(TDCParser.OpenCloseElementContext tdc) {
    // Both containers are read by taking the FIRST of their kind, so a second one is dropped
    // whole — every sequence it declares, every line it lays out — and the run finishes looking
    // healthy while half the config produced nothing. The same silent discard TDC014 refuses for
    // the self-closing spelling, one level up. Reported on the SECOND one: the first is what
    // runs, so the second is the surprise.
    Map<String, Integer> seen = new java.util.HashMap<>();
    for (TDCParser.ElementContext child : tdc.content().element()) {
      TDCParser.OpenCloseElementContext here = child.openCloseElement();
      if (here != null
          && ("env".equals(here.name.getText()) || "block".equals(here.name.getText()))) {
        String tag = here.name.getText();
        int count = seen.merge(tag, 1, Integer::sum);
        if (count > 1) {
          error("TDC270",
              "<tdc> holds more than one <" + tag + "> — only the first is read, and this one is "
                  + "discarded whole",
              "env".equals(tag)
                  ? "Every sequence declared here would be missing at render time. Move them "
                      + "into the first <env>."
                  : "Every line laid out here would be missing from the output. Move them into "
                      + "the first <block>, or use <line if=\"\u2026\"> to switch layouts per row.",
              line(here), column(here));
        }
      }

      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null) {
        String name = self.name.getText();
        if ("env".equals(name) || "block".equals(name)) {
          error("TDC014",
              "<" + name + "/> cannot be self-closing — its attributes and children would be ignored",
              "Write <" + name + "> … </" + name + ">.", line(self), column(self));
          continue;
        }
        error("TDC010", "unknown child of <tdc>: \"<" + name + ">\"",
            "Allowed children: env, block.", line(self), column(self));
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && !TDC_CHILDREN.contains(open.name.getText())) {
        error("TDC010", "unknown child of <tdc>: \"<" + open.name.getText() + ">\"",
            "Allowed children: env, block.", line(open), column(open));
      }
    }
  }

  // ── document ─────────────────────────────────────────────────────────────────────────────

  private void checkVersion(TDCParser.OpenCloseElementContext tdc) {
    checkClosedTagAttrs("tdc", tdc.attr(), line(tdc), column(tdc));
    Map<String, String> attrs = attributes(tdc.attr());
    String versionAttr = attrs.get("version");
    String shortAttr = attrs.get("v");

    if (versionAttr != null && shortAttr != null) {
      error("TDC003", "both \"version\" and \"v\" are present on <tdc>",
          "Use one of them. They mean the same thing.", line(tdc), column(tdc));
      return;
    }
    String raw = versionAttr != null ? versionAttr : shortAttr;
    if (raw == null) {
      return;
    }
    // Any dot-separated numeric version: "0.1", "0.1.0", "1.2.3". Insisting on exactly two
    // parts would reject the version this runtime itself declares.
    if (!raw.trim().matches("^\\d+(?:\\.\\d+)*$")) {
      int[] where = at(tdc, versionAttr != null ? "version" : "v");
      error("TDC004", "invalid TDC document version \"" + raw + "\"",
          "Use dot-separated numeric versions, e.g. \"0.1\", \"0.1.0\", or \"1.2.3\".",
          where[0], where[1]);
      return;
    }
    // A document from the future may use tags this runtime has never heard of, and rendering it
    // as best we can would produce data that is quietly missing whatever it did not understand.
    if (compareVersions(raw, SUPPORTED_VERSION) > 0) {
      int[] where = at(tdc, versionAttr != null ? "version" : "v");
      error("TDC005",
          "document version \"" + raw + "\" is newer than this runtime supports (" + SUPPORTED_VERSION + ")",
          "Update the library, or lower the version attribute.", where[0], where[1]);
    }
  }

  private static int compareVersions(String a, String b) {
    String[] x = a.split("\\.");
    String[] y = b.split("\\.");
    for (int i = 0; i < Math.max(x.length, y.length); i++) {
      int xi = i < x.length ? Integer.parseInt(x[i]) : 0;
      int yi = i < y.length ? Integer.parseInt(y[i]) : 0;
      if (xi != yi) {
        return Integer.compare(xi, yi);
      }
    }
    return 0;
  }

  private void checkRegexMaxLength(TDCParser.OpenCloseElementContext tdc) {
    String raw = attributes(tdc.attr()).get("regex_max_length");
    if (raw == null) {
      return;
    }
    try {
      if (Integer.parseInt(raw.trim()) <= 0) {
        throw new NumberFormatException();
      }
    } catch (NumberFormatException e) {
      error("TDC096", "regex_max_length must be a positive integer, got \"" + raw + "\"",
          "It caps how long a generated regex value may be.", at(tdc, "regex_max_length")[0], at(tdc, "regex_max_length")[1]);
    }
  }

  // ── env ──────────────────────────────────────────────────────────────────────────────────

  // ── a share below one whole row ───────────────────────────────────────────────────────────

  /**
   * A {@code percent} share that asks for less than one whole row.
   *
   * <p>{@code percent} is an exact quota over the rows that reach it, not a chance rolled per
   * row. Ten percent of a five-row subset asks for HALF a record, and half a record cannot be
   * emitted — so the branch produces one or none and the seed alone decides which. The engine
   * rounds and says nothing, which is how a column that came out empty reads as a config that was
   * never written rather than one that rounded away.
   *
   * <p>The denominator is knowable for the shapes people write: {@code count} at the top of
   * {@code <env>}, {@code count} × a parent's share, or {@code count} × the share a
   * {@code <switch>} branch matches. Where the subject writes no shares of its own this stays
   * SILENT — a check that guessed would fire on working configs and be turned off.
   */
  private void checkSmallShares(TDCParser.OpenCloseElementContext env) {
    if (envCount <= 0) {
      return;
    }
    Map<String, Map<String, Double>> shares = new LinkedHashMap<>();

    for (TDCParser.OpenCloseElementContext child : openChildren(env)) {
      switch (child.name.getText()) {
        case "sequence" -> readSequenceShares(child, shares);
        case "mix" -> reportThin(
            child, branchCount(child), rowsOf(attributes(child.attr()).get("parent"), shares));
        case "switch" -> readSwitchShares(child, shares);
        default -> { }
      }
    }
  }

  /** Record what a sequence's values are worth, and check its own share. */
  private void readSequenceShares(
      TDCParser.OpenCloseElementContext seq, Map<String, Map<String, Double>> shares) {
    Map<String, String> seqAttrs = attributes(seq.attr());
    Double rows = rowsOf(seqAttrs.get("parent"), shares);

    // A `<gen …/>` is SELF-CLOSING, and one written as `<gen …></gen>` is not. Both are the
    // sequence's generator, so both are collected: reading only one kind found nothing at all.
    List<org.antlr.v4.runtime.ParserRuleContext> gens = new ArrayList<>();
    List<Map<String, String>> genAttrs = new ArrayList<>();
    if (seq.content() != null) {
      for (TDCParser.ElementContext c : seq.content().element()) {
        TDCParser.SelfClosingElementContext self = c.selfClosingElement();
        TDCParser.OpenCloseElementContext open = c.openCloseElement();
        if (self != null && "gen".equals(self.name.getText())) {
          gens.add(self);
          genAttrs.add(attributes(self.attr()));
        } else if (open != null && "gen".equals(open.name.getText())) {
          gens.add(open);
          genAttrs.add(attributes(open.attr()));
        }
      }
    }
    if (gens.size() != 1) {
      return;
    }
    Map<String, String> attrs = genAttrs.get(0);
    if (!"text".equals(attrs.get("type"))) {
      return;
    }

    List<String> values = new ArrayList<>();
    for (String v : (attrs.getOrDefault("value", "")).split(",", -1)) {
      if (!v.trim().isEmpty()) {
        values.add(v.trim());
      }
    }
    String mask = attrs.get("percent");
    if (values.isEmpty() || mask == null) {
      return;
    }
    double[] percents = safeExpand(mask, values.size());
    if (percents == null) {
      return;
    }

    String name = seqAttrs.get("name");
    if (name != null && !name.isEmpty() && rows != null) {
      Map<String, Double> table = new LinkedHashMap<>();
      for (int i = 0; i < values.size(); i++) {
        table.put(values.get(i), percents[i] / 100);
      }
      shares.put(name, table);
    }

    reportThinAttrs(attrs, gens.get(0), values.size(), rows);
  }

  /** Each {@code <case is="X">}, with the rows that value takes. */
  private void readSwitchShares(
      TDCParser.OpenCloseElementContext switchEl, Map<String, Map<String, Double>> shares) {
    String subject = attributes(switchEl.attr()).get("on");
    Map<String, Double> table = subject == null ? null : shares.get(subject);
    if (table == null) {
      return;
    }

    for (TDCParser.OpenCloseElementContext caseEl : openChildren(switchEl)) {
      if (!"case".equals(caseEl.name.getText())) {
        continue;
      }
      String is = attributes(caseEl.attr()).get("is");
      if (is == null) {
        continue;
      }
      // `is="US|CA"` matches either, so the branch takes both their shares.
      double fraction = 0;
      boolean known = true;
      for (String key : is.split("\\|", -1)) {
        Double share = table.get(key.trim());
        if (share == null) {
          known = false;
        } else {
          fraction += share;
        }
      }
      if (!known) {
        continue;
      }
      for (TDCParser.OpenCloseElementContext inner : openChildren(caseEl)) {
        if ("mix".equals(inner.name.getText())) {
          reportThin(inner, branchCount(inner), envCount * fraction);
        }
      }
    }
  }

  /** How many {@code <case>} branches a {@code <mix>} holds. */
  private static int branchCount(TDCParser.OpenCloseElementContext mix) {
    int n = 0;
    for (TDCParser.OpenCloseElementContext c : openChildren(mix)) {
      if ("case".equals(c.name.getText())) {
        n++;
      }
    }
    return n;
  }

  /** Rows reaching something with this {@code parent}, or null when unresolvable. */
  private Double rowsOf(String parent, Map<String, Map<String, Double>> shares) {
    if (parent == null || parent.trim().isEmpty()) {
      return (double) envCount;
    }
    int at = parent.indexOf('.');
    if (at < 0) {
      return null;
    }
    Map<String, Double> table = shares.get(parent.substring(0, at));
    Double share = table == null ? null : table.get(parent.substring(at + 1));
    return share == null ? null : envCount * share;
  }

  /** The mask, or null when it does not parse — somebody else's diagnostic. */
  private static double[] safeExpand(String mask, int values) {
    try {
      return PercentMask.expand(mask, values);
    } catch (RuntimeException e) {
      return null;
    }
  }

  private void reportThin(
      TDCParser.OpenCloseElementContext el, int branches, Double rows) {
    reportThinAttrs(attributes(el.attr()), el, branches, rows);
  }

  /** Report the smallest share that asks for less than a row, once per element. */
  private void reportThinAttrs(
      Map<String, String> own, org.antlr.v4.runtime.ParserRuleContext el, int branches,
      Double rows) {
    if (rows == null || rows <= 0 || branches <= 0) {
      return;
    }
    String mask = own.get("percent");
    if (mask == null) {
      return;
    }
    // `repeat=` plans the quota over ELEMENTS, not rows: three per row over four rows is twelve
    // draws, and `repeat="1..3"` does not even fix how many. Rows is the wrong denominator here,
    // so say nothing.
    if (!own.getOrDefault("repeat", "").trim().isEmpty()) {
      return;
    }
    double[] percents = safeExpand(mask, branches);
    if (percents == null) {
      return;
    }

    Double worst = null;
    for (double percent : percents) {
      if (percent <= 0) {
        continue; // a zero share asks for nothing on purpose
      }
      if (percent / 100 * rows >= 1) {
        continue;
      }
      if (worst == null || percent < worst) {
        worst = percent;
      }
    }
    if (worst == null) {
      return;
    }

    warn("TDC251",
        "percent=\"" + twoPlaces(worst) + "\" over " + twoPlaces(rows) + " rows asks for "
            + twoPlaces(worst / 100 * rows)
            + " records — the result is 0 or 1, and the seed decides which",
        "A share below one whole row cannot be emitted, so the branch fires once or not at all. "
            + "Raise the share, or raise count= until the share covers a whole row.",
        el.getStart().getLine(), el.getStart().getCharPositionInLine());
  }

  /** Every child that is an open-close tag, in source order. */
  private static List<TDCParser.OpenCloseElementContext> openChildren(
      TDCParser.OpenCloseElementContext parent) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    if (parent.content() == null) {
      return out;
    }
    for (TDCParser.ElementContext c : parent.content().element()) {
      TDCParser.OpenCloseElementContext el = c.openCloseElement();
      if (el != null) {
        out.add(el);
      }
    }
    return out;
  }

  /** Two decimals at most, and no trailing zeros — {@code 0.5}, not {@code 0.50}. */
  private static String twoPlaces(double value) {
    double rounded = Math.round(value * 100) / 100.0;
    return rounded == Math.rint(rounded)
        ? String.valueOf((long) rounded)
        : String.valueOf(rounded);
  }

  private void checkEnv(TDCParser.OpenCloseElementContext env) {
    Map<String, String> envAttrs = attributes(env.attr());
    locale = envAttrs.getOrDefault("local", "en");

    String count = envAttrs.get("count");
    if (count != null) {
      try {
        if (Integer.parseInt(count.trim()) < 0) {
          throw new NumberFormatException();
        }
        envCount = Long.parseLong(count.trim());
      } catch (NumberFormatException e) {
        error("TDC020", "invalid count \"" + count + "\" — expected a non-negative integer",
            "count is how many records to generate.", at(env, "count")[0], at(env, "count")[1]);
      }
    }

    // The renderer splits on `(.+)%(.+)`, so the pattern needs a `%` with something on BOTH
    // sides. Counting the `%` alone let "%%" and "%x" through: they have one, they cannot be
    // split, and the renderer quietly stopped interpolating.
    String inject = envAttrs.get("inject");
    if (inject != null && !java.util.regex.Pattern.compile("(.+)%(.+)").matcher(inject).find()) {
      error("TDC021",
          inject.contains("%")
              ? "inject pattern \"" + inject
                  + "\" has nothing on both sides of its \"%\" — interpolation will never match"
              : "inject pattern \"" + inject
                  + "\" has no \"%\" placeholder — interpolation will never match",
          "The `%` is where the sequence name goes, and it needs an opening and a closing part "
              + "around it: inject=\"${{%}}\", inject=\"[%]\", inject=\"%{%}%\".",
          at(env, "inject")[0], at(env, "inject")[1]);
    }

    // A share below one whole row: its own pass, because the denominator of a <mix> in a
    // switch branch belongs to the switch and not to the walk that follows.
    checkSmallShares(env);

    // Pools first, and only their shape: a reference may stand above the pool it names, and
    // complaining about an unknown field in that case would report the wrong problem.
    collectPoolFields(env);
    collectPoolFieldValues(env);
    collectPoolReferences(env);
    checkChildren(env.content(), "env", ENV_CHILDREN);
    checkAsserts(env);
    for (TDCParser.ElementContext c : env.content().element()) {
      TDCParser.OpenCloseElementContext el = c.openCloseElement();
      if (el == null) {
        continue;
      }
      String tag = el.name.getText();
      if (FIXTURE_TAG_NAMES.contains(tag)) {
        // A fixture holds text and <line>s; anything else was ignored in silence.
        checkChildren(el.content(), tag, FIXTURE_CHILDREN, "TDC131", FIXTURE_CHILDREN);
      } else if ("pool".equals(tag)) {
        // Tags with a reason of their own keep TDC230, which says far more; they pass
        // this check but are never offered as allowed.
        Set<String> passes = new java.util.HashSet<>(POOL_CHILDREN);
        for (TDCParser.ElementContext inner : el.content().element()) {
          TDCParser.OpenCloseElementContext io = inner.openCloseElement();
          TDCParser.SelfClosingElementContext is = inner.selfClosingElement();
          String n = io != null ? io.name.getText() : (is != null ? is.name.getText() : null);
          if (n != null && forbiddenInPool(n) != null) {
            passes.add(n);
          }
        }
        checkChildren(el.content(), "pool", passes, "TDC010", POOL_CHILDREN);
      }
    }
    checkClosedTagAttrs("env", env.attr(), line(env), column(env));

    Set<String> names = new LinkedHashSet<>();
    List<String> declared = new ArrayList<>();
    declaredOrder = declared;

    for (TDCParser.OpenCloseElementContext open : declarations(env)) {
      String tag = open.name.getText();
      checkClosedTagAttrs(tag, open.attr(), line(open), column(open));
      Map<String, String> attrs = attributes(open.attr());
      String name = attrs.get("name");
      if (name == null || name.isBlank()) {
        error("TDC030", "<" + tag + "> is missing a required \"name\" attribute",
            "A sequence is referenced by name, so it needs one.", line(open), column(open));
      } else if (Checks.isBuiltin(name)) {
        error("TDC033", "sequence name \"" + name + "\" collides with a builtin",
            "Builtins: " + String.join(", ", new java.util.TreeSet<>(Checks.BUILTINS)) + ".",
            at(open, "name")[0], at(open, "name")[1]);
      } else if (name.startsWith("_")) {
        // The leading underscore is the engine's namespace. Letting a config into it means a
        // future builtin would silently shadow somebody's column.
        error("TDC031", "sequence name \"" + name + "\" starts with \"_\" — reserved for builtins",
            "User sequences should avoid the leading underscore.", at(open, "name")[0], at(open, "name")[1]);
      } else if (!poolMemberNodes.contains(open) && !names.add(name)) {
        error("TDC032", "duplicate sequence name \"" + name + "\"",
            "Two sequences cannot share a name — the second would shadow the first.",
            at(open, "name")[0], at(open, "name")[1]);
      }

      // Declaration order decides who can filter whom: a parent must already exist, because the
      // rows it selects are what the child is built over.
      String parent = attrs.get("parent");
      if (parent != null && !parent.isBlank()) {
        String parentName = parent.contains(".") ? parent.substring(0, parent.indexOf('.')) : parent;
        if (parentName.isEmpty()) {
          error("TDC034", "invalid parent reference \"" + parent + "\"",
              "Syntax: parent=\"ParentName\" or parent=\"ParentName.Value\".",
              at(open, "parent")[0], at(open, "parent")[1]);
        } else if (!declared.contains(parentName)) {
          error("TDC035", "parent sequence \"" + parentName + "\" is not declared before this sequence",
              "Move the parent above it. A child is built over the rows its parent selected.",
              at(open, "parent")[0], at(open, "parent")[1]);
        } else if (valuelessNames.contains(parentName)) {
          // A parent selects rows by the VALUE it produced. A compound is a group of fields and
          // produces none, so no row can ever match — the run used to discover that and report the
          // parent as unknown, sending the reader after a name that is declared right above.
          error("TDC214",
              "compound sequence \"" + parentName + "\" has no value of its own to filter on",
              "A parent is chosen by the value it produced, e.g. parent=\"Gender.Male\". \""
                  + parentName + "\" is a group of fields and produces none — name one of its "
                  + "fields, or a sequence that has a single value.",
              at(open, "parent")[0], at(open, "parent")[1]);
        }
      }

      if ("switch".equals(tag)) {
        checkSwitch(open, declared);
      } else if ("mix".equals(tag)) {
        checkMix(open);
      } else if ("sequence".equals(tag)) {
        // Size, not shape: what this column will COST at this run length.
        checkUniqMemory(open, name);
        checkSequenceBody(open, name);
        checkSequenceDataAttrs(open);
        checkComputeBody(open);
      }
      for (TDCParser.ElementContext inner : open.content().element()) {
        checkGensIn(inner);
      }

      if (name != null && !name.isBlank()) {
        declared.add(name);
        declaredNames.add(name);
        if (!poolMemberNodes.contains(open)) {
          envNames.add(name);
          registerPoolReference(open, name);
        }
        // A compound's fields are referenced as Name.Field, and a flag column is a name too.
        // Fields inside a <distinct> wrapper are ordinary fields, so they count as well.
        collectFieldNames(open, name);
        String flag = attrs.get("flag");
        if (flag != null && !flag.isBlank()) {
          declaredNames.add(flag);
        }
        String anomalyFlag = attrs.get("anomaly_flag");
        if (anomalyFlag != null && !anomalyFlag.isBlank()) {
          declaredNames.add(anomalyFlag);
        }
      }
    }
  }

  /**
   * Every sequence-like declaration in {@code <env>}, in the order they appear.
   *
   * <p>A {@code <uniq>} or {@code <distinct>} wrapper is not a declaration of its own — it says
   * what must hold between the sequences inside it. So its children are flattened into the same
   * list, and each is checked, named and ordered exactly as if it had been written directly under
   * {@code <env>}. Anything else would make wrapping a sequence change what the sequence is.
   */
  private List<TDCParser.OpenCloseElementContext> declarations(
      TDCParser.OpenCloseElementContext env) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    List<String> poolsAbove = new ArrayList<>();
    for (TDCParser.ElementContext child : env.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null) {
        continue;
      }
      String tag = open.name.getText();
      if ("sequence".equals(tag) || "mix".equals(tag) || "switch".equals(tag)) {
        out.add(open);
      } else if ("pool".equals(tag)) {
        // A pool node is not a declaration, so the env walk never reached its own attributes —
        // every one of them, including a typo, used to pass in silence.
        checkClosedTagAttrs("pool", open.attr(), line(open), column(open));
        // A pool's members are declarations too — checked exactly as at the top level — but its
        // names are ITS columns, not the run's, so they are recorded separately and kept out of
        // the shared namespace.
        checkPool(open);
        // Only the pools ALREADY seen: a member may draw from one of those and from nothing
        // else, which is what makes a cycle unwritable.
        checkPoolMemberRefs(open, poolsAbove);
        String declaredPool = attributes(open.attr()).get("name");
        if (declaredPool != null && !declaredPool.isBlank()) {
          if (poolsAbove.contains(declaredPool)) {
            // The second pool quietly replaced the first, and the only sign was a TDC193
            // in the block about a field that "does not exist".
            error(
                "TDC241",
                "duplicate pool name \"" + declaredPool + "\"",
                "A pool is reached by name, so two of them cannot share one. Rename or remove the second.",
                line(open), column(open));
          } else {
            poolsAbove.add(declaredPool);
          }
        }
        checkPoolIsRead(open);
        out.addAll(poolMembers(open));
      } else if ("uniq".equals(tag) || "distinct".equals(tag)) {
        // A group wrapper is not a declaration either — same gap, same fix.
        checkClosedTagAttrs(tag, open.attr(), line(open), column(open));
        int members = 0;
        for (TDCParser.ElementContext inner : open.content().element()) {
          TDCParser.OpenCloseElementContext wrapped = inner.openCloseElement();
          if (wrapped == null) {
            continue;
          }
          // A <mix> inside the group is a member and a declaration both — without this its name
          // never exists and every reference to it reads as undeclared.
          if ("mix".equals(wrapped.name.getText())
              || "switch".equals(wrapped.name.getText())) {
            members++;
            out.add(wrapped);
          } else if ("sequence".equals(wrapped.name.getText())) {
            members++;
            checkEnvGroupMember(wrapped, tag);
            out.add(wrapped);
          }
        }
        checkGroupSize(open, tag, members);
      }
    }
    return out;
  }

  /** The member declarations of one pool, flattened out of any {@code <uniq>} wrapper. */
  private List<TDCParser.OpenCloseElementContext> poolMembers(
      TDCParser.OpenCloseElementContext pool) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    for (TDCParser.ElementContext member : pool.content().element()) {
      TDCParser.OpenCloseElementContext inner = member.openCloseElement();
      if (inner == null) {
        continue;
      }
      String tag = inner.name.getText();
      if (isDeclarationTag(tag)) {
        poolMemberNodes.add(inner);
        out.add(inner);
      } else if ("uniq".equals(tag) || "distinct".equals(tag)) {
        int wrapped = 0;
        for (TDCParser.ElementContext w : inner.content().element()) {
          TDCParser.OpenCloseElementContext node = w.openCloseElement();
          if (node == null || !isDeclarationTag(node.name.getText())) {
            continue;
          }
          wrapped++;
          poolMemberNodes.add(node);
          out.add(node);
        }
        checkGroupSize(inner, tag, wrapped);
      }
    }
    return out;
  }

  private static boolean isDeclarationTag(String tag) {
    return "sequence".equals(tag) || "mix".equals(tag) || "switch".equals(tag);
  }

  /** Field names per pool, gathered before the members are walked. */
  private void collectPoolFields(TDCParser.OpenCloseElementContext env) {
    for (TDCParser.ElementContext child : env.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null || !"pool".equals(open.name.getText())) {
        continue;
      }
      String name = attributes(open.attr()).get("name");
      if (name == null || name.isBlank()) {
        continue;
      }
      List<String> fields = new ArrayList<>();
      for (TDCParser.ElementContext member : open.content().element()) {
        TDCParser.OpenCloseElementContext inner = member.openCloseElement();
        if (inner == null) {
          continue;
        }
        String tag = inner.name.getText();
        if (isDeclarationTag(tag)) {
          addFieldName(fields, inner);
        } else if ("uniq".equals(tag) || "distinct".equals(tag)) {
          for (TDCParser.ElementContext w : inner.content().element()) {
            TDCParser.OpenCloseElementContext wrapped = w.openCloseElement();
            if (wrapped != null) {
              addFieldName(fields, wrapped);
            }
          }
        }
      }
      poolFields.put(name, fields);
    }
  }

  /**
   * The values each pool field can hold, where the config says them outright.
   *
   * <p>A member whose body is one unnamed {@code <gen type="text" value="A,B">} produces nothing
   * but {@code A} and {@code B}, so the set recorded here is a SUPERSET of what the built pool
   * will hold — a pool of two members drawn from three values holds at most two of them. That
   * direction is what TDC225 needs: a value outside the superset can match no member, whatever
   * the draw turns out to be.
   */
  private void collectPoolFieldValues(TDCParser.OpenCloseElementContext env) {
    for (TDCParser.ElementContext child : env.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null || !"pool".equals(open.name.getText())) {
        continue;
      }
      String name = attributes(open.attr()).get("name");
      if (name == null || name.isBlank()) {
        continue;
      }
      Map<String, List<String>> fields = new LinkedHashMap<>();
      for (TDCParser.OpenCloseElementContext member : poolMemberNodesOf(open)) {
        String field = attributes(member.attr()).get("name");
        if (field == null || field.isBlank()) {
          continue;
        }
        List<String> values = literalTextValues(member);
        if (values != null) {
          fields.put(field, values);
        }
      }
      poolFieldValues.put(name, fields);
    }
  }

  /** Every declaration inside a pool, flattened, without recording it as a member node. */
  private List<TDCParser.OpenCloseElementContext> poolMemberNodesOf(
      TDCParser.OpenCloseElementContext pool) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    for (TDCParser.ElementContext member : pool.content().element()) {
      TDCParser.OpenCloseElementContext inner = member.openCloseElement();
      if (inner == null) {
        continue;
      }
      String tag = inner.name.getText();
      if (isDeclarationTag(tag)) {
        out.add(inner);
      } else if ("uniq".equals(tag) || "distinct".equals(tag)) {
        for (TDCParser.ElementContext w : inner.content().element()) {
          TDCParser.OpenCloseElementContext node = w.openCloseElement();
          if (node != null && isDeclarationTag(node.name.getText())) {
            out.add(node);
          }
        }
      }
    }
    return out;
  }

  /** The literal {@code value=} list of a member whose body is a single plain text gen. */
  private static List<String> literalTextValues(TDCParser.OpenCloseElementContext member) {
    List<Map<String, String>> gens = new ArrayList<>();
    for (TDCParser.ElementContext child : member.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      String tag = self != null ? self.name.getText() : open == null ? null : open.name.getText();
      if ("gen".equals(tag)) {
        gens.add(self != null ? attributes(self.attr()) : attributes(open.attr()));
      }
    }
    if (gens.size() != 1 || gens.get(0).containsKey("name")) {
      return null;
    }
    return finiteTextValues(gens.get(0));
  }

  /**
   * Every pool named by a {@code <gen type="pool" value="…">}, anywhere under {@code <env>}.
   *
   * <p>Collected in one descent rather than tallied during the walk, because a reference may stand
   * above the pool it names and TDC231 has to know about it by the time that pool is reached.
   */
  private void collectPoolReferences(TDCParser.OpenCloseElementContext node) {
    for (TDCParser.ElementContext child : node.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      String tag = self != null ? self.name.getText() : open == null ? null : open.name.getText();
      if (tag == null) {
        continue;
      }
      if ("gen".equals(tag)) {
        Map<String, String> attrs =
            self != null ? attributes(self.attr()) : attributes(open.attr());
        if ("pool".equals(attrs.get("type"))) {
          poolsRead.add(attrs.getOrDefault("value", "").trim());
        }
        continue;
      }
      if (open != null) {
        collectPoolReferences(open);
      }
    }
  }

  /**
   * A pool nobody draws from.
   *
   * <p>A warning rather than an error, on the same reasoning as TDC234: the config runs, and every
   * row is exactly what it would have been. What it costs is the build — a pool is computed in
   * full before the first row and held in memory for the whole run — so an unread {@code
   * count="50000"} is paid for and thrown away. It is also the shape a rename leaves behind, where
   * the reference points at a new pool and the old one sits there looking deliberate.
   */
  private void checkPoolIsRead(TDCParser.OpenCloseElementContext pool) {
    String name = attributes(pool.attr()).get("name");
    if (name == null || name.isBlank() || poolsRead.contains(name)) {
      return;
    }
    warn("TDC231",
        "pool \"" + name + "\" is never drawn from",
        "A pool is built in full before the first row and kept in memory for the whole run, so an "
            + "unread one costs its members for nothing. Read it with <gen type=\"pool\" value=\""
            + name + "\"/>, or remove it.",
        line(pool), column(pool));
  }

  /**
   * What one member contributes to its pool's field list.
   *
   * <p>Usually its own name. A member that is itself a reference to another pool contributes that
   * pool's fields under its name instead — {@code at} pointing at {@code Clinics} gives {@code
   * at.city}, and no bare {@code at}, because a record has no value to print. Only pools declared
   * ABOVE are visible, which is exactly what the engine can compute.
   */
  private void addFieldName(List<String> fields, TDCParser.OpenCloseElementContext node) {
    String field = attributes(node.attr()).get("name");
    if (field == null || field.isBlank()) {
      return;
    }
    String target = memberPoolRef(node);
    List<String> nested = target == null ? null : poolFields.get(target);
    if (nested == null) {
      fields.add(field);
      return;
    }
    for (String inner : nested) {
      fields.add(field + "." + inner);
    }
  }

  /**
   * A member that draws from another pool may only name a pool declared ABOVE.
   *
   * <p>The engine builds pools in declaration order, so this is not a style rule: a pool named
   * below has no table yet when this one is computed, and a pool naming itself never would. Both
   * used to pass validation and produce a member with no fields, which surfaced far away as "not a
   * field of R" — blaming the line that reads for a mistake made in the declaration.
   *
   * <p>Declaration order is also the entire cycle check: a cycle cannot be written down.
   */
  private void checkPoolMemberRefs(
      TDCParser.OpenCloseElementContext pool, List<String> above) {
    String poolName = attributes(pool.attr()).getOrDefault("name", "");
    for (TDCParser.OpenCloseElementContext member : poolMembers(pool)) {
      String target = memberPoolRef(member);
      if (target == null || above.contains(target)) {
        continue;
      }
      boolean itself = target.equals(poolName);
      String message =
          itself
              ? "pool \"" + poolName + "\" draws from itself"
              : "pool \"" + poolName + "\" draws from \"" + target
                  + "\", which is not declared above it";
      String hint =
          itself
              ? "A pool is built before its own members exist, so there is nothing to draw. "
              : "Pools are built in declaration order, so a pool can only read the pools above "
                  + "it. Move \"" + target + "\" above \"" + poolName + "\". ";
      error(
          "TDC236",
          message,
          hint + "That order is also why a cycle between pools cannot be written down.",
          line(member),
          column(member));
    }
  }

  /** The pool a member draws from, when the member is a {@code <gen type="pool">}. */
  private static String memberPoolRef(TDCParser.OpenCloseElementContext node) {
    for (TDCParser.ElementContext child : node.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      String tag = self != null ? self.name.getText() : open == null ? null : open.name.getText();
      if (!"gen".equals(tag)) {
        continue;
      }
      Map<String, String> attrs = self != null ? attributes(self.attr()) : attributes(open.attr());
      if (!"pool".equals(attrs.get("type"))) {
        continue;
      }
      return attrs.getOrDefault("value", "").trim();
    }
    return null;
  }

  /**
   * A {@code <pool>}'s own attributes and the tags it may hold.
   *
   * <p>What is inside a legal child is NOT checked here — the pool's members go through the same
   * checks the top level gets, which is the whole point of the construct.
   */
  private void checkPool(TDCParser.OpenCloseElementContext node) {
    Map<String, String> attrs = attributes(node.attr());
    int line = line(node);
    int column = column(node);
    String name = attrs.get("name");
    if (name == null || name.isBlank()) {
      error("TDC222", "<pool> has no name",
          "A pool is read by name: <pool name=\"Doctors\" count=\"30\">, then "
              + "<gen type=\"pool\" value=\"Doctors\"/>.",
          line, column);
    }

    String raw = attrs.get("count");
    if (raw == null || raw.isBlank()) {
      String shown = name == null || name.isBlank() ? "" : " name=\"" + name + "\"";
      error("TDC222", "<pool" + shown + "> has no count",
          "count is how many members the table holds — thirty doctors for two thousand "
              + "patients: count=\"30\".",
          line, column);
    } else {
      checkPoolCount(raw, line, column);
    }

    for (TDCParser.ElementContext child : node.content().element()) {
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      String reason = inner == null ? null : forbiddenInPool(inner.name.getText());
      if (reason == null) {
        continue;
      }
      error("TDC230", "<" + inner.name.getText() + "> cannot live inside a <pool>", reason + ".",
          line(inner), column(inner));
    }
  }

  /** A pool that is far too big is a typo for the ROW count often enough to be worth saying. */
  private void checkPoolCount(String raw, int line, int column) {
    long count;
    try {
      count = Long.parseLong(raw.trim());
    } catch (NumberFormatException e) {
      count = 0;
    }
    if (count < 1) {
      error("TDC223", "<pool> count \"" + raw + "\" is not a whole number of members",
          "Use a whole number of at least 1 — a pool of nothing has no member to hand out.",
          line, column);
    } else if (count > Pool.MAX_MEMBERS) {
      error("TDC235",
          "<pool> holds " + grouped(count) + " members — more than the "
              + grouped(Pool.MAX_MEMBERS) + " a pool may hold",
          "A pool is kept in memory for the whole run (measured: ~320 bytes a member with four "
              + "fields), so this would cost hundreds of megabytes before the first row. If you "
              + "meant the number of ROWS, that is count on <env>.",
          line, column);
    } else if (count > Pool.WARN_MEMBERS) {
      warn("TDC234",
          "<pool> holds " + grouped(count) + " members and stays in memory for the whole run",
          "Measured at ~320 bytes a member with four fields — 100,000 members cost about 29 MB. "
              + "It works; it is worth being deliberate about. If you meant the number of ROWS, "
              + "that is count on <env>.",
          line, column);
    }
  }

  private static String grouped(long value) {
    return String.format(java.util.Locale.ROOT, "%,d", value);
  }

  private static String forbiddenInPool(String tag) {
    return switch (tag) {
      case "block" -> "a pool has no output of its own — it is a table other columns read";
      case "before", "after", "before_block", "after_block", "delimiter_block", "before_line",
          "after_line", "delimiter_line" ->
          "fixtures describe a file, and a pool is not written to one";
      case "pool" -> "a pool stays a flat table — point one pool at another instead of nesting them";
      default -> null;
    };
  }

  /** Publish {@code Ref.field} for a {@code <gen type="pool">}. */
  private void registerPoolReference(TDCParser.OpenCloseElementContext sequence, String name) {
    for (TDCParser.ElementContext child : sequence.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      String tag = self != null ? self.name.getText() : open == null ? null : open.name.getText();
      if (!"gen".equals(tag)) {
        continue;
      }
      Map<String, String> attrs =
          self != null ? attributes(self.attr()) : attributes(open.attr());
      if (!"pool".equals(attrs.get("type"))) {
        continue;
      }
      int line = self != null ? line(self) : line(open);
      int column = self != null ? column(self) : column(open);
      String poolName = attrs.getOrDefault("value", "").trim();
      List<String> fields = poolFields.get(poolName);
      if (fields == null) {
        error("TDC224",
            "<gen type=\"pool\"> draws from \"" + poolName + "\", which is not a declared pool",
            poolFields.isEmpty()
                ? "Declare it first: <pool name=\"…\" count=\"…\"> inside the same <env>."
                : "Declared pools: " + String.join(", ", new java.util.TreeSet<>(poolFields.keySet()))
                    + ".",
            line, column);
        continue;
      }
      checkPoolFilter(attrs, poolName, fields, line, column);
      for (String field : fields) {
        declaredNames.add(name + "." + field);
      }
      // The reference itself is a record, not a value: nothing to print.
      valuelessNames.add(name);
      poolReferences.add(name);
    }
  }

  /**
   * What {@code filter=} may name.
   *
   * <p>A qualified {@code Pool.field} says exactly what it means, so a field the pool has not got
   * is a certain mistake. An UNQUALIFIED unknown name is left alone: the expression language reads
   * a bare word as a string literal, which is how {@code filter="c == North"} says "northern only".
   */
  private void checkPoolFilter(
      Map<String, String> attrs, String poolName, List<String> fields, int line, int column) {
    String expression = attrs.get("filter");
    if (expression == null || expression.isBlank()) {
      return;
    }
    java.util.regex.Matcher dotted = QUALIFIED_NAME.matcher(expression);
    while (dotted.find()) {
      if (!dotted.group(1).equals(poolName) || fields.contains(dotted.group(2))) {
        continue;
      }
      error("TDC226",
          "filter= reads \"" + dotted.group() + "\", but pool \"" + poolName
              + "\" has no field \"" + dotted.group(2) + "\"",
          fields.isEmpty()
              ? "Pool \"" + poolName + "\" declares no fields."
              : "Fields of \"" + poolName + "\": " + String.join(", ", fields) + ".",
          line, column);
    }

    Set<String> seen = new LinkedHashSet<>();
    java.util.regex.Matcher plain = PLAIN_NAME.matcher(expression);
    while (plain.find()) {
      String word = plain.group();
      if (!seen.add(word) || !fields.contains(word) || !envNames.contains(word)) {
        continue;
      }
      error("TDC232",
          "\"" + word + "\" in filter= is both a field of pool \"" + poolName
              + "\" and a sequence — which one is meant is not decidable",
          "Rename one of them. Qualifying one side (\"" + poolName + "." + word
              + "\") does not help: the other \"" + word + "\" still reads as the member's field, "
              + "so the test would compare a value with itself.",
          line, column);
    }

    // `field == Something` — the one filter shape a check can decide, recognised the same way the
    // engine's fast path recognises it, by looking at the text rather than a parsed tree, so what
    // the reader sees and what is checked are the same thing.
    String[] sides = expression.split("==", -1);
    if (sides.length != 2) {
      return;
    }
    String left = sides[0].trim();
    String right = sides[1].trim();
    if (!PLAIN_NAME.matcher(left).matches() || !PLAIN_NAME.matcher(right).matches()) {
      return;
    }
    boolean leftIsField = fields.contains(left);
    boolean rightIsField = fields.contains(right);
    // Both sides a field compares the candidate with itself, which is a different mistake.
    if (leftIsField == rightIsField) {
      return;
    }
    pendingPoolFilters.add(new PendingFilter(
        diagnostics.size(), expression.trim(), poolName,
        leftIsField ? left : right, leftIsField ? right : left, line, column));
  }

  /**
   * The put-aside filters, decided now that every column is known.
   *
   * <p>What can be said before a single value exists: the member's field and the other side of the
   * {@code ==} each draw from a set the config writes down, and when those two sets do not overlap
   * the filter can never match — not on some row, on every row. The run already refuses that, on
   * row one, after building the pool; saying it at check time costs nothing and names both lists.
   *
   * <p>Only DISJOINT sets are reported. A value that is merely rare is a refusal waiting for the
   * row that draws it, and reporting it here would also refuse {@code percent="100,0"}, which
   * never draws that value at all.
   */
  private void runPendingPoolFilters() {
    List<PendingFilter> pending = new ArrayList<>(pendingPoolFilters);
    pendingPoolFilters.clear();
    int shift = 0;
    for (PendingFilter item : pending) {
      Map<String, List<String>> byField = poolFieldValues.get(item.pool());
      List<String> fieldValues = byField == null ? null : byField.get(item.field());
      if (fieldValues == null || fieldValues.isEmpty()) {
        continue;
      }
      // A name no sequence has is a bare word, and the expression language reads a bare word as
      // its own text — that is how filter="clinic == North" says "northern only". So it is a set
      // of exactly one value.
      boolean isColumn = declaredNames.contains(item.other());
      List<String> otherValues =
          isColumn ? finiteValues.get(item.other()) : List.of(item.other());
      if (otherValues == null || otherValues.isEmpty()) {
        continue;
      }
      // Compared the way `==` compares two texts, so the check cannot refuse a config the run
      // would have answered. Raw text refused `code == Want` where the members hold 01,02,03 and
      // the column produces 1,2,3 — the same question written with one extra term matched every
      // row.
      Set<String> fieldKeys = new HashSet<>();
      for (String value : fieldValues) {
        fieldKeys.add(MatchKey.of(value));
      }
      boolean overlaps = false;
      for (String value : otherValues) {
        if (fieldKeys.contains(MatchKey.of(value))) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        continue;
      }
      String message = isColumn
          ? "filter=\"" + item.expression() + "\" can never match — no value \"" + item.other()
              + "\" produces is a \"" + item.field() + "\" any member of pool \"" + item.pool()
              + "\" could hold"
          : "filter=\"" + item.expression() + "\" can never match — no member of pool \""
              + item.pool() + "\" holds \"" + item.field() + "\" = \"" + item.other() + "\"";
      String hint = "\"" + item.field() + "\" is drawn from: " + String.join(", ", fieldValues)
          + ". "
          + (isColumn ? "\"" + item.other() + "\" produces: " + String.join(", ", otherValues)
              + ". " : "")
          + "A filter narrows the members a row may draw from, and every row would be left with "
          + "none.";
      diagnostics.add(item.at() + shift,
          Diagnostic.error("TDC225", message, hint, item.line(), item.column()));
      shift += 1;
    }
  }

  /**
   * A group of fewer than two sequences constrains nothing.
   *
   * <p>It used to be dropped in silence: check called the config valid and the run drew repeats
   * anyway. A warning rather than an error — the config still runs, it just does not do what it
   * was written for.
   */
  private void checkGroupSize(
      TDCParser.OpenCloseElementContext wrapper, String tag, int members) {
    if (members >= 2) {
      return;
    }
    String counted = members == 0 ? "no sequences" : "one sequence";
    String hint =
        "uniq".equals(tag)
            ? "Put at least two <sequence> members in it, or drop the wrapper and write "
                + "uniq=\"true\" on the one sequence — that draws without replacement."
            : "Put at least two <sequence> members in it, or drop the wrapper: there is nothing "
                + "for a single value to differ from.";
    warn(
        "TDC221",
        "<"
            + tag
            + "> wraps "
            + counted
            + " — a group constrains its members against each other, so it does nothing here",
        hint,
        wrapper.getStart().getLine(),
        wrapper.getStart().getCharPositionInLine());
  }

  /**
   * A member of an env-level group has to produce one value per row.
   *
   * <p>The constraint is stated between sequences, so a compound has no single value to compare
   * or to make unique. Refusing is the only honest answer: silently using its first field would
   * enforce something the config did not ask for.
   */
  private void checkEnvGroupMember(TDCParser.OpenCloseElementContext sequence, String tag) {
    int named = 0;
    int total = 0;
    for (TDCParser.ElementContext child : sequence.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        total++;
        if (attributes(self.attr()).get("name") != null) {
          named++;
        }
      }
    }
    if (named > 0 || total > 1) {
      String name = attributes(sequence.attr()).get("name");
      error(
          "TDC129",
          "<sequence name=\"" + (name == null ? "?" : name) + "\"> inside a config-level <" + tag
              + "> must produce a single value",
          "A <" + tag + "> around sequences uses one value per sequence. Use a simple <gen> or a "
              + "<switch> sequence, not a compound (multi-field) one.",
          line(sequence), column(sequence));
    }
  }

  /**
   * A {@code <compute>} sequence's tree, checked against everything declared so far.
   *
   * <p>Its {@code <field>} references can only name a sequence that already exists — the value
   * is derived from the row, and a row is built in declaration order.
   */
  private void checkComputeBody(TDCParser.OpenCloseElementContext sequence) {
    for (TDCParser.ElementContext child : sequence.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null || !"compute".equals(open.name.getText())) {
        continue;
      }
      Set<String> knownFields = new LinkedHashSet<>(declaredNames);
      knownFields.addAll(Checks.BUILTINS);
      new ComputeCheck(diagnostics).check(open, knownFields);
    }
  }

  /** Register {@code Name.Field} for every field, wherever in the sequence body it sits. */
  private void collectFieldNames(TDCParser.OpenCloseElementContext element, String name) {
    for (TDCParser.ElementContext child : element.content().element()) {
      // A named <data> is a constant field and a real column, so a reference to it must not read
      // as a typo for a sequence nobody declared.
      if (child.dataElement() instanceof TDCParser.DataWithBodyContext data) {
        String constant = attributes(data.attr()).get("name");
        if (constant != null && !constant.isBlank()) {
          declaredNames.add(name + "." + constant);
        }
        continue;
      }
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        Map<String, String> genAttrs = attributes(self.attr());
        String field = genAttrs.get("name");
        if (field != null && !field.isBlank()) {
          declaredNames.add(name + "." + field);
        }
        // anomaly_flag= sits on the <gen>, not on the <sequence>, and names a real column —
        // referencing it must not read as a typo for a sequence nobody declared.
        String genFlag = genAttrs.get("anomaly_flag");
        if (genFlag != null && !genFlag.isBlank()) {
          declaredNames.add(genFlag);
        }
        try {
          if (Checks.hasRepeat(genAttrs)) {
            repeatingNames.add(name);
          }
        } catch (RuntimeException ignored) {
          // A malformed repeat is reported by checkRepeat; it is not this pass's business.
        }
        continue;
      }
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      if (inner != null && "distinct".equals(inner.name.getText())) {
        collectFieldNames(inner, name);
      }
    }
  }

  /** A sequence must actually produce something, and a compound must name its fields. */
  /** Bytes a value costs while {@code uniq} holds the column — MEASURED, see the TS reference. */
  private static final long UNIQ_BYTES_PER_VALUE = 250;

  /** Where to start talking, matching {@code <pool>}'s TDC234 threshold. */
  private static final long UNIQ_WARN_ROWS = 100_000;

  /**
   * {@code uniq} over many rows holds the whole column in memory — say so before the run.
   *
   * <p>A {@code <pool>} has warned since TDC234; {@code uniq} does the same thing and said nothing.
   * 250 bytes a value is measured — peak RSS against row count, the slope over an eight-fold range;
   * the table is in {@code typescript/src/validator/uniq-memory.ts}.
   */
  private void checkUniqMemory(TDCParser.OpenCloseElementContext open, String name) {
    Map<String, String> attrs = attributes(open.attr());
    if (!"true".equals(attrs.getOrDefault("uniq", "").trim().toLowerCase(java.util.Locale.ROOT))) {
      return;
    }
    if (envCount < UNIQ_WARN_ROWS) {
      return;
    }
    double mb = envCount * (double) UNIQ_BYTES_PER_VALUE / 1024 / 1024;
    String size = mb >= 1024
        ? String.format(java.util.Locale.ROOT, "%.1f GB", mb / 1024)
        : grouped((long) Math.round(mb)) + " MB";
    warn("TDC236",
        "uniq on \"" + (name == null ? "?" : name) + "\" holds all " + grouped(envCount)
            + " values in memory for the whole run — about " + size,
        "Drawing without replacement means remembering what has been drawn, so this cannot "
            + "stream: the config runs on the in-memory engine whatever mode= asks for. Measured "
            + "at about 250 bytes a value. It works — it is worth being deliberate about at this "
            + "size.",
        line(open), column(open));
  }

  private void checkSequenceBody(TDCParser.OpenCloseElementContext open, String name) {
    // An invented tag here used to pass in SILENCE: the config validated, exit 0, and the
    // run went ahead as if the tag had done something.
    // MISPLACED_IN_SEQUENCE is handled by the dedicated loop below, which also counts
    // them so TDC036 stays quiet. Reporting them here as well printed the same TDC013
    // twice — invisible in the full report, obvious once the brief output put the two
    // lines together.
    Set<String> seqPasses = new java.util.HashSet<>(SEQUENCE_CHILDREN);
    seqPasses.addAll(MISPLACED_IN_SEQUENCE);
    checkChildren(open.content(), "sequence", seqPasses, "TDC010", SEQUENCE_CHILDREN);
    for (TDCParser.ElementContext c : open.content().element()) {
      TDCParser.OpenCloseElementContext w = c.openCloseElement();
      if (w != null && ("distinct".equals(w.name.getText()) || "uniq".equals(w.name.getText()))) {
        // The wrapper is allowed here, but its own body was never looked at.
        checkChildren(w.content(), w.name.getText(), DISTINCT_CHILDREN);
      }
    }
    List<Map<String, String>> gens = new ArrayList<>();
    // Attributes and a position, rather than the typed node: a <gen> reaches here in
    // either punctuation, and the only thing wanted of it later is where to point.
    List<GenNode> genNodes = new ArrayList<>();
    boolean hasCompute = false;
    TDCParser.OpenCloseElementContext computeEl = null;
    for (TDCParser.ElementContext child : open.content().element()) {
      GenNode self = genNodeOf(child);
      if (self != null) {
        gens.add(attributes(self.attrs()));
        genNodes.add(self);
        continue;
      }
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      if (inner == null) {
        continue;
      }
      if ("compute".equals(inner.name.getText())) {
        hasCompute = true;
        computeEl = inner;
      } else if ("distinct".equals(inner.name.getText())) {
        for (TDCParser.ElementContext g : inner.content().element()) {
          GenNode gen = genNodeOf(g);
          if (gen != null) {
            gens.add(attributes(gen.attrs()));
            genNodes.add(gen);
          }
        }
      }
    }

    // A <sequence> holds only <gen> (optionally wrapped in <distinct>). A construct that belongs
    // at env level is a placement mistake — saying so beats letting it fall through to a
    // confusing "no <gen>", which names a symptom rather than the cause.
    int misplaced = 0;
    for (TDCParser.ElementContext child : open.content().element()) {
      String tag = null;
      org.antlr.v4.runtime.ParserRuleContext node = null;
      if (child.mapElement() != null) {
        tag = "map";
        node = child.mapElement();
      } else if (child.openCloseElement() != null) {
        tag = child.openCloseElement().name.getText();
        node = child.openCloseElement();
      } else if (child.selfClosingElement() != null) {
        tag = child.selfClosingElement().name.getText();
        node = child.selfClosingElement();
      }
      if (tag != null && MISPLACED_IN_SEQUENCE.contains(tag)) {
        error("TDC013", "<" + tag + "> is not allowed directly inside <sequence>",
            PLACEMENT_HINTS.get(tag) + " Allowed inside <sequence>: "
                + String.join(", ", new java.util.TreeSet<>(SEQUENCE_CHILDREN)) + ".",
            node.getStart().getLine(), node.getStart().getCharPositionInLine());
        misplaced++;
      }
    }

    if (hasCompute && !gens.isEmpty()) {
      // One <sequence>, two producers. The engine cannot honour both, and the five
      // implementations did not even agree on which one to drop — same config, different
      // data. Refuse instead.
      error("TDC219",
          "<compute> cannot sit beside a <gen> in <sequence name=\"" + (name == null ? "?" : name)
              + "\"> \u2014 one of the two would be dropped",
          "A sequence either DERIVES its value with <compute> or DRAWS it with <gen>. Move the "
              + "<compute> into its own <sequence> and read the drawn one from it with "
              + "<field name=\"\u2026\"/>.",
          line(computeEl), column(computeEl));
    }

    if (hasCompute && gens.isEmpty()) {
      uniqUnsupported(open, name, "<compute> processes the values it reads rather than drawing any of its own, so it cannot promise uniqueness");
    }

    if (gens.isEmpty() && !hasCompute && misplaced == 0) {
      error("TDC036", "<sequence name=\"" + (name == null ? "?" : name) + "\"> has no <gen> child",
          "A sequence needs at least one <gen type=\"…\"/> describing how values are made.",
          line(open), column(open));
      return;
    }

    // Conditional first, exactly as the reference orders it: gens carrying `if` are branches,
    // and a branch has no need of a name.
    boolean conditional = gens.stream().anyMatch(g -> g.containsKey("if"));
    if (conditional) {
      uniqUnsupported(open, name,
          "its value is picked per row from <gen if=\"…\"> branches rather than drawn as one pool, so it cannot promise uniqueness");
      return;
    }

    uniqOnComposed(open, name, gens);
    uniqDropsGenAttrs(open, name, gens);

    // Three readings, and the body says which: every gen named is a compound (several columns, no
    // value of its own), one unnamed gen alone is a simple sequence, and anything else COMPOSES —
    // the unnamed gens and the literals concatenate into the sequence's own value while the named
    // ones stay fields beside it. None of the three is an error, so the only thing left to check
    // is that two fields do not share a name.
    Set<String> fieldNames = new LinkedHashSet<>();
    for (int g = 0; g < gens.size(); g++) {
      String fieldName = gens.get(g).get("name");
      if (fieldName == null || fieldName.isBlank()) {
        continue;
      }
      if (!fieldNames.add(fieldName)) {
        GenNode node = genNodes.get(g);
        error("TDC111",
            "duplicate field name \"" + fieldName + "\" inside compound <sequence name=\""
                + (name == null ? "?" : name) + "\">",
            "Each <gen name=\"…\"> within a compound sequence must have a unique name.",
            at(node.attrs(), "name", node.line(), node.column())[0],
            at(node.attrs(), "name", node.line(), node.column())[1]);
      }
    }

    // Compound: every gen named, and no literal to compose with. Recorded so a later parent=
    // naming this sequence can be refused before the run rather than during it.
    boolean composes = false;
    for (TDCParser.ElementContext child : open.content().element()) {
      if (child.dataElement() instanceof TDCParser.DataWithBodyContext body
          && !PairedData.restore(body.dataContent().getText()).isBlank()) {
        composes = true;
        break;
      }
    }
    if (!gens.isEmpty() && fieldNames.size() == gens.size() && !composes && name != null) {
      valuelessNames.add(name);
    }

    // A simple body — one unnamed gen and nothing else — may say outright what it produces.
    if (gens.size() == 1 && fieldNames.isEmpty() && !composes && name != null) {
      List<String> values = finiteTextValues(gens.get(0));
      if (values != null) {
        finiteValues.put(name, values);
      }
    }
  }

  /**
   * A {@code <data>} inside a {@code <sequence>} reads {@code name} and nothing else.
   *
   * <p>It is a literal, or — with a name — a constant field. An output type belongs on the
   * {@code <data>} in the {@code <line>}, where the column is actually emitted; dropping one here
   * is the silent loss this whole reading was introduced to end.
   */
  private void checkSequenceDataAttrs(TDCParser.OpenCloseElementContext open) {
    for (TDCParser.ElementContext child : open.content().element()) {
      if (!(child.dataElement() instanceof TDCParser.DataWithBodyContext body)) {
        continue;
      }
      for (TDCParser.AttrContext attr : body.attr()) {
        String attrName = attr.attrName.getText();
        if ("name".equals(attrName) || "comment".equals(attrName)) {
          continue;
        }
        int[] where = at(body.attr(), attrName, line(open), column(open));
        error("TDC015",
            "<data> inside <sequence> does not read \"" + attrName + "\" — it is ignored",
            "Inside a <sequence> a <data> is a literal or, with name=\"…\", a constant field. "
                + "Output types belong on the <data> in the <line>.",
            where[0], where[1]);
      }
    }
  }

  /** A mix needs branches, and only branches. */
  private void checkMix(TDCParser.OpenCloseElementContext open) {
    checkMix(open, true);
  }

  /**
   * @param named whether this mix sits at env level and can therefore own a flag column. A
   *     nested one contributes a value to somebody else's column and has nowhere to put a flag.
   */
  private void checkMix(TDCParser.OpenCloseElementContext open, boolean named) {
    int cases = 0;
    boolean anomalous = false;
    TDCParser.OpenCloseElementContext firstAnomalous = null;
    for (TDCParser.ElementContext child : open.content().element()) {
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      String tag = inner != null ? inner.name.getText() : self != null ? self.name.getText() : null;
      if (tag == null) {
        continue;
      }
      if ("case".equals(tag)) {
        cases++;
        if (inner != null && "true".equals(attributes(inner.attr()).get("anomaly"))) {
          anomalous = true;
          if (firstAnomalous == null) {
            firstAnomalous = inner;
          }
        }
        if (inner != null) {
          checkClosedTagAttrs("case", inner.attr(), line(inner), column(inner));
          checkCaseBody(inner);
        }
        continue;
      }
      int l = inner != null ? line(inner) : line(self);
      int c = inner != null ? column(inner) : column(self);
      error("TDC124", "unknown child of <mix>: \"<" + tag + ">\"", "Allowed children: case.", l, c);
    }
    if (cases > 0) {
      checkPercentMask(attributes(open.attr()).get("percent"), cases,
          new String[] {"TDC121", "TDC122", "TDC123"},
          at(open, "percent")[0], at(open, "percent")[1]);
    }
    if (cases == 0) {
      error("TDC120", "<mix> has no <case> children",
          "Add at least one <case>...</case> inside <mix>.", line(open), column(open));
    }

    String flag = attributes(open.attr()).get("flag");
    if (flag != null && !named) {
      error("TDC203",
          "\"flag\" on a nested <mix> is not supported — only a named env-level <mix> can declare one",
          "A flag becomes its own sequence, so it needs a <mix name=\"…\"> at env level.",
          at(open, "flag")[0], at(open, "flag")[1]);
      // One complaint per mix: whether its branches are marked is beside the point once the
      // flag itself cannot exist.
      return;
    }
    if (flag == null && firstAnomalous != null) {
      // A branch marked as the outlier, and nothing recording which rows took it. The label is
      // the only reason to mark it, so the complaint points at the branch.
      int[] where = at(firstAnomalous, "anomaly");
      error("TDC203",
          "anomaly=\"true\" on <case> does nothing — the enclosing <mix> declares no flag=\"…\"",
          "Name the ground-truth column: <mix name=\"…\" flag=\"IsAnomaly\">.",
          where[0], where[1]);
    }
    for (String listy : new String[] {"repeat", "separator"}) {
      if (attributes(open.attr()).get(listy) != null) {
        error("TDC196",
            "\"" + listy + "\" is not supported on <mix> — it picks one branch, it does not produce a list",
            "Put repeat= on the <gen> inside a <case>, or on a plain <sequence>.",
            at(open, listy)[0], at(open, listy)[1]);
      }
    }
    if (flag != null && !flag.isBlank() && cases > 0 && !anomalous) {
      // A label that is false on every row is not a label. It reads as ground truth and
      // teaches whatever consumes it that nothing is ever anomalous.
      error("TDC202",
          "flag=\"…\" but no <case> is marked anomaly=\"true\" — the column would be all \"false\"",
          "Mark the outlier branch: <case anomaly=\"true\">…</case>.", at(open, "flag")[0], at(open, "flag")[1]);
    }
  }

  private void checkSwitch(TDCParser.OpenCloseElementContext open, List<String> declared) {
    checkSwitchForm(open, declared, true);
  }

  /**
   * {@code named} is false for the form written inside a {@code <case>}: it contributes a value
   * to that branch rather than a column of its own, so it has no name to declare and nothing can
   * interpolate it. Every other rule is the same, from this one method.
   */
  private void checkSwitchFormEntry(TDCParser.OpenCloseElementContext open) {
    // The entries walk only ever looked at open/close children, so a self-closing
    // invention passed while <bogus></bogus> was caught.
    checkChildren(open.content(), "switch", SWITCH_CHILDREN, "TDC124", SWITCH_CHILDREN);
  }

  private void checkSwitchForm(
      TDCParser.OpenCloseElementContext open, List<String> declared, boolean named) {
    checkSwitchFormEntry(open);
    Map<String, String> attrs = attributes(open.attr());
    if (!named && attrs.get("name") != null) {
      error("TDC245",
          "\"name\" on a nested <switch> is not supported — only an env-level <switch> becomes a"
              + " column",
          "A nested <switch> contributes its value to the <case> around it. Nothing can"
              + " interpolate it, so a name would name nothing. Move it to <env> if you want"
              + " ${{Name}}.",
          at(open, "name")[0], at(open, "name")[1]);
    }
    String on = attrs.get("on");
    if (on == null || on.isBlank()) {
      error("TDC133", "<switch> is missing a required \"on\" attribute",
          "A switch looks a value up; \"on\" names the sequence it looks up.", line(open), column(open));
    } else if (!declared.contains(on)) {
      error("TDC134", "<switch on=\"" + on + "\"> refers to an unknown sequence",
          "Declare the subject sequence above the switch.", at(open, "on")[0], at(open, "on")[1]);
    }

    int entries = 0;
    for (TDCParser.ElementContext child : open.content().element()) {
      if (child.mapElement() != null) {
        entries++;
        checkMapRows(child.mapElement());
        continue;
      }
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      if (inner == null) {
        continue;
      }
      if ("case".equals(inner.name.getText())) {
        entries++;
        String is = attributes(inner.attr()).get("is");
        if (is == null || is.isBlank()) {
          error("TDC137", "<case> inside <switch> is missing a required \"is\" attribute",
              "A switch case matches a value; \"is\" is the value it matches.",
              line(inner), column(inner));
        }
        checkCaseBody(inner);
      } else if ("default".equals(inner.name.getText())) {
        entries++;
        checkCaseBody(inner);
      }
    }
    if (entries == 0) {
      error("TDC135", "<switch> has no entries",
          "Add a <map>, a <case is=\"…\">, or a <default>.", line(open), column(open));
    }
  }

  /** Walk into a sequence body so a {@code <gen>} inside a {@code <distinct>} is checked too. */
  private void checkGensIn(TDCParser.ElementContext element) {
    TDCParser.SelfClosingElementContext self = element.selfClosingElement();
    if (self != null && "gen".equals(self.name.getText())) {
      checkGen(self);
      return;
    }
    TDCParser.OpenCloseElementContext open = element.openCloseElement();
    if (open != null) {
      for (TDCParser.ElementContext inner : open.content().element()) {
        checkGensIn(inner);
      }
    }
  }

  // ── gen ──────────────────────────────────────────────────────────────────────────────────

  private void checkGen(TDCParser.SelfClosingElementContext gen) {
    Map<String, String> attrs = attributes(gen.attr());
    String type = attrs.get("type");

    // A conditional gen carries `if` as its branch condition, and a plain one may have one too.
    // An expression here is an expression like any other: left unchecked, a branch that can never
    // be taken looks exactly like a branch nobody happened to hit.
    String condition = attrs.get("if");
    if (condition != null) {
      int[] where = at(gen.attr(), "if", line(gen), column(gen));
      checkIfExpression(condition, where[0], where[1]);
      pendingExpressions.add(
          new Pending(diagnostics.size(), condition, where[0], where[1], false));
      // A pool reference publishes a whole MEMBER, and a <gen> carrying `if` becomes a
      // conditional branch the pool resolver does not recognise — so no Ref.field column was
      // registered and ${{Ref.name}} reached the output as its own literal text, on every row
      // including the ones the condition selected.
      if ("pool".equals(type)) {
        error("TDC268",
            "if= is not supported on <gen type=\"pool\">: the reference publishes a whole MEMBER,"
                + " and a conditional one would register no fields at all",
            "To leave some rows without a member, use parent=\"\u2026\" \u2014 it masks the "
                + "reference the same way it masks any other sequence, and the fields come out "
                + "empty on the rows it excludes.",
            where[0], where[1]);
      }
    }

    if (type == null || type.isBlank()) {
      error("TDC040", "<gen> is missing a required \"type\" attribute",
          "Every generator names what it generates.", at(gen, "name")[0], at(gen, "name")[1]);
    } else if (!GEN_TYPES.contains(type)) {
      error("TDC041", "unknown gen type \"" + type + "\"",
          "Known types: " + String.join(", ", new java.util.TreeSet<>(GEN_TYPES)) + ".",
          at(gen, "type")[0], at(gen, "type")[1]);
    }

    // Before the per-type checks, and INSTEAD of them when it fires: a value holding

    // ${{…}} is not the value its generator will try to parse, so letting the generator

    // also complain would put a wrong explanation beside the right one.

    if (checkAttrInterpolation(gen, attrs, type)) {

      return;

    }


    checkRequiredValue(gen, attrs, type);
    checkNumber(gen, attrs, type);
    checkRegexes(gen, attrs, type);
    checkSymbol(gen, attrs, type);
    checkDate(gen, attrs, type);
    checkTimeseries(gen, attrs, type);
    checkSequentialRepeat(gen, attrs);
    checkRepeat(gen, attrs, type);

    checkGenAttributes(gen, attrs, type);

    checkWeight(gen, attrs, type);
    checkSource(gen, attrs, type);
    checkHttp(gen, attrs, type);
    checkRunning(gen, attrs, type);
    checkStat(gen, attrs, type);
    checkMask(gen, attrs);
    checkCounter(gen, attrs, type);
    checkDateTemplates(gen, attrs, type);
    checkCaseAndOrder(gen, attrs);
    checkImperfections(gen, attrs, type);
    // order="sequential" gives row r element `r mod N` — a rule about POSITION, which leaves no
    // room for a rule about SHARE. The engine ignores the percent outright, and nothing told the
    // user: percent="98,1,1" over a hundred rows came out 34/33/33 from a config check had
    // called valid.
    if (("text".equals(type) || "file".equals(type))
        && "sequential".equals(attrs.getOrDefault("order", "").trim())
        && attrs.get("percent") != null) {
      error("TDC271",
          "percent=\"" + attrs.get("percent") + "\" is not read beside order=\"sequential\": "
              + "walking the list in order fixes which value each row gets, so there is no share "
              + "left to apportion",
          "Drop order=\"sequential\" to have the shares apportioned exactly, or drop percent= "
              + "and take the values in the order they are written \u2014 each one as often as "
              + "the others.",
          at(gen, "percent")[0], at(gen, "percent")[1]);
    }
    if ("text".equals(type) && attrs.get("percent") != null) {
      int values = splitCount(attrs.getOrDefault("value", ""));
      checkPercentMask(attrs.get("percent"), values,
          new String[] {"TDC051", "TDC052", "TDC053"},
          at(gen, "percent")[0], at(gen, "percent")[1]);
    }
    if ("number".equals(type) && attrs.get("percent") != null && attrs.get("length") != null) {
      int groups = splitCount(attrs.get("length"));
      checkPercentMask(attrs.get("percent"), groups,
          new String[] {"TDC084", "TDC085", "TDC086"},
          at(gen, "percent")[0], at(gen, "percent")[1]);
    }
  }

  /**
   * The {@code http} generator: everything knowable before the run.
   *
   * <p>A missing endpoint, an address that is not a URL, an {@code in=} naming nothing. The
   * transport failures — the service down, slow or wrong — cannot be known until the run and are
   * reported then; these can, and a run that calls a service is the most expensive kind to
   * discover a typo in.
   */
  private void checkHttp(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"http".equals(type)) {
      return;
    }
    String src = attrs.get("src");
    if (src == null || src.trim().isEmpty()) {
      error("TDC065", "<gen type=\"http\"> requires a \"src\" attribute",
          "Point it at the service, e.g. src=\"http://127.0.0.1:5566/gen\".",
          at(gen, "src")[0], at(gen, "src")[1]);
    } else if (!isHttpUrl(src.trim())) {
      error("TDC066", "invalid http src \"" + src.trim() + "\" — must be an http:// or https:// URL",
          "e.g. src=\"http://127.0.0.1:5566/gen\" or src=\"https://svc.example.com/gen\".",
          at(gen, "src")[0], at(gen, "src")[1]);
    }

    String in = attrs.get("in");
    if (in != null && !declaredNames.contains(in.trim())) {
      error("TDC067", "in=\"" + in.trim() + "\" does not name a sequence declared before this one",
          "The value sent per row comes from an earlier <sequence>; declare it above.",
          at(gen, "in")[0], at(gen, "in")[1]);
    }

    String onError = attrs.get("on_error");
    if (onError != null && !"fail".equals(onError) && !"empty".equals(onError)) {
      error("TDC068", "invalid on_error \"" + onError + "\" — expected \"fail\" or \"empty\"",
          "fail (default) stops the run; empty blanks the cell and continues.",
          at(gen, "on_error")[0], at(gen, "on_error")[1]);
    }
  }

  private static boolean isHttpUrl(String value) {
    try {
      java.net.URI uri = java.net.URI.create(value);
      String scheme = uri.getScheme();
      return uri.isAbsolute()
          && ("http".equals(scheme) || "https".equals(scheme))
          && uri.getHost() != null;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /** A {@code mask=} that does not parse. Caught here rather than on the first row. */
  private void checkMask(TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String mask = attrs.get("mask");
    if (mask == null) {
      return;
    }
    try {
      io.github.nickliapin.tdc.format.Mask.check(mask);
    } catch (RuntimeException e) {
      error("TDC199", e.getMessage(),
          "Indices are 0-based; ranges use \"..\", e.g. mask=\"x[0..3]\" or mask=\"w[-1], w[0]\".",
          at(gen, "mask")[0], at(gen, "mask")[1]);
    }
  }

  /**
   * {@code missing="p"} and {@code anomaly="p"}: a probability, and something to spend it on.
   *
   * <p>Both were parsed only where they are used, deep in the sequence builder, so {@code check}
   * called a config valid and the run then stopped on {@code anomaly="10x"}. A check that passes
   * what the very next command refuses is worse than no check. The generator keeps its own parse
   * as a backstop, for callers who build a gen through the library without validating.
   *
   * <p>The second half is a request that would be honoured and still do nothing. An anomaly
   * multiplies the selected value by {@code anomaly_factor}, so a {@code value=} list with no
   * number anywhere in it has nothing to perturb and ten rows come back ordinary with no sign
   * that 30% of them were meant to be outliers. Only a {@code type="text"} list is judged: it is
   * the only source whose whole candidate set is written in the config.
   */
  private void checkImperfections(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    for (String key : List.of("anomaly", "missing")) {
      String raw = attrs.get(key);
      if (raw == null || raw.isBlank() || isProbability(raw)) {
        continue;
      }
      error("TDC242",
          key + "=\"" + raw + "\" is not a probability — it must be a number in [0, 1]",
          "anomaly".equals(key)
              ? "It is the share of values turned into outliers: anomaly=\"0.05\" spikes one "
                  + "value in twenty."
              : "It is the share of values blanked: missing=\"0.1\" empties one value in ten.",
          at(gen, key)[0], at(gen, key)[1]);
    }

    String raw = attrs.get("anomaly");
    if (raw == null || !isProbability(raw) || Double.parseDouble(raw) == 0.0) {
      return;
    }
    if (!"text".equals(type)) {
      return;
    }
    String listed = attrs.get("value");
    if (listed == null || listed.isBlank()) {
      return;
    }
    for (String piece : listed.split(",", -1)) {
      if (isNumber(piece.trim())) {
        return;
      }
    }
    error("TDC243",
        "anomaly=\"" + raw + "\" has nothing to perturb — no value in \"" + listed
            + "\" is a number",
        "An anomaly multiplies a numeric value by anomaly_factor, so a list of words comes back "
            + "unchanged. Put the anomaly on a numeric generator, or drop it.",
        at(gen, "anomaly")[0], at(gen, "anomaly")[1]);
  }

  /** True when the text is a finite number — the same test the generators apply. */
  private static boolean isNumber(String raw) {
    if (raw.isEmpty()) {
      return false;
    }
    try {
      return Double.isFinite(Double.parseDouble(raw));
    } catch (NumberFormatException e) {
      return false;
    }
  }

  /** True when the text is a probability the generators will accept. */
  private static boolean isProbability(String raw) {
    if (!isNumber(raw)) {
      return false;
    }
    double p = Double.parseDouble(raw);
    return p >= 0.0 && p <= 1.0;
  }

  /**
   * A {@code src=} that names a file nobody can read.
   *
   * <p>Checked before the run rather than during it: a missing file discovered on row one of a
   * million-row job has already cost whatever the job cost.
   */
  private void checkSource(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"file".equals(type) && !"pattern".equals(type)) {
      return;
    }
    // `src=` is one of three ways to hand a drawing a shape, so its absence is only a mistake
    // when the other two are absent too — the drawing equivalent of a regex with no pattern,
    // which TDC095 and TDC128 have always caught before the run.
    if ("pattern".equals(type)) {
      boolean drawable = false;
      for (String key : List.of("points", "src", "upper")) {
        String value = attrs.get(key);
        if (value != null && !value.isBlank()) {
          drawable = true;
          break;
        }
      }
      if (!drawable) {
        error("TDC244",
            "<gen type=\"pattern\"> has nothing to draw from",
            "Give it a shape: points=\"0,0 1,5 2,3\", src=\"curve.svg\" (or a PNG), or "
                + "upper=\"…\" with an optional lower=\"…\" for a band.",
            line(gen), column(gen));
        return;
      }
    }
    String src = attrs.get("src");
    if (src == null || src.isBlank()) {
      return;
    }
    // The same resolution the generator itself performs, or the validator would refuse a config
    // the run would have handled — an @data/ source above all.
    java.nio.file.Path path;
    try {
      path = io.github.nickliapin.tdc.generators.FileGen.resolve(src, baseDir, dataRoots());
    } catch (RuntimeException e) {
      error("TDC061", e.getMessage(), "Paths are relative to the config file's own folder.",
          at(gen, "src")[0], at(gen, "src")[1]);
      return;
    }
    if (!java.nio.file.Files.isReadable(path)) {
      error("TDC061", "cannot read file \"" + src + "\"",
          "Paths are relative to the config file's own folder.", at(gen, "src")[0], at(gen, "src")[1]);
      return;
    }
    if (attrs.get("column") == null) {
      return;
    }
    // A column that names nothing in the file: caught by loading it, which is the only way to
    // know, and cheap next to discovering it a million rows in.
    try {
      io.github.nickliapin.tdc.generators.FileGen.load(attrs, baseDir, dataRoots());
    } catch (RuntimeException e) {
      error("TDC062", e.getMessage(),
          "For CSV files, use a header name like column=\"email\" or a 1-based index like "
              + "column=\"2\".",
          at(gen, "column")[0], at(gen, "column")[1]);
    }
  }

  /** Every generator that cannot work without one particular attribute. */
  /**
   * Every attribute is spelled right AND read by this generator.
   *
   * <p>An ignored attribute is a request the config made and silently did not get, which is
   * indistinguishable from a typo — and the data comes out looking fine either way, which is what
   * makes it worth stopping for. All errors, matching the reference.
   */
  private void checkGenAttributes(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if ("template".equals(type)) {
      checkBuiltinTemplateAttrs(gen, attrs);
      // A pack's parameters are open-ended, so the "is this a known name" half cannot run
      // here — but which type reads order= does not depend on the pack, and that half is why
      // order= and parent= sat on a template generator doing nothing.
      for (String name : attrs.keySet()) {
        if ("parent".equals(name)) {
          ignored(gen, name, MISPLACED_GEN_PARENT);
          continue;
        }
        // A name the pack may claim is the pack's business, and the pack-parameter check
        // judges it with the registry in hand. The line is drawn by what the ENGINE reads
        // before the pack runs; everything else is handed to the pack as an override.
        java.util.Set<String> owns =
            RESERVED_TEMPLATE_ATTRS.contains(name) ? ATTRIBUTE_OWNERS.get(name) : null;
        if (owns != null && !owns.contains("template")) {
          List<String> sortedOwners = new ArrayList<>(owns);
          java.util.Collections.sort(sortedOwners);
          StringBuilder belongsTo = new StringBuilder();
          for (int i = 0; i < sortedOwners.size(); i++) {
            belongsTo.append(i == 0 ? "" : ", ")
                .append("type=\"").append(sortedOwners.get(i)).append('"');
          }
          ignored(gen, name, "\"" + name + "\" belongs to " + belongsTo
              + " — a type=\"template\" generator ignores it.");
        }
      }
      return;
    }

    String distribution = attrs.get("distribution");
    boolean hasDistribution = distribution != null && !distribution.isBlank();
    String order = attrs.getOrDefault("order", "").trim();

    for (String name : attrs.keySet()) {
      if (!GEN_ATTRS.contains(name)) {
        ignored(gen, name, "Check the spelling against the generator's attributes.");
        continue;
      }
      // A distribution parameter with no distribution asked for shapes nothing.
      if (DISTRIBUTION_PARAMS.contains(name) && !hasDistribution) {
        ignored(gen, name,
            "\"" + name + "\" is a parameter of a named distribution — add distribution=\"…\" "
                + "for it to mean anything. To bound a plain number, put the range in "
                + "value=\"10..20\".");
        continue;
      }
      // cycle= says what happens when a WALK runs out. Without a walk there is nothing to
      // run out of: the generator draws, and a draw never ends.
      if ("cycle".equals(name) && !"sequential".equals(order)) {
        ignored(gen, name,
            "cycle= says what happens when order=\"sequential\" reaches the end of its source. "
                + "Without order=\"sequential\" the generator draws, and a draw never runs out.");
        continue;
      }
      // A wrapper the type never puts its value through. Separate from the ownership table
      // because the name IS a general wrapper — it works on almost every type, and these two
      // resolve before the layer that applies it.
      if (type != null && WRAPPERS_NOT_READ.getOrDefault(type, java.util.Set.of()).contains(name)) {
        ignored(gen, name,
            "a type=\"" + type + "\" generator publishes its number as it stands — the "
                + "formatting layer does not run for it. Apply it where the value is printed "
                + "instead: ${{Total|mask:x}}, ${{Total|upper}}.");
        continue;
      }
      java.util.Set<String> owners = ATTRIBUTE_OWNERS.get(name);
      if (owners != null && type != null && !owners.contains(type)) {
        List<String> sorted = new ArrayList<>(owners);
        java.util.Collections.sort(sorted);
        StringBuilder belongs = new StringBuilder();
        for (int i = 0; i < sorted.size(); i++) {
          belongs.append(i == 0 ? "" : ", ").append("type=\"").append(sorted.get(i)).append('"');
        }
        ignored(gen, name,
            "\"" + name + "\" belongs to " + belongs + " — a type=\"" + type
                + "\" generator ignores it.");
      }
    }
  }

  /**
   * The two pack-less template paths, against their own closed parameter sets.
   *
   * <p>A pack declares its own parameters and is judged with the registry in hand; these two are
   * backed by no pack, so nothing else checks them.
   */
  private void checkBuiltinTemplateAttrs(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String path = attrs.get("value") == null ? "" : attrs.get("value").trim();
    java.util.Set<String> allowed = BUILTIN_TEMPLATE_PARAMS.get(path);
    if (allowed == null) {
      if (checkPackParams(gen, attrs, path)) {
        return;
      }
      for (String name : attrs.keySet()) {
        if (!GEN_ATTRS.contains(name)) {
          ignored(gen, name, "Check the spelling against the generator's attributes.");
        }
      }
      return;
    }

    for (String name : attrs.keySet()) {
      if (TEMPLATE_COMMON_ATTRS.contains(name)) {
        continue;
      }
      if (!allowed.contains(name)) {
        List<String> sorted = new ArrayList<>(allowed);
        java.util.Collections.sort(sorted);
        ignored(gen, name, "\"" + path + "\" reads only " + String.join(", ", sorted) + ".");
      }
    }
  }

  /**
   * {@code uniq="true"} where the value is not DRAWN, so there is no pool to take from.
   *
   * <p>Uniqueness is a property of a draw — without replacement on a simple sequence, a
   * rearrangement of the columns on a compound one. A computed result and a conditional pick are
   * neither, so the attribute could only be ignored, and it used to be in silence: the config
   * claimed the column was unique and the data disagreed without a word.
   */
  /**
   * {@code uniq="true"} on a composed value that joins two or more DRAWN parts.
   *
   * <p>One drawn part plus constants is fine and honoured: appending a constant cannot make two
   * different draws collide. Two drawn parts have no fixed widths, so a unique set of parts is not
   * a unique join — {@code 9} + {@code 15} and {@code 91} + {@code 5} are the same three
   * characters.
   */
  /**
   * Attributes that reach the value AFTER it is drawn, and so cannot survive a draw without
   * replacement. Each can make two distinct draws print the same text — a mask hides the digits
   * that told them apart, {@code case} folds {@code ab} and {@code AB} together, {@code missing}
   * writes the same blank on many rows, {@code repeat} turns the cell into a list.
   */
  private static final String[] DROPPED_BY_UNIQ = {
    "mask", "case", "missing", "missing_as", "repeat", "separator", "anomaly", "anomaly_flag"
  };

  /**
   * {@code uniq="true"} on a simple sequence whose {@code <gen>} also asks for formatting.
   *
   * <p>The uniq path produces the column directly and never reaches the pipeline that applies
   * these attributes, so they used to vanish in silence. Applying them instead would break the
   * promise the other way round: a mask maps two distinct draws onto the same characters. So the
   * combination is refused and the attribute is named. {@code increment} and {@code decrement}
   * are exempt — unique by construction, they keep their ordinary build.
   */
  private void uniqDropsGenAttrs(
      TDCParser.OpenCloseElementContext open,
      String name,
      java.util.List<java.util.Map<String, String>> gens) {
    String uniq = attributes(open.attr()).get("uniq");
    if (uniq == null || !"true".equals(uniq.trim().toLowerCase(java.util.Locale.ROOT))) {
      return;
    }
    if (gens.size() != 1 || gens.get(0).containsKey("name")) {
      return;
    }
    java.util.Map<String, String> gen = gens.get(0);
    String kind = gen.getOrDefault("type", "");
    if ("increment".equals(kind) || "decrement".equals(kind)) {
      return;
    }
    java.util.List<String> asked = new java.util.ArrayList<>();
    for (String a : DROPPED_BY_UNIQ) {
      if (gen.containsKey(a)) {
        asked.add(a + "=");
      }
    }
    if (asked.isEmpty()) {
      return;
    }
    String listed = String.join(", ", asked);
    int[] pos = at(open.attr(), "uniq", line(open), column(open));
    error("TDC267",
        "uniq=\"true\" on <sequence name=\"" + (name == null ? "?" : name) + "\"> cannot be "
            + "combined with " + listed + " on its <gen>: a draw without replacement produces the "
            + "values directly, so nothing that rewrites them afterwards runs",
        "Two ways out. Drop the attribute if the uniqueness is what you wanted \u2014 or drop "
            + "uniq= and keep the formatting, since a masked, blanked or repeated column cannot "
            + "be unique as text anyway: a mask maps different values onto the same characters.",
        pos[0], pos[1]);
  }

  private void uniqOnComposed(
      TDCParser.OpenCloseElementContext open, String name, List<Map<String, String>> gens) {
    String uniq = attributes(open.attr()).get("uniq");
    if (uniq == null || !"true".equals(uniq.trim().toLowerCase(java.util.Locale.ROOT))) {
      return;
    }
    long drawn = gens.stream().filter(g -> !g.containsKey("name")).count();
    if (drawn < 2) {
      return;
    }
    int[] pos = at(open.attr(), "uniq", line(open), column(open));
    error("TDC220",
        "uniq=\"true\" cannot be honoured on <sequence name=\"" + (name == null ? "?" : name)
            + "\">: its value joins " + drawn + " drawn parts, and a unique set of parts is not a "
            + "unique join when the parts have no fixed width",
        "Give each part its own <sequence> and wrap them in <uniq>\u2026</uniq>, with a fixed "
            + "width per part (length= plus first_zero=\"true\" on a number). Then the join can "
            + "be split back one way only, so a unique combination is a unique result.",
        pos[0], pos[1]);
  }

  private void uniqUnsupported(
      TDCParser.OpenCloseElementContext open, String name, String why) {
    Map<String, String> attrs = attributes(open.attr());
    String uniq = attrs.get("uniq");
    if (uniq == null || !"true".equals(uniq.trim().toLowerCase(java.util.Locale.ROOT))) {
      return;
    }
    int[] pos = at(open.attr(), "uniq", line(open), column(open));
    error("TDC218",
        "uniq=\"true\" is not allowed on <sequence name=\"" + (name == null ? "?" : name)
            + "\">: " + why,
        "Put uniq= on the sequences this one reads, or wrap them in <uniq>…</uniq> so their "
            + "combination is unique across records. When the parts have fixed widths, a unique "
            + "combination means a unique result.",
        pos[0], pos[1]);
  }

  /**
   * Attributes on a template {@code <gen>} that the target pack CAN act on.
   *
   * <p>A pack whose body declares {@code <sequence name="domain">} accepts {@code domain="…"}
   * from the caller, and the engine replaces that sequence with the constant. So the attribute is
   * neither a typo nor ignored — refusing it, as this used to, made a config that runs in the
   * reference fail here.
   *
   * <p>Returns false — leaving the ordinary check to run — when nothing is known about the pack:
   * an unresolvable address, or no registry at all. Guessing there would produce exactly the
   * false errors this must not create.
   */
  private boolean checkPackParams(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String path) {
    if (packs == null || path.isEmpty()) {
      return false;
    }
    java.util.Set<String> declared = packs.parameterNames(path, locale);
    if (declared == null) {
      return false;
    }
    java.util.Map<String, Integer> widths = packs.parameterWidths(path, locale);

    for (Map.Entry<String, String> attr : attrs.entrySet()) {
      // parent, count and flag may sit on a <gen> and are each reported by their own rule;
      // a pack-parameter check must not read them as typos.
      if (PACK_WRAPPER_ATTRS.contains(attr.getKey())
          || NOT_A_PACK_PARAM.contains(attr.getKey())) {
        continue;
      }
      if (declared.contains(attr.getKey())) {
        // A parameter the pack DOES accept, pinned to a value of the wrong width.
        //
        // The packs that carry a check digit compute it over a fixed layout, so a wrong-width
        // value does not shift the layout — it breaks it. Measured on usa.finance.aba_routing,
        // whose own prefix is 2 characters: prefix="12345" aborted the run with "<at>: index 8
        // is out of range", naming no file, line or code, and tail="678" said nothing at all
        // and wrote a six-digit number that is not a routing number. check passed on both.
        // Only reported where the width is a FACT read off the pack's own body.
        Integer want = widths.get(attr.getKey());
        if (want != null && attr.getValue().length() != want) {
          int[] pos = at(gen, attr.getKey());
          error("TDC276",
              "\"" + attr.getKey() + "\" is pinned to " + attr.getValue().length()
                  + " characters, and \"" + path + "\" builds its value around a "
                  + attr.getKey() + "= of exactly " + want,
              "A pinned parameter replaces the pack's own value, and this pack has a fixed "
                  + "layout — a check digit is computed over the whole of it. Use a "
                  + attr.getKey() + "= of " + want + " characters, or drop it and let the pack "
                  + "draw its own.",
              pos[0], pos[1]);
        }
        continue;
      }
      String hint =
          declared.isEmpty()
              ? "This generator takes no parameters — it produces a fixed shape. Value passed: \""
                  + attr.getValue()
                  + "\"."
              : "Parameters of this generator: "
                  + String.join(", ", new java.util.TreeSet<>(declared))
                  + ".";
      error(
          "TDC072",
          "\"" + attr.getKey() + "\" is not a parameter of \"" + path + "\" — it would be ignored",
          hint,
          at(gen, attr.getKey())[0],
          at(gen, attr.getKey())[1]);
    }
    return true;
  }

  private void ignored(TDCParser.SelfClosingElementContext gen, String name, String why) {
    error("TDC015", "<gen> does not read \"" + name + "\" — it is ignored", why,
        at(gen, name)[0], at(gen, name)[1]);
  }

  private void checkRequiredValue(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    String value = attrs.get("value");
    boolean missing = value == null || value.isBlank();
    switch (type == null ? "" : type) {
      case "text" -> {
        if (missing) {
          error("TDC050", "<gen type=\"text\"> requires a \"value\" attribute",
              "It is the comma-separated list to pick from.", line(gen), column(gen));
        }
      }
      case "file" -> {
        if (attrs.get("src") == null || attrs.get("src").isBlank()) {
          error("TDC060", "<gen type=\"file\"> requires a \"src\" attribute",
              "Provide the path to a UTF-8 text file with one value per line.",
              line(gen), column(gen));
        }
        String row = attrs.get("row");
        if (row != null && !row.isBlank()
            && (attrs.get("column") == null || attrs.get("column").isBlank())) {
          error("TDC064", "row-linked file generators require a CSV \"column\" attribute",
              "Use column=\"name\" or column=\"2\" together with row=\"sharedKey\".",
              at(gen, "row")[0], at(gen, "row")[1]);
        }
      }
      case "template" -> {
        if (missing) {
          error("TDC070", "<gen type=\"template\"> requires a \"value\" attribute",
              "Use a known template path, e.g. person.male.firstName.", line(gen), column(gen));
        } else if (value.contains("${{")) {
          // An address that names a field is not known until the row is, so there is nothing
          // to look up here. The engine resolves it per row and reports what it cannot find.
          return;
        } else if (!BUILTIN_TEMPLATE_PATHS.contains(value.trim())
            && packs != null
            && packs.exists(value.trim(), locale)) {
          // The address resolves; whether the file behind it is usable is a separate question,
          // and one worth answering now. A pack a user wrote themselves is exactly the kind that
          // is malformed, and finding out on the first row wastes the run.
          try {
            packs.load(value.trim(), locale);
          } catch (RuntimeException e) {
            error("TDC170", e.getMessage(),
                "Data pack file for \"" + value.trim() + "\".",
                at(gen, "value")[0], at(gen, "value")[1]);
          }
        } else if (!BUILTIN_TEMPLATE_PATHS.contains(value.trim())
            && packs != null
            && !packs.exists(value.trim(), locale)) {
          // The path may be real and only missing DATA for this locale. Said as
          // its own code because "unknown template path" reads as a typo and sends
          // the reader hunting for one that is not there.
          if (!"en".equals(locale) && packs.exists(value.trim(), "en")) {
            error("TDC217",
                "template path \"" + value + "\" has no data for locale \"" + locale + "\"",
                "The \"en\" pack ships it. Set local=\"…\" on this <gen> or on <env>, or choose "
                    + "a path your locale ships.",
                at(gen, "value")[0], at(gen, "value")[1]);
          } else {
            error("TDC071", "unknown template path \"" + value + "\"",
                "Check the address against the packs you have.",
                at(gen, "value")[0], at(gen, "value")[1]);
          }
        }
      }
      case "regex" -> {
        if (missing) {
          error("TDC095", "<gen type=\"regex\"> requires a \"value\" attribute",
              "Provide a finite regex pattern, e.g. value=\"[A-Z]{2}[0-9]{6}\".",
              line(gen), column(gen));
        }
      }
      case "advanced_regex" -> {
        if (missing) {
          error("TDC128", "<gen type=\"advanced_regex\"> requires a \"value\" attribute",
              "Provide a finite pattern, optionally with a weighted choice.",
              line(gen), column(gen));
        }
      }
      default -> {
        // Nothing else has a single required attribute.
      }
    }
  }

  /**
   * The number generator's own parsers decide what is valid.
   *
   * <p>A validator with its own idea of a valid range drifts from the generator that reads it,
   * and then a config passes the check and fails at run time — the worst of both.
   */
  private void checkNumber(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"number".equals(type)) {
      return;
    }
    String distribution = attrs.get("distribution");
    if (distribution != null && !distribution.isBlank()) {
      for (String key : Checks.DISTRIBUTION_CONFLICTS) {
        if (attrs.get(key) != null) {
          error("TDC088",
              "<gen type=\"number\" distribution=\"...\"> cannot be combined with \"" + key + "\"",
              "A distribution replaces the range/percent. Remove \"" + key
                  + "\", or drop \"distribution\" to use a range.",
              at(gen, key)[0], at(gen, key)[1]);
        }
      }
      // The distribution's own parameters: a shape nobody can draw from is an error before the
      // run, not a surprise on the first row.
      try {
        io.github.nickliapin.tdc.stats.Distribution.parse(attrs);
      } catch (RuntimeException e) {
        error("TDC089", e.getMessage(),
            "Distributions: normal (mean, sd), lognormal (meanlog, sdlog), exponential (rate), "
                + "pareto (alpha, xmin). Optional: decimals, min, max.",
            at(gen, "distribution")[0], at(gen, "distribution")[1]);
      }
      return;
    }

    String value = attrs.get("value");
    if (value != null && !value.isBlank()) {
      String problem = Checks.numberRangeProblem(value);
      if (problem != null) {
        error("TDC081", "invalid number range \"" + value + "\"",
            "Expected \"bit\", \"MIN..MAX\", or a list like \"[0..9],[20..29]\".",
            at(gen, "value")[0], at(gen, "value")[1]);
      }
    }

    String firstZero = attrs.get("first_zero");
    if (firstZero != null && !Checks.isBooleanText(firstZero)) {
      error("TDC082", "invalid first_zero \"" + firstZero + "\" — expected \"true\" or \"false\"",
          "It decides whether a generated digit string may start with a zero.",
          at(gen, "first_zero")[0], at(gen, "first_zero")[1]);
    }

    String length = attrs.get("length");
    if (length != null && !Checks.isValidLength(length)) {
      error("TDC083",
          "invalid length \"" + length + "\" — expected a positive integer, range, or comma-separated list",
          "Examples: length=\"10\", length=\"2-10\", length=\"2,10-12\".",
          at(gen, "length")[0], at(gen, "length")[1]);
    }

    boolean hasInclude = attrs.get("include") != null && !attrs.get("include").isBlank();
    boolean hasExclude = attrs.get("exclude") != null && !attrs.get("exclude").isBlank();
    boolean hasModifier = hasInclude || hasExclude;
    // include/exclude turn the draw into a pick from an explicit set of WHOLE numbers, so a
    // fractional value can never be in it: decimals described a draw that is no longer
    // happening. The engine dropped it and emitted integers, and a config asking for 7.71 got
    // 8 without a word.
    String decimals = attrs.getOrDefault("decimals", "").trim();
    if (hasModifier && !decimals.isEmpty() && !"0".equals(decimals)) {
      String which = hasInclude && hasExclude ? "include/exclude" : hasInclude ? "include"
          : "exclude";
      error("TDC255",
          "decimals=\"" + decimals + "\" cannot be combined with " + which,
          "include= and exclude= build a set of whole numbers and pick one uniformly, so there "
              + "are no fractional values to round. Drop decimals=, or bound the range with "
              + "value= instead of a set.",
          at(gen, "decimals")[0], at(gen, "decimals")[1]);
    }
    if (hasModifier && (value == null || value.isBlank())) {
      error("TDC087", "<gen type=\"number\"> include/exclude require a numeric range in \"value\"",
          "Add a range first, e.g. value=\"0..9\" exclude=\"3\".", line(gen), column(gen));
    }
    checkDecimalsReachSomething(gen, attrs);
    checkFirstZeroIsReachable(gen, attrs);
  }

  /**
   * {@code decimals=} only describes a draw that HAS a fractional part.
   *
   * <p>Two shapes reached the generator and were dropped there: {@code <gen type="number"
   * length="4" decimals="2"/>} emitted 4566, and {@code <gen type="number" value="1..9"
   * length="3" decimals="2"/>} emitted 3.78. The first has no range, so the generator produces
   * a digit STRING — an identifier — and there is nothing to round. The second has one, so
   * decimals wins and length is discarded instead: a fractional value has no integer width to
   * pad to.
   */
  private void checkDecimalsReachSomething(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String decimals = attrs.getOrDefault("decimals", "").trim();
    if (decimals.isEmpty() || "0".equals(decimals)) {
      return;
    }
    String range = attrs.getOrDefault("value", "").trim();
    if (range.isEmpty()) {
      error("TDC277",
          "decimals=\"" + decimals
              + "\" has nothing to round — without value= this generator produces a digit string",
          "Give it a range to draw from: value=\"0..100\" decimals=\"2\". A number with only "
              + "length= is an identifier of that many digits, and an identifier has no decimal "
              + "places.",
          at(gen, "decimals")[0], at(gen, "decimals")[1]);
      return;
    }
    String length = attrs.getOrDefault("length", "").trim();
    if (!length.isEmpty()) {
      error("TDC278",
          "length=\"" + length + "\" is not read beside decimals=\"" + decimals
              + "\" — a fractional value has no integer width to pad",
          "Keep one of them: decimals= for a fractional value over the range, or length= for a "
              + "whole number padded to a fixed width.",
          at(gen, "length")[0], at(gen, "length")[1]);
    }
  }

  /**
   * {@code first_zero="false"} the range can never satisfy.
   *
   * <p>A drawn value is padded to {@code length} with zeros, so it avoids a leading one only by
   * being wide enough on its own. When the range's largest value has fewer digits than the
   * width, EVERY draw needs padding — and the generator answered by redrawing a hundred times
   * and emitting the forbidden shape anyway.
   */
  private void checkFirstZeroIsReachable(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    if (!"false".equals(attrs.getOrDefault("first_zero", "").trim())) {
      return;
    }
    String range = attrs.getOrDefault("value", "").trim();
    String length = attrs.getOrDefault("length", "").trim();
    if (range.isEmpty() || length.isEmpty()) {
      return;
    }
    java.util.List<Integer> widths = new java.util.ArrayList<>();
    long biggest;
    try {
      for (io.github.nickliapin.tdc.generators.NumberGen.LengthChoice choice : io.github.nickliapin.tdc.generators.NumberGen.parseLengthChoices(length)) {
        for (int w = choice.min(); w <= choice.max(); w++) {
          widths.add(w);
        }
      }
      long found = Long.MIN_VALUE;
      for (io.github.nickliapin.tdc.generators.NumberGen.Range r : io.github.nickliapin.tdc.generators.NumberGen.parseRanges(range)) {
        found = Math.max(found, r.max());
      }
      biggest = found;
    } catch (RuntimeException e) {
      return; // a malformed range or length is already reported above
    }
    // A value renders without a leading zero at width W only if it has at least W digits of
    // its own, which needs max >= 10^(W-1).
    java.util.List<Integer> unreachable = new java.util.ArrayList<>();
    for (int w : widths) {
      if (w > 1 && biggest < Math.pow(10, w - 1)) {
        unreachable.add(w);
      }
    }
    if (unreachable.isEmpty()) {
      return;
    }
    int smallest = java.util.Collections.min(unreachable);
    String digits = unreachable.size() == 1 ? unreachable.get(0) + " digits" : smallest + " digits";
    long low = (long) Math.pow(10, smallest - 1);
    long high = (long) Math.pow(10, smallest) - 1;
    error("TDC279",
        "first_zero=\"false\" cannot be honoured — no value in \"" + range + "\" reaches "
            + digits + ", so every draw has to be padded",
        "The widest value the range offers is " + biggest + ". Widen the range — value=\"" + low
            + ".." + high + "\" — or drop length=, or allow the zero.",
        at(gen, "first_zero")[0], at(gen, "first_zero")[1]);
  }

  private void checkRegexes(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    String value = attrs.get("value");
    if (value == null || value.isBlank()) {
      return;
    }
    int limit =
        attrs.get("regex_max_length") != null
            ? safeMaxLength(attrs.get("regex_max_length"))
            : documentRegexMaxLength;

    if ("regex".equals(type)) {
      String problem = Checks.regexProblem(value, limit);
      if (problem != null) {
        error("TDC097", "invalid regex generator pattern: " + problem,
            "The subset is finite: no * or +, and every pattern has a longest output.",
            at(gen, "value")[0], at(gen, "value")[1]);
      }
    } else if ("advanced_regex".equals(type)) {
      String problem = Checks.advancedRegexProblem(value, limit);
      if (problem != null) {
        error("TDC130", "invalid advanced_regex generator pattern: " + problem,
            "Weighted branches must sum to 100.", at(gen, "value")[0], at(gen, "value")[1]);
      }
    }
  }

  private void checkSymbol(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"symbol".equals(type)) {
      return;
    }
    String value = attrs.get("value");
    String alphabet = attrs.get("alphabet");
    boolean hasValue = value != null && !value.isEmpty();
    boolean hasAlphabet = alphabet != null && !alphabet.isEmpty();

    if (hasValue && hasAlphabet) {
      error("TDC098", "<gen type=\"symbol\"> accepts either \"value\" or \"alphabet\", not both",
          "Use value=\"[a-z]\" for an inline set, or alphabet=\"cyrillic.ru.letters\" for a named one.",
          at(gen, "value")[0], at(gen, "value")[1]);
      return;
    }
    if (!hasValue && !hasAlphabet) {
      // Neither an inline set nor a named one: there is nothing to draw a character from, and the
      // generator would produce empty strings for the whole run.
      error("TDC098", "<gen type=\"symbol\"> requires a \"value\" (inline set) or \"alphabet\" (named)",
          "Use value=\"[a-z]\" for an inline set, or alphabet=\"cyrillic.ru.letters\" for a named one.",
          line(gen), column(gen));
      return;
    }
    if (hasAlphabet && !Checks.isKnownAlphabet(alphabet)) {
      error("TDC099", "unknown alphabet \"" + alphabet + "\"",
          "Known alphabets: " + String.join(", ", Checks.alphabetNames()) + ".",
          at(gen, "alphabet")[0], at(gen, "alphabet")[1]);
    }
  }

  private static String trimmed(String value) {
    return value == null ? "" : value.trim();
  }

  /** {@code step=} on a walked date axis: what it may say, and that anything reads it. */
  /**
   * Everything a date offset needs said, and nothing that contradicts it.
   *
   * <p>{@code of=} is what turns a date generator from a DRAW into an OFFSET, and the two are
   * configured by different attributes entirely. That makes the mistakes here silent ones by
   * nature: a {@code from=} written beside an {@code of=} looks like it bounds the result and does
   * nothing at all, because the result is wherever the source plus the offset lands.
   *
   * <p>The declaration-order complaint is TDC240, shared with {@code running} and {@code stat} —
   * the same rule with the same fix.
   */
  private void checkDateOffset(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String of = trimmed(attrs.get("of"));
    String plus = trimmed(attrs.get("plus"));
    if (plus.isEmpty()) {
      error("TDC264", "<gen type=\"date\" of=\"" + of + "\"> does not say how far from it",
          "Add plus=\"…\" — " + DateStep.OFFSET_SYNTAX + ". A range is drawn per row, so "
              + "plus=\"3..10d\" is the length of the stay; a single value is the same distance on "
              + "every row.",
          line(gen), column(gen));
    } else {
      DateStep.OffsetResult parsed = DateStep.parseOffset(plus);
      if (!parsed.ok()) {
        boolean order = parsed.why() == DateStep.OffsetReason.ORDER;
        error("TDC264",
            order
                ? "plus=\"" + plus + "\" counts down, not up — the low bound is above the high one"
                : "plus=\"" + plus + "\" is not an offset",
            order
                ? "Write the smaller number first. To measure BACKWARDS, make both negative: "
                    + "plus=\"-10..-3d\"."
                : "One of: " + DateStep.OFFSET_SYNTAX + ". A bare number means days.",
            at(gen, "plus")[0], at(gen, "plus")[1]);
      }
    }

    // Attributes that place a date generator's OWN draw, and so say nothing once `of=` has placed
    // it relative to another column. Listed by name because ignoring them is exactly the failure
    // this exists to prevent.
    for (String name :
        new String[] {"value", "from", "to", "range", "oldest", "youngest", "order", "step"}) {
      if (attrs.get(name) == null) {
        continue;
      }
      error("TDC264",
          name + "= is not read when the date is measured from of=\"" + of + "\"",
          "An offset lands wherever " + of + " plus the offset lands — " + name + "= would have "
              + "to contradict that to mean anything. Drop it, or drop of= and bound the draw "
              + "itself.",
          at(gen, name)[0], at(gen, name)[1]);
    }

    if (!of.isEmpty() && !declaredOrder.contains(of)) {
      error("TDC240", "of=\"" + of + "\" is not a sequence declared above this one",
          declaredOrder.isEmpty()
              ? "A date is measured from a column that already exists, so the column it reads has "
                  + "to come first."
              : "Declared above: " + String.join(", ", declaredOrder) + ".",
          at(gen, "of")[0], at(gen, "of")[1]);
    }
  }

  private void checkDateStep(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    if (attrs.get("step") == null) {
      return;
    }
    String raw = trimmed(attrs.get("step"));
    int[] where = at(gen, "step");
    DateStep.Result parsed = DateStep.parseStep(raw);

    if (!parsed.ok()) {
      // The two failures read differently because they ARE different: one is a spelling nobody
      // meant, the other a step whose meaning would depend on which half was applied first.
      boolean mixed = parsed.reason() == DateStep.Reason.MIXED;
      error(
          "TDC247",
          mixed
              ? "step=\"" + raw + "\" mixes a calendar unit with a fixed one"
              : "step=\"" + raw + "\" is not a step this engine can walk",
          mixed
              ? "A month is 28 to 31 days, so \"one month and fifteen days\" depends on which is "
                  + "applied first. Write one or the other: 45d, or 1mo."
              : "Write " + DateStep.STEP_SYNTAX
                  + ". A bare number means days, so step=\"2\" is every other day.",
          where[0], where[1]);
      return;
    }

    if (!"sequential".equals(trimmed(attrs.get("order")))) {
      error(
          "TDC248",
          "step=\"" + raw + "\" has no order=\"sequential\" on the same <gen> — nothing walks "
              + "the range",
          "Add order=\"sequential\" to walk the range one step at a time, or remove step= and let "
              + "the dates be drawn at random.",
          where[0], where[1]);
    }
  }

  /**
   * {@code weekdays="mon..fri"} — which weekdays a walked axis keeps.
   *
   * <p>A FILTER, not a step: the spacing stops being even, since Friday to Monday is a three-day
   * jump. That is why it is a separate attribute — one word for both operations would stop them
   * being combinable, and "every 15 minutes, but only on working days" is exactly what gets asked
   * for.
   */
  private void checkDateWeekdays(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    if (attrs.get("weekdays") == null) {
      return;
    }
    String raw = trimmed(attrs.get("weekdays"));
    int[] where = at(gen, "weekdays");

    if (DateStep.parseWeekdays(raw) == null) {
      error(
          "TDC249",
          "unknown weekday in weekdays=\"" + raw + "\"",
          "Names are " + String.join(", ", DateStep.WEEKDAY_NAMES)
              + " — a span like \"mon..fri\" or a list like \"sun,wed\".",
          where[0], where[1]);
      return;
    }

    if (!"sequential".equals(trimmed(attrs.get("order")))) {
      error(
          "TDC248",
          "weekdays=\"" + raw + "\" has no order=\"sequential\" on the same <gen> — nothing "
              + "walks the range",
          "Add order=\"sequential\" to walk the range and keep only these days, or remove "
              + "weekdays= and let the dates be drawn at random.",
          where[0], where[1]);
      return;
    }

    DateStep.Result step = DateStep.parseStep(attrs.get("step"));
    if (step.ok() && DateStep.fixesWeekday(step.step())) {
      // Two different reasons wear one code, and they must not wear one sentence.
      //
      // A whole number of weeks really does land on the same weekday every time, so the filter
      // matches every row or none. Measured on the STEP rather than on its spelling, so `14d` is
      // caught as surely as `2w`.
      //
      // A CALENDAR step does not: 15 January 2026 is a Thursday, 15 February a Sunday, 15 March a
      // Sunday, 15 April a Wednesday. The combination is still refused — a month holds a different
      // number of days each time — but for its own reason.
      boolean wholeWeeks = step.step().months() == 0;
      error(
          "TDC250",
          wholeWeeks
              ? "weekdays=\"" + raw + "\" cannot narrow step=\"" + trimmed(attrs.get("step"))
                  + "\" — that step already fixes the weekday"
              : "weekdays=\"" + raw + "\" cannot narrow step=\"" + trimmed(attrs.get("step"))
                  + "\" — a calendar step is not measured in days",
          wholeWeeks
              ? "A whole number of weeks lands on the same weekday every time, so this would match "
                  + "every row or none. Use a step that is not a multiple of a week, or drop "
                  + "weekdays=."
              : "A month and a year hold a different number of days each time, so which rows "
                  + "survive the filter follows the calendar rather than anything written here. "
                  + "Use a step measured in days or hours, or drop weekdays=.",
          where[0], where[1]);
    }
  }

  /**
   * {@code peak_at=} — which row the seasonal wave is highest on.
   *
   * <p>Without it the peak sits a quarter period in, which is where a plain sine already
   * peaked — and for a year of daily rows that is early April, the one season nobody means by
   * "warmer in summer". It is a ROW, not a shift: 182 of 365 is the first of July, and
   * {@code period} is already counted in rows.
   */
  /**
   * {@code repeat=} together with {@code order="sequential"}.
   *
   * <p>Well defined apart, undefined together — and the engines proved it by disagreeing:
   * engine 1 gave the row several elements that were all the SAME value and never advanced,
   * engines 2 and 3 dropped the repeat list and emitted one walking value. {@code check}
   * called that valid, so the author got data that looks plausible and is wrong differently
   * depending on which engine answered.
   */
  private void checkSequentialRepeat(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    if (!"sequential".equals(attrs.getOrDefault("order", "").trim())) {
      return;
    }
    String repeat = attrs.getOrDefault("repeat", "").trim();
    if (repeat.isEmpty()) {
      return;
    }
    // Point at `repeat=`: a walked column is what the author asked for and can keep.
    int[] where = at(gen, "repeat");
    error("TDC254",
        "repeat=\"" + repeat + "\" cannot be combined with order=\"sequential\"",
        "A walked list and a repeating list are two different columns, and together they have "
            + "no one answer — the engines disagree about what they produce. Keep "
            + "order=\"sequential\" for a column that walks its source one value per row, or "
            + "keep repeat= for several drawn values per row.",
        where[0], where[1]);
  }

  private void checkTimeseries(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"timeseries".equals(type) || attrs.get("peak_at") == null) {
      return;
    }
    String raw = attrs.get("peak_at").trim();
    int[] where = at(gen, "peak_at");

    double peak;
    try {
      peak = Double.parseDouble(raw);
    } catch (NumberFormatException e) {
      error("TDC252", "peak_at=\"" + raw + "\" is not a number",
          "peak_at is the row the seasonal wave peaks on, counted like period= — "
              + "peak_at=\"182\" over period=\"365\" puts the peak at the first of July.",
          where[0], where[1]);
      return;
    }
    if (Double.isNaN(peak)) {
      return;
    }

    // A wave needs a length before it can have a highest point. Without `period` there is no
    // wave at all, so `peak_at` would be read by nobody.
    double period;
    try {
      String rawPeriod = attrs.getOrDefault("period", "").trim();
      period = rawPeriod.isEmpty() ? 0 : Double.parseDouble(rawPeriod);
    } catch (NumberFormatException e) {
      period = 0;
    }
    if (period <= 0) {
      error("TDC253",
          "peak_at=\"" + raw + "\" has no period= on the same <gen> — there is no wave to "
              + "place a peak on",
          "Add period= (the length of one season, in rows), or remove peak_at=.",
          where[0], where[1]);
    }
  }

  private void checkDate(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"date".equals(type)) {
      return;
    }
    // `of=` makes this an OFFSET rather than a draw: a different set of attributes configures it,
    // and a different set of mistakes is possible. Its own checks REPLACE the ones below rather
    // than joining them — everything here is about how a draw is bounded, so it would be a second
    // complaint about the same attribute, naming a rule that no longer applies to it.
    if (!trimmed(attrs.get("of")).isEmpty()) {
      checkDateOffset(gen, attrs);
      return;
    }
    boolean from = attrs.get("from") != null;
    boolean to = attrs.get("to") != null;
    // `from=` alone is an OPEN axis when the range is WALKED: the end of such an axis is
    // start + count × step, a consequence rather than an input. On a DRAWN date one end genuinely
    // means nothing, and that is what this refuses.
    boolean walked = "sequential".equals(trimmed(attrs.get("order")));
    boolean openAxis = walked && from && !to;
    if (!openAxis && from != to) {
      error("TDC150", "<gen type=\"date\"> requires both \"from\" and \"to\" when either is used",
          "Use from=\"2020-01-01\" to=\"2025-12-31\", or value=\"2020-01-01..2025-12-31\".",
          line(gen), column(gen));
    }
    checkDateStep(gen, attrs);
    checkDateWeekdays(gen, attrs);
    String local = attrs.get("local");
    if (local != null && !local.isBlank() && !Checks.isKnownDateLocale(local)) {
      error("TDC153", "unknown date locale \"" + local + "\"",
          "A date locale has to be translated deliberately — month names inflect.",
          at(gen, "local")[0], at(gen, "local")[1]);
    }
    checkEnvLocaleHasDates(gen, attrs);
    checkDateCommonAttrs(gen, attrs);
    checkDateValues(gen, attrs);
  }

  /**
   * {@code <env local="af">} with a date the run will render in ENGLISH.
   *
   * <p>The same value is refused outright on {@code <gen type="date" local="af">} (TDC153) and
   * was silently downgraded here. Refusing it on {@code <env local=>} would be wrong — a locale
   * can be a perfectly good source of NAMES and still ship no month names, and refusing would
   * forbid the Afrikaans name pack because Afrikaans dates are missing. So this warns, and only
   * when the format actually reads the locale: {@code YYYY-MM-DD} is the same in every language,
   * while a missing {@code format=} is not, because the default {@code L} is a layout the locale
   * chooses. Bracketed text is stripped first — {@code [LL]} is a literal.
   */
  private void checkEnvLocaleHasDates(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    if (locale == null || locale.isEmpty() || Checks.isKnownDateLocale(locale)) {
      return;
    }
    if (attrs.containsKey("local")) {
      return; // its own local= is TDC153's business
    }
    String format = attrs.get("format");
    if (format != null && !format.isBlank()) {
      StringBuilder outside = new StringBuilder();
      boolean inside = false;
      for (char ch : format.toCharArray()) {
        if (ch == '[') {
          inside = true;
        } else if (ch == ']') {
          inside = false;
        } else if (!inside) {
          outside.append(ch);
        }
      }
      String plain = outside.toString();
      boolean readsLocale = false;
      for (String token : new String[] {"MMMM", "MMM", "dddd", "ddd", "L"}) {
        if (plain.contains(token)) {
          readsLocale = true;
          break;
        }
      }
      if (!readsLocale) {
        return;
      }
    }
    warn("TDC272",
        "<env local=\"" + locale + "\"> ships no date translations, so this date renders in "
            + "English",
        "Date locales: " + String.join(", ", io.github.nickliapin.tdc.date.DateLocales.NAMES) + ". Use format=\"YYYY-MM-DD\" "
            + "\u2014 or any format without month or weekday names \u2014 to get the same text "
            + "in every language, or accept the English month names.",
        line(gen), column(gen));
  }

  /**
   * The dates themselves parse.
   *
   * <p>Without this a {@code from="notadate"} reached the generator and failed there, which is a
   * crash at render time instead of a diagnostic at validation time — and the reference reports
   * it here.
   */
  private void checkDateValues(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    try {
      if (attrs.get("from") != null && attrs.get("to") != null) {
        DateParse.dateTime(attrs.get("from"));
        DateParse.dateTime(attrs.get("to"));
      }
      if (attrs.get("range") != null) {
        DateParse.range(attrs.get("range"));
      }
      String value = attrs.get("value") == null ? "" : attrs.get("value").trim();
      if (!value.isEmpty()) {
        checkDateValue(value);
      }
      if ("birth".equals(value)) {
        io.github.nickliapin.tdc.date.DateGen.checkBirthAges(attrs);
      }
    } catch (RuntimeException e) {
      // Whichever attribute the reader would look at first — the complaint is about the span, and
      // pointing at one of its two ends names only half of it.
      int[] where = at(gen, primaryDateAttr(attrs));
      error("TDC151", e.getMessage(),
          "Examples: value=\"2020-01-01..2025-12-31\", value=\"birth\", value=\"today\", "
              + "or value=\"now\".",
          where[0], where[1]);
    }
  }

  /** A {@code value=} that is a date, a range, or one of the words the generator knows. */
  private static void checkDateValue(String value) {
    if ("birth".equals(value) || "today".equals(value) || "now".equals(value)) {
      return;
    }
    if (value.contains("..")) {
      DateParse.range(value);
      return;
    }
    DateParse.dateTime(value);
  }

  /**
   * The attributes every date-shaped generator shares: how it is formatted, and how precise it is.
   *
   * <p>Also reached from the pack templates {@code date.range} and {@code person.b_day}, which
   * are dates wearing a different address and would otherwise skip these checks entirely.
   */
  private void checkDateCommonAttrs(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String format = attrs.get("format");
    if (format != null) {
      try {
        io.github.nickliapin.tdc.date.DateFormatter.checkFormat(format);
      } catch (RuntimeException e) {
        error("TDC152", e.getMessage(),
            "Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket "
                + "literals [text].",
            at(gen, "format")[0], at(gen, "format")[1]);
      }
    }
    if (attrs.get("precision") != null) {
      try {
        io.github.nickliapin.tdc.date.DateGen.precision(
            attrs.get("precision"), io.github.nickliapin.tdc.date.DateGen.Precision.DAY);
      } catch (RuntimeException e) {
        error("TDC154", e.getMessage(), "Supported: day, second, millisecond.",
            at(gen, "precision")[0], at(gen, "precision")[1]);
      }
    }
  }

  /** {@code oldest}/{@code youngest} on a birth date: whole ages, and in that order. */
  private void checkBirthAges(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    try {
      io.github.nickliapin.tdc.date.DateGen.checkBirthAges(attrs);
    } catch (RuntimeException e) {
      // Whichever attribute the reader would look at first — the complaint is about the span,
      // and pointing at one of its two ends names only half of it.
      int[] where = at(gen, primaryDateAttr(attrs));
      error("TDC151", e.getMessage(), "", where[0], where[1]);
    }
  }

  /** The attribute a date complaint points at, in the order the reference tries them. */
  private static String primaryDateAttr(Map<String, String> attrs) {
    for (String name : new String[] {"value", "range", "from", "to", "oldest", "youngest"}) {
      if (attrs.get(name) != null) {
        return name;
      }
    }
    return "value";
  }

  /**
   * {@code date.range} and {@code person.b_day}: pack addresses that are date generators.
   *
   * <p>They take the same attributes and can be wrong in the same ways, so they are checked the
   * same way rather than passing through as ordinary template lookups.
   */
  private void checkDateTemplates(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"template".equals(type)) {
      return;
    }
    String path = attrs.getOrDefault("value", "").trim();
    if ("date.range".equals(path)) {
      String range = attrs.get("range");
      if (range == null) {
        error("TDC072", "<gen value=\"date.range\"> requires a \"range\" attribute",
            "Syntax: range=\"YYYY.MM.DD - YYYY.MM.DD\".", line(gen), column(gen));
        return;
      }
      try {
        io.github.nickliapin.tdc.date.DateParse.legacyRange(range);
        checkDateCommonAttrs(gen, attrs);
      } catch (RuntimeException e) {
        error("TDC073", e.getMessage(),
            "Expected two valid dates in \"YYYY.MM.DD - YYYY.MM.DD\" form.",
            at(gen, "range")[0], at(gen, "range")[1]);
      }
      return;
    }
    if ("person.b_day".equals(path)) {
      checkDateCommonAttrs(gen, attrs);
      checkBirthAges(gen, attrs);
    }
  }

  /** {@code value=} and {@code step=} on a counter have to be numbers. */
  private void checkCounter(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"increment".equals(type) && !"decrement".equals(type)) {
      return;
    }
    for (String name : new String[] {"value", "step"}) {
      String raw = attrs.get(name);
      if (raw == null) {
        continue;
      }
      try {
        double v = Double.parseDouble(raw.trim());
        if (!Double.isFinite(v)) {
          throw new NumberFormatException();
        }
      } catch (NumberFormatException e) {
        error("TDC090", "invalid " + name + " \"" + raw + "\" — expected a number", "",
            at(gen, name)[0], at(gen, name)[1]);
      }
    }
  }

  /**
   * Everything a running total cannot do without.
   *
   * <p>Two things have to hold before the engine sees it, and neither is discoverable from the row
   * it stands on: it has to say WHAT to accumulate and HOW, and the column it reads has to be
   * declared ABOVE it — the same rule {@code parent=} follows, and for the same reason.
   */
  private void checkRunning(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"running".equals(type)) {
      return;
    }
    if (attrs.getOrDefault("of", "").trim().isEmpty()) {
      error("TDC239", "<gen type=\"running\"> does not say what to accumulate",
          "Name the column it adds up: of=\"Delta\". A running total reads another sequence — "
              + "it draws nothing of its own.",
          line(gen), column(gen));
    }
    if (attrs.getOrDefault("accumulate", "").trim().isEmpty()) {
      error("TDC239", "<gen type=\"running\"> does not say how to accumulate",
          "Add accumulate=\"…\" — one of: " + String.join(", ", Accumulate.OPS) + ".",
          line(gen), column(gen));
    }
    // `of=` and `reset=` both read a column, so both take the rule. Reported separately: naming
    // the wrong one would send the reader to the wrong attribute.
    for (String name : new String[] {"of", "reset"}) {
      String value = attrs.getOrDefault(name, "").trim();
      if (value.isEmpty() || declaredOrder.contains(value)) {
        continue;
      }
      error("TDC240", name + "=\"" + value + "\" is not a sequence declared above this one",
          declaredOrder.isEmpty()
              ? "A running total is built from a column that already exists, so the column it "
                  + "reads has to come first."
              : "Declared above: " + String.join(", ", declaredOrder) + ".",
          at(gen, name)[0], at(gen, name)[1]);
    }
  }

  /**
   * Everything a statistic cannot do without.
   *
   * <p>The same two things a running total needs, for the same two reasons: it has to say WHAT to
   * summarise and WHICH statistic, and the column it reads has to be declared ABOVE it. The
   * declaration-order complaint is TDC240, shared with {@code running} on purpose — the same rule
   * with the same fix.
   */
  /**
   * {@code ${{Name}}} written into an attribute that does not read it.
   *
   * <p>Interpolation reaches exactly two places: the TEXT inside {@code <data>}, and
   * {@code <gen type="template" value=>}. Everywhere else the braces are eight literal
   * characters — and the generator that receives them complains about whatever it happens to be
   * parsing: an invalid number range, an invalid date, a bad quantifier, an unknown alphabet —
   * while {@code type="text"} said nothing at all and emitted the braces. Five messages and one
   * silence for one mistake, none of them naming it.
   */
  private boolean checkAttrInterpolation(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    boolean found = false;
    for (Map.Entry<String, String> entry : attrs.entrySet()) {
      String value = entry.getValue();
      if (value == null || !value.contains("${{")) {
        continue;
      }
      // The one place it works: a pack path finished by another column.
      if ("value".equals(entry.getKey()) && "template".equals(type)) {
        continue;
      }
      error("TDC263",
          "${{…}} in " + entry.getKey() + "= is not expanded — the braces are literal text here",
          "Interpolation reaches the text inside <data> and <gen type=\"template\" value=>, and "
              + "nowhere else. To make one column depend on another, read it in an if= condition, "
              + "or build the value in a <compute> sequence.",
          at(gen, entry.getKey())[0], at(gen, entry.getKey())[1]);
      found = true;
    }
    return found;
  }

  private void checkStat(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    if (!"stat".equals(type)) {
      return;
    }
    String of = attrs.getOrDefault("of", "").trim();
    if (of.isEmpty()) {
      error("TDC262", "<gen type=\"stat\"> does not say what to summarise",
          "Name the column it reads: of=\"Price\". A statistic reads another sequence — it "
              + "draws nothing of its own.",
          line(gen), column(gen));
    }
    String rawOp = attrs.getOrDefault("op", "").trim();
    if (rawOp.isEmpty()) {
      error("TDC262", "<gen type=\"stat\"> does not say which statistic",
          "Add op=\"…\" — one of: " + String.join(", ", Stat.OPS) + ".",
          line(gen), column(gen));
    } else {
      try {
        Stat.parse(attrs);
      } catch (Stat.StatError e) {
        error("TDC262", e.getMessage(), "One of: " + String.join(", ", Stat.OPS) + ".",
            at(gen, "op")[0], at(gen, "op")[1]);
      }
    }
    try {
      Stat.parseDecimals(attrs);
    } catch (Stat.StatError e) {
      error("TDC262", e.getMessage(),
          "decimals= rounds the answer. A mean, a median and a standard deviation are ratios and "
              + "print in full without it; sum, min and max keep the exact scale of the column.",
          at(gen, "decimals")[0], at(gen, "decimals")[1]);
    }
    if (!of.isEmpty() && !declaredOrder.contains(of)) {
      error("TDC240", "of=\"" + of + "\" is not a sequence declared above this one",
          declaredOrder.isEmpty()
              ? "A statistic is built from a column that already exists, so the column it reads "
                  + "has to come first."
              : "Declared above: " + String.join(", ", declaredOrder) + ".",
          at(gen, "of")[0], at(gen, "of")[1]);
    }
  }

  /** {@code accumulate=} needs a list, and its op is one of a short closed set. */
  private void checkAccumulate(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, boolean repeats) {
    if (!attrs.containsKey("accumulate")) {
      return;
    }
    int line = at(gen, "accumulate")[0];
    int column = at(gen, "accumulate")[1];
    try {
      Accumulate.parse(attrs);
    } catch (Accumulate.AccumulateException e) {
      error("TDC238", e.getMessage(),
          "accumulate= keeps a running total across a repeat list. One of: "
              + String.join(", ", Accumulate.OPS) + ".",
          line, column);
    }
    // `type="running"` accumulates down a COLUMN, so it carries the same word with no list in
    // sight. Only the list flavour needs `repeat`.
    if (!repeats && !"running".equals(attrs.get("type"))) {
      error("TDC237", "\"accumulate\" has no effect without \"repeat\"",
          "accumulate= turns the values of a repeat list into a running total, so there has to "
              + "be a list. Add repeat=\"N\", or drop accumulate=.",
          line, column);
    }
  }

  private void checkRepeat(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    boolean repeats;
    try {
      repeats = Checks.hasRepeat(attrs);
    } catch (RuntimeException e) {
      error("TDC195", e.getMessage(),
          "Use repeat=\"3\" for a fixed count or repeat=\"1..5\" for a range (0 to 64).",
          at(gen, "repeat")[0], at(gen, "repeat")[1]);
      checkAccumulate(gen, attrs, true);
      return;
    }

    checkAccumulate(gen, attrs, repeats);

    if (repeats) {
      String reason = Checks.repeatUnsupportedReason(type);
      if (reason != null) {
        error("TDC204", "\"repeat\" is not supported on <gen type=\"" + type + "\"> — " + reason,
            "Its value comes from the row index, which a variable-length list makes unknowable.",
            at(gen, "repeat")[0], at(gen, "repeat")[1]);
      }
    } else if (attrs.get("separator") != null) {
      // A separator with nothing to separate is a request that silently does nothing.
      error("TDC198", "\"separator\" has no effect without \"repeat\"",
          "separator joins the values a repeating gen produces. Add repeat=\"N\", or drop it.",
          at(gen, "separator")[0], at(gen, "separator")[1]);
    }
  }

  /**
   * What may sit inside a {@code <case>}: literal text, one generator, or a nested mix.
   *
   * <p>A nested mix is checked as a nested one — it contributes a value to the column around it
   * and has nowhere of its own to put a flag.
   */
  /** Every attribute on a closed tag, checked against what that tag actually reads. */
  private void checkClosedTagAttrs(
      String tag, List<TDCParser.AttrContext> attrs, int line, int column) {
    Set<String> known = CLOSED_TAG_ATTRIBUTES.get(tag);
    if (known == null) {
      return;
    }
    for (Map.Entry<String, String> attr : attributes(attrs).entrySet()) {
      if (!known.contains(attr.getKey())) {
        int[] where = at(attrs, attr.getKey(), line, column);
        error("TDC015", "<" + tag + "> does not read \"" + attr.getKey() + "\" — it is ignored",
            "Attributes of <" + tag + ">: " + String.join(", ", new java.util.TreeSet<>(known)) + ".",
            where[0], where[1]);
      }
    }
  }

  /**
   * {@code if=} on a {@code <gen>} inside a {@code <case>} — accepted by the grammar, read by
   * nothing.
   *
   * <p>A case body is several parts JOINED into one value, so a condition on one part has no
   * answer to give: if it were false, the part would have to become something, and there is no
   * honest candidate. The branch already carries its own condition. It used to be accepted and
   * ignored, so the value appeared on EVERY row.
   */
  private void checkCaseGenIf(String condition, int[] pos) {
    if (condition == null) {
      return;
    }
    error("TDC269",
        "if= is not read on a <gen> inside a <case>: a case body is several parts joined, so a "
            + "condition on one part has no value to fall back to",
        "Put the condition on the branch \u2014 <case if=\"\u2026\"> \u2014 or move the <gen> "
            + "into a <sequence> of its own, where a false condition falls through to the next "
            + "<gen>.",
        pos[0], pos[1]);
  }

  /**
   * A `<gen>` written inside a `<case>`.
   *
   * <p>`anomaly_flag="NAME"` mints a ground-truth column beside a sequence's value. A case body
   * is a CONCATENATION of parts, so a flag written on one part describes that part rather than
   * the row, and there is no honest column to mint. `<mix flag="NAME">` asks the same question
   * where it has an answer. Until this check the attribute was accepted here and did nothing,
   * and the only sign was `${{NAME}}` reaching the data as literal characters.
   */
  private void checkCaseGenFlag(String flag, int[] pos) {
    if (flag == null) {
      return;
    }
    error("TDC246", "anomaly_flag=\"" + flag.trim() + "\" is not read on a <gen> inside a <case>",
        "A case body is several parts joined, so a flag on one part does not describe the row. "
            + "Put flag=\"NAME\" on the <mix> instead, or move the <gen> into a <sequence> of "
            + "its own.",
        pos[0], pos[1]);
  }

  private void checkCaseBody(TDCParser.OpenCloseElementContext caseEl) {
    for (TDCParser.ElementContext child : caseEl.content().element()) {
      if (child.dataElement() != null) {
        continue;
      }
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        checkCaseGenFlag(attributes(self.attr()).get("anomaly_flag"), at(self, "anomaly_flag"));
        checkCaseGenIf(attributes(self.attr()).get("if"), at(self, "if"));
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null) {
        continue;
      }
      if ("mix".equals(open.name.getText())) {
        checkMix(open, false);
        continue;
      }
      if ("switch".equals(open.name.getText())) {
        // A `<switch>` inside a `<case>` looks its subject up over the rows of that branch. Held
        // to every rule the env-level form is, except that it has no name.
        checkSwitchForm(open, declaredOrder, false);
        continue;
      }
      if ("gen".equals(open.name.getText())) {
        checkCaseGenFlag(attributes(open.attr()).get("anomaly_flag"), at(open, "anomaly_flag"));
        checkCaseGenIf(attributes(open.attr()).get("if"), at(open, "if"));
        continue;
      }
      error("TDC125", "unknown child of <case>: \"<" + open.name.getText() + ">\"",
          "Allowed children: data, gen, mix, switch.", line(open), column(open));
    }
  }

  /**
   * A percent mask, checked against how many things it is dividing.
   *
   * <p>Three different mistakes get three different codes, because they call for three different
   * fixes: the wrong number of entries, an entry that is not a share, and shares that do not add
   * up.
   *
   * @param codes the codes for length, number and sum, in that order — {@code <gen>},
   *     {@code <mix>} and {@code <switch>} each have their own trio.
   */
  private void checkPercentMask(
      String mask, int valueCount, String[] codes, int line, int column) {
    if (mask == null) {
      return;
    }
    try {
      PercentMask.expand(mask, valueCount);
    } catch (PercentMask.MaskException e) {
      String code =
          switch (e.kind()) {
            case LENGTH -> codes[0];
            case NUMBER -> codes[1];
            case SUM -> codes[2];
          };
      String hint =
          e.kind() == PercentMask.Kind.LENGTH
              ? "Percent masks may be shorter than value only when missing positions can be "
                  + "inferred. They may never be longer than value."
              : "Filled positions must be non-negative numbers. Empty positions split the "
                  + "remaining percent equally.";
      error(code, e.getMessage(), hint, line, column);
    } catch (RuntimeException e) {
      error(codes[2], e.getMessage(), "", line, column);
    }
  }

  /** {@code case=} and {@code order=} take one of a short list, and nothing else. */
  private void checkCaseAndOrder(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs) {
    String transform = attrs.get("case");
    if (transform != null
        && !io.github.nickliapin.tdc.format.Transforms.isCaseTransform(transform)) {
      error("TDC190", "unknown case \"" + transform + "\"",
          "Supported: "
              + String.join(", ", io.github.nickliapin.tdc.format.Transforms.CASE_TRANSFORMS)
              + ".",
          at(gen, "case")[0], at(gen, "case")[1]);
    }
    String order = attrs.get("order");
    if (order != null && !"random".equals(order) && !"sequential".equals(order)) {
      error("TDC191", "unknown order \"" + order + "\"",
          "Supported: random (the default), sequential.",
          at(gen, "order")[0], at(gen, "order")[1]);
    }
  }

  /**
   * A {@code <map>} body: one {@code KEY:VALUE} per row.
   *
   * <p>Entries are separated by commas, and a row with no colon is not a mapping — it would
   * otherwise become a key with no value, silently absent from the table the switch reads. A
   * warning rather than an error: the rest of the table still works, and the run is worth
   * finishing.
   */
  private void checkMapRows(TDCParser.MapElementContext element) {
    if (!(element instanceof TDCParser.MapWithBodyContext body)) {
      return;
    }
    int line = body.getStart().getLine();
    int column = body.getStart().getCharPositionInLine();
    for (String row : body.mapContent().getText().split(",", -1)) {
      String trimmed = row.trim();
      if (trimmed.isEmpty()) {
        continue;
      }
      if (!trimmed.contains(":")) {
        warn("TDC136", "malformed <map> row \"" + trimmed + "\" — expected KEY:VALUE",
            "Each entry is KEY:VALUE, entries separated by commas, multi-key via \"|\" "
                + "(US|CA:USD).",
            line, column);
      }
    }
  }

  /**
   * {@code type=} on a {@code <data>}: parsable, and on a piece that is actually a column.
   *
   * <p>A type on an unnamed {@code <data>} is a request that does nothing — only a named one
   * becomes a column, so the declaration would be quietly dropped.
   */
  private void checkDataType(TDCParser.DataWithBodyContext body, int line, int column) {
    Map<String, String> attrs = attributes(body.attr());
    String rawType = attrs.get("type");
    if (rawType == null) {
      return;
    }
    int[] where = at(body.attr(), "type", line, column);
    String name = attrs.get("name");
    if (name == null || name.trim().isEmpty()) {
      error("TDC194", "type=\"" + rawType + "\" has no name — only a named <data> becomes a column",
          "Add name=\"…\" to export this as a typed column, or drop type=.", where[0], where[1]);
      return;
    }
    try {
      io.github.nickliapin.tdc.output.ColumnType.parseOutput(rawType);
    } catch (RuntimeException e) {
      error("TDC194", e.getMessage(),
          "Types: bool, int32, int64, uint8/16/32/64, float, float16, double, string, enum, "
              + "date, timestamp, decimal(p,s), uuid, json; []T for a list; |null to allow NULL.",
          where[0], where[1]);
    }
  }

  /** How many entries a comma-separated attribute holds. */
  private static int splitCount(String value) {
    return value.split(",", -1).length;
  }

  private int safeMaxLength(String raw) {
    try {
      return RegexGen.parseMaxLength(raw);
    } catch (RuntimeException e) {
      return documentRegexMaxLength;
    }
  }

  private void checkWeight(
      TDCParser.SelfClosingElementContext gen, Map<String, String> attrs, String type) {
    String weight = attrs.get("weight");
    if (weight == null || weight.isBlank()) {
      return;
    }
    if (!"file".equals(type)) {
      error("TDC211", "\"weight\" applies to <gen type=\"file\">, not type=\"" + (type == null ? "" : type) + "\"",
          "For inline values, percent= states the shares.", at(gen, "weight")[0], at(gen, "weight")[1]);
      return;
    }
    if (attrs.get("column") == null || attrs.get("column").isBlank()) {
      error("TDC212", "\"weight\" needs \"column\" — the weights live in a second CSV column",
          "Name the value column too.", at(gen, "weight")[0], at(gen, "weight")[1]);
    }
    if (attrs.get("order") != null) {
      error("TDC213", "\"weight\" cannot be combined with \"order\" — that walks rows by position, not by share",
          "Drop one of them.", at(gen, "weight")[0], at(gen, "weight")[1]);
    }
  }

  // ── block ────────────────────────────────────────────────────────────────────────────────

  private void checkBlock(TDCParser.OpenCloseElementContext block) {
    // These two were missed when the other containers were closed: an invented tag in
    // either passed in silence while the same tag one level up did not.
    checkChildren(block.content(), "block", BLOCK_CHILDREN, "TDC013", BLOCK_CHILDREN);
    for (TDCParser.ElementContext child : block.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "line".equals(open.name.getText())) {
        checkChildren(open.content(), "line", LINE_CHILDREN, "TDC013", LINE_CHILDREN);
        checkLine(open);
      }
    }
  }

  /**
   * A {@code <line>} holds text, and only text.
   *
   * <p>The block describes the shape of the output, not where values come from. A generator
   * placed here would produce a value nothing else could reference, and a construct like a
   * switch would be building a column in the middle of a layout.
   */
  private void checkLine(TDCParser.OpenCloseElementContext line) {
    checkClosedTagAttrs("line", line.attr(), line(line), column(line));
    // `if=` sits on the <line> as well as on each <data> inside it, and an unparsable one has to
    // be caught in both places or a whole line silently never renders.
    // `_item` and `_item_id` exist only while a line walks a list, and both the line's own
    // condition and every <data> inside it may name them.
    boolean walksAList = attributes(line.attr()).get("each") != null;
    String lineCondition = attributes(line.attr()).get("if");
    if (lineCondition != null) {
      int[] where = at(line.attr(), "if", line(line), column(line));
      checkIfExpression(lineCondition, where[0], where[1]);
      pendingExpressions.add(
          new Pending(diagnostics.size(), lineCondition, where[0], where[1], walksAList));
    }
    String each = attributes(line.attr()).get("each");
    if (each != null) {
      if (each.isBlank()) {
        error("TDC206", "each=\"\" names no sequence",
            "Give it the name of a repeating sequence, or drop the attribute.",
            at(line, "each")[0], at(line, "each")[1]);
      } else if (declaredNames.contains(each) && !repeatingNames.contains(each)) {
        // Walking a scalar would emit one line and look like it worked, which is the kind of
        // near-miss that survives review.
        error("TDC207", "each=\"" + each + "\" — that sequence holds one value, not a list",
            "Add repeat= to its <gen>, e.g. repeat=\"1..5\", or drop each=.",
            at(line, "each")[0], at(line, "each")[1]);
      }
      // A typed column is collected once per record, and an each= line emits several. The two
      // cannot both be true, so the column would silently take whichever element came last.
      for (TDCParser.ElementContext child : line.content().element()) {
        TDCParser.DataElementContext data = child.dataElement();
        if (!(data instanceof TDCParser.DataWithBodyContext body)) {
          continue;
        }
        String columnName = attributes(body.attr()).get("name");
        if (columnName != null && !columnName.trim().isEmpty()) {
          error("TDC209",
              "a named <data name=\"" + columnName + "\"> cannot sit inside an each= line",
              "Typed columns are collected once per card. For columnar output keep the list as "
                  + "a list column (type=\"[]…\"); each= is for text and SQL.",
              at(line, "each")[0], at(line, "each")[1]);
        }
      }
    }

    for (TDCParser.ElementContext child : line.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        error("TDC131", "a <gen> is not allowed inside <line> — the output block is for formatting only",
            "Declare it as a <sequence> in <env> and reference it with ${{Name}}.",
            line(self), column(self));
        continue;
      }
      TDCParser.DataElementContext data = child.dataElement();
      if (data instanceof TDCParser.DataWithBodyContext body) {
        checkClosedTagAttrs("data", body.attr(), line(line), column(line));
        checkDataType(body, line(line), column(line));
        // The <data> element, not the <line> around it: several <data> pieces can share a
        // line, and pointing at the line would name the wrong one whenever they do.
        checkInterpolation(
            PairedData.restore(body.dataContent().getText()),
            body.getStart().getLine(),
            body.getStart().getCharPositionInLine());
        String condition = attributes(body.attr()).get("if");
        if (condition != null) {
          int[] where = at(body.attr(), "if", line(line), column(line));
          checkIfExpression(condition, where[0], where[1]);
          pendingExpressions.add(
              new Pending(diagnostics.size(), condition, where[0], where[1], walksAList));
        }
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && !"data".equals(open.name.getText())) {
        error("TDC132",
            "a <" + open.name.getText() + "> is not allowed inside <line> — the output block is for formatting only",
            "Move it into <env>.", line(open), column(open));
      }
    }
  }

  /**
   * Every {@code ${{…}}} in a line: the name has to exist, and each filter has to be one.
   *
   * <p>A name nobody declared is printed literally, so a typo reaches the output looking like
   * data. An unknown filter is simply ignored, so the value comes out unformatted and correct
   * enough to pass a glance.
   */
  private void checkInterpolation(String text, int line, int column) {
    java.util.regex.Matcher m = INTERPOLATION.matcher(text);
    while (m.find()) {
      String[] parts = m.group(1).split("\\|", -1);
      String name = parts[0].trim();
      if (poolReferences.contains(name)) {
        // A reference draws a whole MEMBER, so it has no single value to print. Without this it
        // reached the output as literal text: a name that exists, resolves to nothing, and says
        // nothing.
        List<String> fields = new ArrayList<>();
        for (String declaredName : declaredNames) {
          if (declaredName.startsWith(name + ".")) {
            fields.add(declaredName.substring(name.length() + 1));
          }
        }
        java.util.Collections.sort(fields);
        List<String> shown = new ArrayList<>();
        for (String field : fields) {
          shown.add("${{" + name + "." + field + "}}");
        }
        error("TDC229",
            "\"" + name + "\" draws a whole member from a pool — it has no value of its own to print",
            fields.isEmpty()
                ? "Read one of its fields: ${{" + name + ".field}}."
                : "Read a field: " + String.join(", ", shown) + ".",
            line, column);
        continue;
      }
      if (!name.isEmpty() && !declaredNames.contains(name) && !Checks.isBuiltin(name)) {
        error("TDC193", "\"" + name + "\" is not a declared sequence — it would be printed literally",
            "Declare it in <env>, or change the inject= pattern if the text is meant to be literal.",
            line, column);
      }
      for (int i = 1; i < parts.length; i++) {
        String filter = parts[i];
        int colon = filter.indexOf(':');
        String kind = (colon < 0 ? filter : filter.substring(0, colon)).trim();
        String arg = colon < 0 ? null : filter.substring(colon + 1);

        // A mask with no pattern has nothing to keep, and the engine answered that literally:
        // it returned the empty string and the column came out blank. Every other bare filter
        // is a whole transform on its own, so this one reads like them and is not.
        if ("mask".equals(kind) && (arg == null || arg.isBlank())) {
          error("TDC256", "the \"mask\" filter needs a pattern — ${{X|mask}} empties the column",
              "Write the pattern after a colon: ${{X|mask:xxx-xx}}. `x` keeps a character, `w` "
                  + "keeps a whole word, `*` hides one — see the masks guide.",
              line, column);
          continue;
        }
        // The same parse the mask= attribute gets. Written as a filter it reached the renderer
        // unchecked.
        if ("mask".equals(kind)) {
          try {
            io.github.nickliapin.tdc.format.Mask.check(arg);
          } catch (RuntimeException e) {
            error("TDC199", e.getMessage(),
                "Indices are 0-based; ranges use \"..\", e.g. mask:x[0..3] or mask:w[-1], w[0].",
                line, column);
          }
          continue;
        }
        if (!kind.isEmpty() && !Checks.isKnownFilter(kind)) {
          error("TDC192", "unknown interpolation filter \"" + kind + "\"",
              "Supported: " + String.join(", ", io.github.nickliapin.tdc.format.Transforms.FILTER_NAMES) + ".",
              line, column);
          continue;
        }
        // The name is known. Now the part after the colon, which reached the renderer unread
        // until TDC273/TDC274/TDC275.
        checkFilterArg(kind, arg, line, column);
      }
    }
  }

  /** Filters whose whole job is the transform; an argument reaches nothing. */
  private static final String[] NO_ARGUMENT_FILTERS =
      {"trim", "sql", "upper", "lower", "capitalize", "title"};

  /** {@code -3}, {@code 0}, {@code 12} — nothing else. */
  private static Long wholeNumber(String text) {
    String t = text.trim();
    String body = t.startsWith("-") ? t.substring(1) : t;
    if (body.isEmpty()) {
      return null;
    }
    for (int i = 0; i < body.length(); i++) {
      char ch = body.charAt(i);
      if (ch < '0' || ch > '9') {
        return null;
      }
    }
    try {
      return Long.valueOf(t);
    } catch (NumberFormatException e) {
      return null;
    }
  }

  /**
   * The ARGUMENT of an interpolation filter — the part after the colon.
   *
   * <p>The filter NAME has been checked since TDC192, and a mask pattern since TDC199/TDC256.
   * The argument of every other filter reached the renderer unread, and the renderer is lenient
   * by design: {@code applyGroup} returns the value untouched when the size is not a usable
   * number, {@code applyCompact} when the base is outside 2..36. That leniency is right at
   * render time — one bad row must not abort a million-row run — but it means the config says
   * one thing and the output does another, with nothing said anywhere.
   *
   * <p>Not refused, deliberately: {@code group} and {@code compact} with no argument (both have
   * a documented default), {@code csv:;} (the delimiter is accepted and ignored on purpose), and
   * a negative {@code slice} index. Only a from/to pair of the SAME sign can be proven empty;
   * with mixed signs the answer depends on the value's length, and a refusal has to be a proof.
   */
  private void checkFilterArg(String kind, String arg, int line, int column) {
    for (String name : NO_ARGUMENT_FILTERS) {
      if (name.equals(kind)) {
        if (arg != null) {
          error("TDC274",
              "the \"" + kind + "\" filter takes no argument — \":" + arg
                  + "\" is read by nothing",
              "Write ${{X|" + kind + "}}. Chain filters with more pipes instead: ${{X|trim|"
                  + kind + "}}.",
              line, column);
        }
        return;
      }
    }
    if ("replace".equals(kind) && (arg == null || arg.isEmpty() || arg.charAt(0) == ',')) {
      error("TDC275",
          "the \"replace\" filter needs something to look for — ${{X|replace}} changes nothing",
          "Write both parts: ${{X|replace:from,to}}. Leave the second empty to delete: "
              + "${{X|replace:-,}}.",
          line, column);
      return;
    }
    if ("slice".equals(kind)) {
      if (arg == null || arg.trim().isEmpty()) {
        error("TDC273",
            "the \"slice\" filter needs a start index — ${{X|slice}} keeps the whole value",
            "Write ${{X|slice:0,4}} for the first four characters, or ${{X|slice:-3}} for the "
                + "last three. Indices are 0-based and the end is exclusive.",
            line, column);
        return;
      }
      String[] parts = arg.split(",", -1);
      Long start = wholeNumber(parts[0]);
      String rawTo = parts.length > 1 ? parts[1] : null;
      boolean hasTo = rawTo != null && !rawTo.trim().isEmpty();
      Long end = hasTo ? wholeNumber(rawTo) : null;
      if (start == null || (hasTo && end == null)) {
        error("TDC273",
            "\"slice:" + arg + "\" is not a pair of indices — the value comes out unsliced",
            "Indices are whole numbers, 0-based, end exclusive: ${{X|slice:0,4}}. A negative "
                + "index counts from the end: ${{X|slice:-3}}.",
            line, column);
        return;
      }
      // Same sign, so the ORDER is decidable without knowing the value's length.
      if (end != null && (start >= 0) == (end >= 0) && start > end) {
        error("TDC273",
            "\"slice:" + arg + "\" ends before it starts — the column comes out empty",
            "Swap them: ${{X|slice:" + end + "," + start + "}}. The end is exclusive, so 0,4 is "
                + "four characters.",
            line, column);
      }
      return;
    }
    if ("group".equals(kind) && arg != null && !arg.isEmpty()) {
      Long size = wholeNumber(arg.split(",", -1)[0]);
      if (size == null || size <= 0) {
        error("TDC273",
            "\"group:" + arg + "\" is not a group size — the value comes out ungrouped",
            "The size is a whole number above zero, counted from the RIGHT: ${{X|group:3}} "
                + "\u2192 1 234 567. A separator follows it: ${{X|group:4,-}}.",
            line, column);
      }
      return;
    }
    if ("compact".equals(kind) && arg != null && !arg.isEmpty()) {
      Long radix = wholeNumber(arg);
      if (radix == null || radix < 2 || radix > 36) {
        error("TDC273",
            "\"compact:" + arg + "\" is not a base between 2 and 36 — the number comes out "
                + "unchanged",
            "The base is a whole number from 2 to 36; 36 is the default and the shortest. "
                + "Base 1 has no digits to write with, and there are only 36 letters and digits.",
            line, column);
      }
    }
  }

  /**
   * The names an {@code if=} expression uses, checked against what exists.
   *
   * <p>An identifier that names no sequence is not an error by itself — it is how a bare word
   * works: {@code if="Gender == Male"} compares against the literal {@code Male}, and the
   * documentation is written that way throughout. What decides is WHERE the identifier sits:
   *
   * <ul>
   *   <li>the whole condition ({@code if="Ready"}, {@code if="!Ready"}) — a name. An unknown one
   *       is its own name as a string, which is never empty, so the branch fires on every row.
   *   <li>the left of a comparison, and anything arithmetic — a name. An unknown one equals
   *       nothing, so the branch fires on no row.
   *   <li>the right of a comparison — left alone. {@code A == B} is a value comparison when B is
   *       declared and a bare word when it is not, and both are meant.
   * </ul>
   *
   * <p>A dot is read the same two ways the engine reads it: {@code Person.FirstName} is a field of
   * a compound, {@code Gender.Male} asks whether Gender came out {@code Male}. So the root must
   * always exist, and the tail is checked only where the root is a compound.
   */
  private void checkExpressionNames(String expression, int line, int column, boolean each) {
    io.github.nickliapin.tdc.expr.Expr parsed;
    try {
      parsed = io.github.nickliapin.tdc.expr.Expr.parse(expression);
    } catch (RuntimeException e) {
      return; // Already reported as TDC100; there is no tree to walk.
    }
    walkExpressionNames(parsed, line, column, each, true);
  }

  private void walkExpressionNames(
      io.github.nickliapin.tdc.expr.Expr node, int line, int column, boolean each, boolean asName) {
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Name name) {
      if (asName) {
        checkExpressionName(name.value(), line, column, each);
      }
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Member member) {
      if (asName) {
        checkExpressionName(member.dotted(), line, column, each);
      }
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Unary unary) {
      walkExpressionNames(unary.operand(), line, column, each, asName);
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Binary binary) {
      // Each side of && or || is a condition in its own right; arithmetic on a bare word is
      // meaningless, so both sides are names there; on a comparison the right side may be the
      // word to match.
      boolean logical = "&&".equals(binary.op()) || "||".equals(binary.op());
      boolean comparison = COMPARISON_OPERATORS.contains(binary.op());
      walkExpressionNames(binary.left(), line, column, each, true);
      walkExpressionNames(binary.right(), line, column, each, logical || !comparison);
    }
  }

  /**
   * The values a sequence will actually produce, when the config says so outright.
   *
   * <p>Only one unnamed {@code <gen type="text" value="a,b,c">} qualifies — a text generator's
   * list is always literal, never a file or a pack, so what is written is what comes out.
   *
   * <p>Unless something rewrites it. {@code case="upper"} turns {@code Male} into {@code MALE} and
   * {@code mask="xxxx"} turns {@code Female} into {@code Fema}, so a comparison against the
   * written word would then be wrong in both directions — flagging a config that works and
   * accepting one that never matches. {@code repeat=} makes the value a list rather than a word.
   * Any of the three, and the values stop being knowable from here.
   */
  private static List<String> finiteTextValues(Map<String, String> gen) {
    if (!"text".equals(gen.get("type"))) {
      return null;
    }
    for (String rewrites : List.of("case", "mask", "repeat")) {
      if (gen.containsKey(rewrites)) {
        return null;
      }
    }
    String raw = gen.get("value");
    if (raw == null || raw.isBlank()) {
      return null;
    }
    List<String> values = new ArrayList<>();
    for (String piece : raw.split(",", -1)) {
      values.add(piece.trim());
    }
    return values;
  }

  private void checkExpressionName(String path, int line, int column, boolean each) {
    int dot = path.indexOf('.');
    String root = dot < 0 ? path : path.substring(0, dot);
    String tail = dot < 0 ? null : path.substring(dot + 1);

    boolean known = declaredNames.contains(root)
        || Checks.BUILTINS.contains(root)
        || (each && ("_item".equals(root) || "_item_id".equals(root)));
    if (!known) {
      String hint = tail == null
          ? "A condition that is a bare word is always true. Name a sequence declared in <env>, "
              + "or compare against the word: Gender == Male."
          : "Name a sequence declared in <env>. A word on the RIGHT of a comparison is a literal "
              + "and needs no declaration.";
      error("TDC215",
          "\"" + path + "\" is not a declared sequence — the condition reads it as the literal "
              + "text \"" + path + "\"",
          hint, line, column);
      return;
    }

    if (tail == null) {
      return;
    }

    // On a plain sequence the tail is a VALUE — Gender.Male asks whether Gender came out Male —
    // and where the config says outright what it produces, a value that is not among them makes a
    // branch nothing can take.
    if (!valuelessNames.contains(root)) {
      List<String> values = finiteValues.get(root);
      if (values == null || values.contains(tail)) {
        return;
      }
      warn("TDC216",
          "\"" + path + "\" — \"" + root + "\" never produces \"" + tail
              + "\", so this branch can never be taken",
          "\"" + root + "\" produces: " + String.join(", ", values) + ".",
          line, column);
      return;
    }
    int inner = tail.indexOf('.');
    String field = inner < 0 ? tail : tail.substring(0, inner);
    if (declaredNames.contains(root + "." + field)) {
      return;
    }
    List<String> fields = new ArrayList<>();
    for (String name : declaredNames) {
      if (name.startsWith(root + ".")) {
        fields.add(name.substring(root.length() + 1));
      }
    }
    error("TDC215",
        "\"" + path + "\" is not a field of \"" + root + "\" — the condition can never be true",
        fields.isEmpty()
            ? "\"" + root + "\" has no fields."
            : "Fields of \"" + root + "\": " + String.join(", ", fields) + ".",
        line, column);
  }

  /**
   * The XML entities somebody writes in an expression, and what they meant.
   *
   * <p>The config LOOKS like XML, so {@code filter="price &amp;lt;= Budget"} is what a careful
   * person writes. TDC does not expand entities, so the parser sees nine characters where a
   * {@code <} was meant and reports the character it tripped over, which tells the reader nothing
   * about what to change.
   */
  private static final String[][] XML_ENTITIES = {
    {"&lt;", "<"}, {"&gt;", ">"}, {"&amp;", "&"}, {"&quot;", "\""}, {"&apos;", "'"}
  };

  private static String[] xmlEntity(String expression) {
    for (String[] pair : XML_ENTITIES) {
      if (expression.contains(pair[0])) {
        return pair;
      }
    }
    return null;
  }

  private void checkIfExpression(String expression, int line, int column) {
    io.github.nickliapin.tdc.expr.Expr parsed;
    try {
      parsed = io.github.nickliapin.tdc.expr.Expr.parse(expression);
    } catch (RuntimeException e) {
      String[] entity = xmlEntity(expression);
      if (entity == null) {
        error("TDC100", "invalid if expression \"" + clip(expression) + "\": " + e.getMessage(),
            "Supported: comparison, && || !, and arithmetic.", line, column);
      } else {
        error("TDC100",
            "invalid if expression \"" + clip(expression) + "\": TDC does not expand XML entities,"
                + " so \"" + entity[0] + "\" is " + entity[0].length()
                + " literal characters, not \"" + entity[1] + "\"",
            "write " + entity[1] + " directly — the config is XML-shaped but it is not XML,"
                + " and the raw character is what the expression parser reads",
            line, column);
      }
      return;
    }
    checkExprNode(parsed, line, column);
  }

  /**
   * Every operator in a parsed condition, checked against the ones the engine implements.
   *
   * <p>A parser that is more permissive than the evaluator is a trap: the config is accepted, and
   * the operator it asked for is quietly not the operator it gets.
   */
  private void checkExprNode(io.github.nickliapin.tdc.expr.Expr node, int line, int column) {
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Arr array) {
      // Reached only when nothing marked it as an `in` right-hand side: the Binary branch
      // checks its own right operand before recursing.
      error("TDC259", "a [list] is only allowed on the right of \"in\"",
          "Write Country in [US, CA, MX]. A list has no meaning on its own.", line, column);
      for (io.github.nickliapin.tdc.expr.Expr item : array.items()) {
        checkExprNode(item, line, column);
      }
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Conditional ternary) {
      checkExprNode(ternary.test(), line, column);
      checkExprNode(ternary.consequent(), line, column);
      checkExprNode(ternary.alternate(), line, column);
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Binary binary) {
      if (binary.op().equals("in")
          && binary.right() instanceof io.github.nickliapin.tdc.expr.Expr.Arr members) {
        // The one place a list belongs: check its items, not the list itself.
        checkExprNode(binary.left(), line, column);
        for (io.github.nickliapin.tdc.expr.Expr item : members.items()) {
          checkExprNode(item, line, column);
        }
        return;
      }
      if (!SUPPORTED_BINARY_OPERATORS.contains(binary.op())) {
        error("TDC101", "unsupported operator \"" + binary.op() + "\" in if expression",
            "Supported binary operators: " + String.join(" ", SUPPORTED_BINARY_OPERATORS)
                + ". Functions: " + String.join(", ", EXPR_FUNCTION_NAMES)
                + ". Anything an expression cannot say, a <compute> sequence can — it has integer "
                + "division, remainders, string surgery and checksums — and the sequence it "
                + "produces is what if= then compares.",
            line, column);
      }
      checkExprNode(binary.left(), line, column);
      checkExprNode(binary.right(), line, column);
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Call call) {
      int[] spec = EXPR_FUNCTIONS.get(call.callee());
      if (spec == null) {
        boolean planned = PLANNED_EXPR_FUNCTIONS.contains(call.callee());
        error("TDC257",
            planned
                ? call.callee() + "() is not available yet in an if expression"
                : "unknown function \"" + call.callee() + "\" in if expression",
            planned
                ? "TDC computes its own mathematics rather than calling each language's, because "
                    + "the libms disagree in the last bit and a comparison turns that bit into a "
                    + "different row. So " + call.callee() + " arrives once it has been built and "
                    + "pinned to its bits in all five implementations, not before. Available "
                    + "today: " + String.join(", ", EXPR_FUNCTION_NAMES) + "."
                : "Available: " + String.join(", ", EXPR_FUNCTION_NAMES) + ".",
            line, column);
        return;
      }
      int given = call.args().size();
      if (given < spec[0] || given > spec[1]) {
        String wants =
            spec[1] == Integer.MAX_VALUE
                ? "at least " + spec[0]
                : spec[0] == spec[1] ? "exactly " + spec[0] : spec[0] + " to " + spec[1];
        error("TDC258",
            call.callee() + "() takes " + wants + " argument" + (spec[1] == 1 ? "" : "s")
                + ", got " + given,
            "", line, column);
      }
      if ("at".equals(call.callee())) {
        checkAtCall(call, line, column);
      }
      for (io.github.nickliapin.tdc.expr.Expr arg : call.args()) {
        checkExprNode(arg, line, column);
      }
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Computed computed) {
      error("TDC103", "computed member access is not supported in if expression",
          "Use plain dotted access like Gender.Male or Person.FirstName.", line, column);
      checkExprNode(computed.object(), line, column);
      return;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Unary unary) {
      if (!SUPPORTED_UNARY_OPERATORS.contains(unary.op())) {
        error("TDC102", "unsupported unary operator \"" + unary.op() + "\" in if expression",
            "Supported unary operators: " + String.join(" ", SUPPORTED_UNARY_OPERATORS) + ".",
            line, column);
      }
      checkExprNode(unary.operand(), line, column);
    }
  }

  /**
   * {@code at(subject, index)}, checked before the run rather than during it.
   *
   * <p>Both halves are provable from the text alone. A name always resolves to a STRING — a
   * {@code repeat} list arrives joined, never as a list — so {@code at(Items, 1)} can only ever
   * answer with nothing, and that nothing is indistinguishable from a legitimately short row. An
   * index written out as {@code -1}, {@code 1.5} or {@code "one"} is the same kind of mistake one
   * level down.
   *
   * <p>The engine refuses both at run time as well; this is the earlier, better-placed half of the
   * same rule, because {@code check} points at the character.
   */
  private void checkAtCall(
      io.github.nickliapin.tdc.expr.Expr.Call call, int line, int column) {
    if (!call.args().isEmpty() && provablyNotAList(call.args().get(0))) {
      error("TDC260", "at() needs a list, and this argument is a single value",
          "A repeat list reaches an expression as its joined text, so cut it first: "
              + "at(split(Items, \",\"), 1).",
          line, column);
    }
    if (call.args().size() > 1) {
      String bad = badIndexLiteral(call.args().get(1));
      if (bad != null) {
        error("TDC261", "at() index must be a whole number of zero or more, not " + bad,
            "Elements count from zero: at(list, 0) is the first. Past the end is empty text "
                + "— ask count(list) first.",
            line, column);
      }
    }
  }

  /** Whether a subexpression can be shown, from the text alone, never to be a list. */
  private static boolean provablyNotAList(io.github.nickliapin.tdc.expr.Expr node) {
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Call call) {
      return !LIST_RETURNING_FUNCTIONS.contains(call.callee());
    }
    return node instanceof io.github.nickliapin.tdc.expr.Expr.Name
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Member
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Num
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Int
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Str
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Bool
        || node instanceof io.github.nickliapin.tdc.expr.Expr.Null;
  }

  /** A written-out index that is not one, as it should read back in the message. */
  private static String badIndexLiteral(io.github.nickliapin.tdc.expr.Expr node) {
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Str s) {
      return "\"" + s.value() + "\"";
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Int n) {
      return n.value() < 0 ? String.valueOf(n.value()) : null;
    }
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Num d) {
      return d.value() != Math.floor(d.value()) || d.value() < 0 ? literalText(d.value()) : null;
    }
    // A parser that does not fold a sign into the literal leaves a minus in front of it; this one
    // folds, so the branch is a belt to the braces.
    if (node instanceof io.github.nickliapin.tdc.expr.Expr.Unary unary && "-".equals(unary.op())) {
      if (unary.operand() instanceof io.github.nickliapin.tdc.expr.Expr.Int n) {
        return "-" + n.value();
      }
      if (unary.operand() instanceof io.github.nickliapin.tdc.expr.Expr.Num d) {
        return "-" + literalText(d.value());
      }
    }
    return null;
  }

  /** A double as a person wrote it: whole numbers without a point, as JavaScript prints. */
  private static String literalText(double value) {
    return value == Math.floor(value) && !Double.isInfinite(value)
        ? String.valueOf((long) value)
        : String.valueOf(value);
  }

  // ── placement ────────────────────────────────────────────────────────────────────────────

  private void checkChildren(TDCParser.ContentContext content, String parent, Set<String> allowed) {
    checkChildren(content, parent, allowed, "TDC010", allowed);
  }

  /**
   * Report every child not on {@code allowed}.
   *
   * <p>{@code allowed} is what PASSES; {@code shown} is what the note lists. They differ for
   * {@code <pool>}, where several tags are refused by a diagnostic of their own (TDC230) and so
   * must not be reported here — but must not be offered as allowed either.
   */
  private void checkChildren(TDCParser.ContentContext content, String parent, Set<String> allowed,
      String code, Set<String> shown) {
    if (content == null) {
      return;
    }
    for (TDCParser.ElementContext child : content.element()) {
      String name = null;
      int line = 0;
      int column = 0;
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (open != null) {
        name = open.name.getText();
        line = line(open);
        column = column(open);
      } else if (self != null) {
        name = self.name.getText();
        line = line(self);
        column = column(self);
      } else if (child.mapElement() != null) {
        name = "map";
        line = 1;
        column = 0;
      } else if (child.dataElement() != null) {
        // `<data>` is its own node in the grammar, so this walk used to step over it in silence —
        // which is how `<before><data>x</data></before>` came to validate and render nothing at
        // all. Parents that take a `<data>` have it on `allowed` and pass the check below; the
        // fixtures do not, and now say so.
        TDCParser.DataElementContext data = child.dataElement();
        name = "data";
        line = data.getStart().getLine();
        column = data.getStart().getCharPositionInLine();
      }
      if (name == null || allowed.contains(name)) {
        continue;
      }
      // Two different mistakes, and two different fixes. A construct this language knows is in
      // the wrong place and needs moving; a tag nobody has heard of is a typo and needs
      // correcting. One code for both would tell the author neither.
      String hint = PLACEMENT_HINTS.get(name);
      if (hint != null) {
        error("TDC013", "<" + name + "> is not allowed directly inside <" + parent + ">",
            hint + " Allowed inside <" + parent + ">: "
                + String.join(", ", new java.util.TreeSet<>(shown)) + ".",
            line, column);
      } else if ("TDC013".equals(code)) {
        // TDC013 means "a tag this language knows, in the wrong place" and TDC010 "a tag
        // nobody has heard of", so the sentence follows the code rather than the call site.
        error("TDC013", "<" + name + "> is not allowed directly inside <" + parent + ">",
            "Allowed inside <" + parent + ">: "
                + String.join(", ", new java.util.TreeSet<>(shown)) + ".",
            line, column);
      } else {
        // The note is what a reader acts on, so every container says it the same way.
        error(code, "unknown child of <" + parent + ">: \"<" + name + ">\"",
            "Allowed inside <" + parent + ">: "
                + String.join(", ", new java.util.TreeSet<>(shown)) + ".",
            line, column);
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────

  /**
   * {@code <assert that="…" says="…"/>} — the two attributes it cannot do without.
   *
   * <p>An assertion is the one construct whose whole worth is that it FAILS, so a half-written one
   * is worse than none: the config carries a check, the reader believes the run was verified, and
   * nothing was ever compared.
   *
   * <p>The expression is not re-checked here. {@code that=} is the {@code if=} language, so it
   * takes the same syntax pass now and the same put-aside name pass once every sequence is known —
   * a typo in a column name is reported exactly as it is in {@code if=}, because it IS that
   * mistake.
   */
  private void checkAsserts(TDCParser.OpenCloseElementContext env) {
    for (TDCParser.ElementContext child : env.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self == null || !self.name.getText().equals("assert")) {
        continue;
      }
      // A self-closing tag is not reached by the walk that checks closed-tag attributes, so an
      // unknown one on <assert> would pass in silence.
      checkClosedTagAttrs("assert", self.attr(), line(self), column(self));
      Map<String, String> attrs = attributes(self.attr());
      String that = attrs.getOrDefault("that", "").trim();
      String says = attrs.getOrDefault("says", "").trim();
      if (that.isEmpty()) {
        int[] where = at(self, "that");
        error(
            "TDC265",
            "<assert> has no condition — that= is required",
            "Write the property the run must have, in the if= language, over whole-run columns: "
                + "<assert that=\"Rows == 700\" says=\"…\"/>. The numbers come from "
                + "<gen type=\"stat\">.",
            where[0],
            where[1]);
        continue;
      }
      if (says.isEmpty()) {
        int[] where = at(self, "says");
        error(
            "TDC266",
            "<assert that=\"" + that + "\"> has no message — says= is required",
            "When this fails, says= is what the reader is told. An expression alone leaves them to "
                + "work out what it was for, months later, in a CI log.",
            where[0],
            where[1]);
      }
      int[] where = at(self, "that");
      checkIfExpression(that, where[0], where[1]);
      pendingExpressions.add(new Pending(diagnostics.size(), that, where[0], where[1], false));
    }
  }

  private void error(String code, String message, String hint, int line, int column) {
    diagnostics.add(Diagnostic.error(code, message, hint, line, column));
  }

  /** Worth saying, not worth stopping for: the run still produces usable data. */
  private void warn(String code, String message, String hint, int line, int column) {
    diagnostics.add(Diagnostic.warning(code, message, hint, line, column));
  }

  /**
   * Where an attribute's value sits, for a complaint that is about that value.
   *
   * <p>An editor underlines what a diagnostic points at, and a whole tag is not what is wrong
   * when one attribute is. The position is the first character INSIDE the quotes, which is where
   * the value the message is quoting actually begins.
   *
   * <p>Falls back to the element when the attribute is absent — a complaint about a missing
   * attribute has nowhere better to point.
   */
  private static int[] at(List<TDCParser.AttrContext> attrs, String name, int line, int column) {
    for (TDCParser.AttrContext attr : attrs) {
      if (attr.attrName != null && name.equals(attr.attrName.getText()) && attr.attrValue != null) {
        String text = attr.attrValue.getText();
        boolean quoted = text.length() >= 2 && text.startsWith("\"") && text.endsWith("\"");
        return new int[] {
          attr.attrValue.getLine(),
          attr.attrValue.getCharPositionInLine() + (quoted ? 1 : 0)
        };
      }
    }
    return new int[] {line, column};
  }

  private static int[] at(TDCParser.SelfClosingElementContext el, String name) {
    return at(el.attr(), name, line(el), column(el));
  }

  private static int[] at(TDCParser.OpenCloseElementContext el, String name) {
    return at(el.attr(), name, line(el), column(el));
  }

  private static Map<String, String> attributes(List<TDCParser.AttrContext> attrs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrs) {
      String raw = attr.attrValue.getText();
      out.put(attr.attrName.getText(), raw.substring(1, raw.length() - 1));
    }
    return out;
  }

  private static int line(TDCParser.OpenCloseElementContext el) {
    return el.getStart().getLine();
  }

  private static int column(TDCParser.OpenCloseElementContext el) {
    return el.getStart().getCharPositionInLine();
  }

  private static int line(TDCParser.SelfClosingElementContext el) {
    return el.getStart().getLine();
  }

  private static int column(TDCParser.SelfClosingElementContext el) {
    return el.getStart().getCharPositionInLine();
  }

  private static TDCParser.OpenCloseElementContext findElement(ParseTree parent, String name) {
    if (parent == null) {
      return null;
    }
    for (int i = 0; i < parent.getChildCount(); i++) {
      ParseTree child = parent.getChild(i);
      TDCParser.OpenCloseElementContext open = null;
      if (child instanceof TDCParser.ElementContext element) {
        open = element.openCloseElement();
      } else if (child instanceof TDCParser.OpenCloseElementContext direct) {
        open = direct;
      }
      if (open != null && name.equals(open.name.getText())) {
        return open;
      }
    }
    return null;
  }

  /**
   * The most of an attribute value a message will quote. The full text is in the config the
   * position already points at; a message quoting 100 KB of it buries every other diagnostic in
   * the report. The same limit lives in the other four implementations; change them together.
   */
  private static final int MESSAGE_ECHO_LIMIT = 120;

  /** An attribute value, cut to fit inside a one-line message. */
  private static String clip(String value) {
    if (value.length() <= MESSAGE_ECHO_LIMIT) {
      return value;
    }
    int hidden = value.length() - MESSAGE_ECHO_LIMIT;
    return value.substring(0, MESSAGE_ECHO_LIMIT) + "\u2026 (" + hidden + " more chars)";
  }

  /** A {@code <gen>}'s attributes and where it starts, whichever way it was punctuated. */
  private record GenNode(List<TDCParser.AttrContext> attrs, int line, int column) {}

  /**
   * The {@code <gen>} in this child, self-closing or open/close alike.
   *
   * <p>Matching only the self-closing form left {@code <gen …></gen>} unseen, and the sequence
   * was then blamed for having no generator while one stood in plain sight.
   */
  private GenNode genNodeOf(TDCParser.ElementContext child) {
    TDCParser.SelfClosingElementContext self = child.selfClosingElement();
    if (self != null && "gen".equals(self.name.getText())) {
      return new GenNode(self.attr(), line(self), column(self));
    }
    TDCParser.OpenCloseElementContext open = child.openCloseElement();
    if (open != null && "gen".equals(open.name.getText())) {
      return new GenNode(open.attr(), line(open), column(open));
    }
    return null;
  }


  /** What may sit directly inside {@code <sequence>}. */
  private static final Set<String> SEQUENCE_CHILDREN =
      Set.of("gen", "data", "distinct", "compute");

  /**
   * {@code <distinct>}/{@code <uniq>} mean two different things by position, and so hold two
   * different sets: inside a {@code <sequence>} the FIELDS of one record, at {@code <env>} level
   * whole COLUMNS. One list for both refuses working configs.
   */
  private static final Set<String> DISTINCT_CHILDREN = Set.of("gen");

  /** Deliberately generous: too short a list refuses configs that work today. */
  private static final Set<String> POOL_CHILDREN =
      Set.of("sequence", "mix", "switch", "uniq", "distinct", "member", "data");

  /** A fixture holds literal text and {@code <line>}s. */
  /**
   * A fixture body is made of {@code <line>}s and nothing else.
   *
   * <p>{@code data} used to be on this list, and every renderer only ever walks {@code <line>} —
   * so {@code <before><data>x</data></before>} validated and emitted nothing at all. The list is
   * what the "Allowed inside" note prints, so it has to say what the renderer actually does.
   */
  private static final Set<String> FIXTURE_CHILDREN = Set.of("line");

  /** What may sit directly inside {@code <switch>}. */
  private static final Set<String> SWITCH_CHILDREN = Set.of("map", "case", "default");

  /** What may sit directly inside {@code <block>} and {@code <line>}. */
  private static final Set<String> BLOCK_CHILDREN = Set.of("line", "data");

  private static final Set<String> LINE_CHILDREN = Set.of("data", "gen", "mix", "switch");

  private static final Set<String> FIXTURE_TAG_NAMES = Set.of("before", "after", "before_block",
      "after_block", "delimiter_block", "before_line", "after_line", "delimiter_line");

}
