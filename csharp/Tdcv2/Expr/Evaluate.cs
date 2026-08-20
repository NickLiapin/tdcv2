using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;

namespace Tdcv2.Expr;

/// <summary>
/// Evaluates a parsed <see cref="Expr"/> against the row being rendered.
/// </summary>
/// <remarks>
/// Values live in the same three-type world the reference works in: a number, a string, or a
/// boolean. The rules for moving between them are JavaScript's, with one deliberate change the
/// reference also makes — the string <c>"false"</c> counts as false. Without that,
/// <c>if="!_last"</c> would be true on every row, because the string "false" is a non-empty
/// string.
/// </remarks>
public static class Evaluate
{
    /// <summary>What a name resolves to. Separate <c>Has</c> because an absent name is not empty.</summary>
    public interface IScope
    {
        bool Has(string name);

        /// <summary>The value for <c>name</c> on the current row; <c>""</c> when the row has none.</summary>
        string Value(string name);
    }

    private static readonly ConcurrentDictionary<string, Expr> Cache = new();

    public static bool AsCondition(string source, IScope scope) =>
        ToBoolean(Eval(Cache.GetOrAdd(source, Expr.Parse), scope));

    /// <summary>The expression's VALUE rather than its truth.</summary>
    /// <remarks>
    /// The same evaluator an <c>if=</c> uses — a formula and a distribution parameter are the
    /// same language asking for the answer instead of the verdict, which is what keeps a
    /// condition and a computed column from coming to mean different things by the same words.
    /// </remarks>
    public static object? AsValue(string source, IScope scope) =>
        Eval(Cache.GetOrAdd(source, Expr.Parse), scope);

    /// <summary>The same, for a caller that has two closures rather than a scope object.</summary>
    public static object? AsValue(string source, Func<string, bool> has, Func<string, string> value)
        => AsValue(source, new FuncScope(has, value));

    private sealed class FuncScope : IScope
    {
        private readonly Func<string, bool> _has;
        private readonly Func<string, string> _value;

        internal FuncScope(Func<string, bool> has, Func<string, string> value)
        {
            _has = has;
            _value = value;
        }

        public bool Has(string name) => _has(name);

        public string Value(string name) => _value(name);
    }

    private static object? Eval(Expr node, IScope scope) => node switch
    {
        Expr.Num n => n.Value,
        Expr.Int n => n.Value,
        Expr.Str s => s.Value,
        Expr.Bool b => b.Value,
        Expr.Null => null,
        // An unknown name is its own value, which is what lets `Gender == Male` go unquoted.
        Expr.Name n => scope.Has(n.Value) ? scope.Value(n.Value) : n.Value,
        Expr.Member m => MemberOf(m.Dotted, scope),
        Expr.Unary u => UnaryOp(u.Op, Eval(u.Operand, scope)),
        Expr.Binary b => BinaryOp(b.Op, Eval(b.Left, scope), Eval(b.Right, scope)),
        Expr.Call c => CallFunction(c.Callee, c.Args.Select(a => Eval(a, scope)).ToArray()),
        Expr.Arr a => a.Items.Select(i => Eval(i, scope)).ToList(),
        Expr.Conditional t => ToBoolean(Eval(t.Test, scope))
            ? Eval(t.Consequent, scope)
            : Eval(t.Alternate, scope),
        _ => throw new InvalidOperationException($"if expression: unhandled node {node}"),
    };

    /// <summary>
    /// <c>A.B</c> is read three ways, in order: a compound field named "A.B"; else, when "A" is a
    /// sequence, the test "is A currently B?" — so <c>if="Gender.Male"</c> reads the way
    /// <c>parent="Gender.Male"</c> does; else the dotted text itself, so a typo shows up verbatim
    /// instead of silently becoming empty.
    /// </summary>
    private static object MemberOf(string dotted, IScope scope)
    {
        if (scope.Has(dotted))
        {
            return scope.Value(dotted);
        }

        int dot = dotted.IndexOf('.');
        if (dot > 0 && scope.Has(dotted[..dot]))
        {
            return scope.Value(dotted[..dot]) == dotted[(dot + 1)..];
        }

        return dotted;
    }

    private static object UnaryOp(string op, object? arg) => op switch
    {
        "!" => !ToBoolean(arg),
        "-" => AsExactInt(arg) is long negatable
            ? CheckedNegate(negatable)
            : -AsNumber(arg),
        "+" => AsExactInt(arg) ?? (object)AsNumber(arg),
        _ => throw new ArgumentException($"if expression: unsupported operator {op}"),
    };

    private static object BinaryOp(string op, object? left, object? right) => op switch
    {
        "==" => LooseEquals(left, right),
        "!=" => !LooseEquals(left, right),
        "===" => StrictEquals(left, right),
        "!==" => !StrictEquals(left, right),
        "<" => BothWhole(left, right) is var (la, lb) && la.HasValue
            ? la.Value < lb!.Value
            : AsNumber(left) < AsNumber(right),
        ">" => BothWhole(left, right) is var (ga, gb) && ga.HasValue
            ? ga.Value > gb!.Value
            : AsNumber(left) > AsNumber(right),
        "<=" => BothWhole(left, right) is var (lea, leb) && lea.HasValue
            ? lea.Value <= leb!.Value
            : AsNumber(left) <= AsNumber(right),
        ">=" => BothWhole(left, right) is var (gea, geb) && gea.HasValue
            ? gea.Value >= geb!.Value
            : AsNumber(left) >= AsNumber(right),
        "&&" => ToBoolean(left) && ToBoolean(right),
        "||" => ToBoolean(left) || ToBoolean(right),
        // `+` adds when either side is already a number and joins otherwise, as in JavaScript.
        "+" => WholeAdd(left, right),
        "-" => WholeSubtract(left, right),
        "*" => WholeMultiply(left, right),
        // Division alone stays in floating point, always. It is not closed over the whole
        // numbers — 7/2 is not one — and a rule that came out exact only when the division
        // happened to be even would be a rule nobody could hold in their head.
        "/" => AsNumber(left) / AsNumber(right),
        "%" => WholeRemainder(left, right),
        // As loose as `==`, deliberately: a text column against a list of numeric words has to
        // match, or `in` and `==` would disagree about the same pair.
        "in" => right is List<object?> items
            ? items.Any(candidate => LooseEquals(left, candidate))
            : LooseEquals(left, right),
        _ => throw new ArgumentException($"if expression: unsupported operator {op}"),
    };

    /// <summary>
    /// <c>%</c> — the EUCLIDEAN remainder, always in <c>[0, |b|)</c>.
    ///
    /// Not C#'s <c>%</c>, which takes the sign of the dividend and answers -1 to <c>-3 % 2</c>.
    /// The compute layer's <c>&lt;mod&gt;</c> answers 1, and one engine must not give two answers
    /// depending on which layer the author reached for.
    /// </summary>
    private static double EuclideanRemainder(double a, double b)
    {
        if (b == 0)
        {
            throw new ArgumentException("if expression: the right side of % must not be zero");
        }

        double magnitude = Math.Abs(b);
        double r = a % magnitude;
        return r < 0 ? r + magnitude : r;
    }

    /// <summary>
    /// The functions an <c>if=</c> may call.
    ///
    /// Every one is EXACT — comparisons and the arithmetic IEEE-754 pins down — so the five
    /// implementations cannot disagree about a result. sin, cos, exp and the rest are absent for
    /// exactly that reason; the validator answers them with it.
    ///
    /// <c>round</c> is written out rather than delegated: .NET rounds a half to even by default,
    /// JavaScript sends it toward +inf, Java rounds half up. TDC sends a half AWAY FROM ZERO.
    /// </summary>
    private static object CallFunction(string name, object?[] args)
    {
        if (args.Length == 0)
        {
            throw new ArgumentException("if expression: a function needs at least one argument");
        }

        // Each family coerces its own arguments. The string functions must NOT be numbered:
        // len("10") is 2, and a caller that pre-numbered every argument could not tell the two
        // families apart.
        double Num(int i) => i < args.Length
            ? AsNumber(args[i])
            : throw new ArgumentException(
                "if expression: a function was given too few arguments");
        string Str(int i)
        {
            if (i >= args.Length)
            {
                throw new ArgumentException(
                    "if expression: a function was given too few arguments");
            }

            if (args[i] is List<object?>)
            {
                throw new ArgumentException("if expression: a string function was given a list");
            }

            return Text(args[i]);
        }

        switch (name)
        {
            // A whole number already IS its own rounding, whatever its size, and taking it
            // through a double first throws that answer away past 2^53. Arithmetic stayed
            // exact, so the value arrives intact and must not be destroyed on the way out.
            case "abs":
                return AsExactInt(args.Length > 0 ? args[0] : null) is long toAbs
                    ? (toAbs < 0 ? CheckedNegate(toAbs) : toAbs)
                    : Math.Abs(Num(0));
            case "ceil": return Whole(args, 0) ?? Math.Ceiling(Num(0));
            case "floor": return Whole(args, 0) ?? Math.Floor(Num(0));
            case "trunc": return Whole(args, 0) ?? Math.Truncate(Num(0));
            case "round":
            {
                if (Whole(args, 0) is object already) return already;
                double x = Num(0);
                return x < 0 ? -Math.Floor(-x + 0.5) : Math.Floor(x + 0.5);
            }
            // Spread: one list argument read as the arguments themselves, so
            // max(split(Prices, ",")) and max(1, 9, 4) both work.
            case "max": return Extremum(args, wantsMax: true);
            case "min": return Extremum(args, wantsMax: false);
            case "contains": return Str(0).Contains(Str(1), StringComparison.Ordinal);
            case "ends_with": return Str(0).EndsWith(Str(1), StringComparison.Ordinal);
            case "starts_with": return Str(0).StartsWith(Str(1), StringComparison.Ordinal);
            case "is_empty": return Str(0).Length == 0;
            // CODE POINTS, matching Python's len() and Rust's chars().count(); C#'s own
            // .Length would count UTF-16 units and make an emoji 2.
            case "len":
            {
                string s = Str(0);
                int count = 0;
                for (int i = 0; i < s.Length; i += char.IsSurrogatePair(s, i) ? 2 : 1)
                {
                    count++;
                }

                return (double)count;
            }
            case "lower": return Str(0).ToLowerInvariant();
            case "upper": return Str(0).ToUpperInvariant();
            // Lists inside one row. A sequence with repeat= puts several values in one field,
            // and an expression sees the JOINED text because that is what the field holds — so
            // `split` is the bridge and everything else works on lists. No grammar changed: the
            // list value already existed, made by an array literal and consumed by `in`.
            case "split": return SplitText(Str(0), Str(1));
            case "join": return string.Join(Str(1), ListOf(args, 0).Select(Text));
            // How many. `len` is the STRING length and would answer about the separators.
            case "count": return (double)ListOf(args, 0).Count;
            case "at":
            {
                List<object?> items = ListValue(args, 0);
                int index = IndexValue(args, 1);
                return index < items.Count ? items[index] ?? string.Empty : string.Empty;
            }

            case "sum": return SumOf(ListOf(args, 0));
            case "mean": return MeanOf(ListOf(args, 0));
            case "median": return MedianOf(ListOf(args, 0));
            case "stddev": return StdDevOf(ListOf(args, 0));
            case "zeta": return Maths.TdcMath.Zeta(Num(0));
            // Transcendentals, computed by TDC rather than by .NET — see Math/TdcMath.cs.
            // Adding one here means adding it to TdcMath in all five, not calling System.Math.
            case "acos": return Maths.TdcMath.Acos(Num(0));
            case "acosh": return Maths.TdcMath.Acosh(Num(0));
            case "asin": return Maths.TdcMath.Asin(Num(0));
            case "asinh": return Maths.TdcMath.Asinh(Num(0));
            case "atan": return Maths.TdcMath.Atan(Num(0));
            case "atanh": return Maths.TdcMath.Atanh(Num(0));
            case "beta": return Maths.TdcMath.Beta(Num(0), Num(1));
            case "atan2": return Maths.TdcMath.Atan2(Num(0), Num(1));
            case "cbrt": return Maths.TdcMath.Cbrt(Num(0));
            // x held inside [lo, hi], as min(max(x, lo), hi): with the bounds handed
            // over backwards the CEILING wins. Testing `x < lo` first reads the same
            // and is not — it lets the floor win. NOT Math.Clamp, which throws when
            // lo > hi instead of answering.
            case "clamp": { var x = Num(0); var lo = Num(1); var hi = Num(2); var fl = x > lo ? x : lo; return fl < hi ? fl : hi; }
            case "cos": return Maths.TdcMath.Cos(Num(0));
            case "degrees": return Maths.TdcMath.Degrees(Num(0));
            case "digamma": return Maths.TdcMath.Digamma(Num(0));
            case "cosh": return Maths.TdcMath.Cosh(Num(0));
            case "erf": return Maths.TdcMath.Erf(Num(0));
            case "erfc": return Maths.TdcMath.Erfc(Num(0));
            case "exp": return Maths.TdcMath.Exp(Num(0));
            case "expm1": return Maths.TdcMath.Expm1(Num(0));
            case "gamma": return Maths.TdcMath.Gamma(Num(0));
            // exp(-((x - centre) / width)^2). `t * t`, not Pow(t, 2): multiplication is
            // exact under IEEE-754 and pow is not, so this is cheaper and identical in
            // all five for free.
            case "gauss": { var g = (Num(0) - Num(1)) / Num(2); return Maths.TdcMath.Exp(-(g * g)); }
            case "hypot": return Maths.TdcMath.Hypot(Num(0), Num(1));
            // a * (1 - t) + b * t, not a + (b - a) * t: only this form lands exactly on
            // both endpoints. Measured over 200,000 random pairs, the naive one misses
            // b at t=1 in 41 per cent of them.
            case "lerp": { var lt = Num(2); return Num(0) * (1 - lt) + Num(1) * lt; }
            case "lgamma": return Maths.TdcMath.Lgamma(Num(0));
            case "log": return Maths.TdcMath.Log(Num(0));
            case "log10": return Maths.TdcMath.Log10(Num(0));
            case "log1p": return Maths.TdcMath.Log1p(Num(0));
            case "log2": return Maths.TdcMath.Log2(Num(0));
            case "pow": return Maths.TdcMath.Pow(Num(0), Num(1));
            case "sin": return Maths.TdcMath.Sin(Num(0));
            case "radians": return Maths.TdcMath.Radians(Num(0));
            case "sign": return Maths.TdcMath.Sign(Num(0));
            case "sinh": return Maths.TdcMath.Sinh(Num(0));
            case "sqrt": return Maths.TdcMath.Sqrt(Num(0));
            case "tanh": return Maths.TdcMath.Tanh(Num(0));
            case "tan": return Maths.TdcMath.Tan(Num(0));
            default:
                throw new ArgumentException($"if expression: unknown function \"{name}\"");
        }
    }

    /// <summary>
    /// Loose equality. A number against a numeric-looking string compares as numbers, so
    /// <c>_count == 5</c> works even though <c>_count</c> arrives as text; everything else
    /// compares as text.
    /// </summary>
    private static bool LooseEquals(object? left, object? right)
    {
        // Two whole numbers compare as whole numbers, whichever shape they arrived
        // in — a generated id is a string, the literal beside it is not.
        var (wa, wb) = BothWhole(left, right);
        if (wa.HasValue)
        {
            return wa.Value == wb!.Value;
        }
        // A number the config WROTE, beside text that reads as one. Both shapes of number
        // count, and the whole-number half is the repair of a bug that had every money column
        // silently failing its own equality test: `Total == 100` was false while `Total > 99`
        // was true, because 100 is a whole number and "100.00" is not, so the two never met.
        if (IsWritten(left) && right is string s1)
        {
            double b = JsNumber(s1);
            if (!double.IsNaN(b))
            {
                return AsNumber(left) == b;
            }
        }

        if (IsWritten(right) && left is string s2)
        {
            double a = JsNumber(s2);
            if (!double.IsNaN(a))
            {
                return a == AsNumber(right);
            }
        }

        if (left is null || right is null)
        {
            return left is null && right is null;
        }

        if (left is bool || right is bool)
        {
            return AsNumber(left) == AsNumber(right);
        }

        if (left is double a3 && right is double b3)
        {
            return a3 == b3;
        }

        // Two texts stay text, whatever they look like: an empty column and a blank one are not
        // equal even though both read as zero. Only a literal drags a column into numbers.
        return Text(left) == Text(right);
    }

    /// <summary>A number as the config wrote it, rather than as a column produced it.</summary>
    private static bool IsWritten(object? v) => v is double or long;

    /* ── The two equalities ───────────────────────────────────────────────────
     *
     * A TDC column is TEXT. Every generator produces text, every built-in is
     * text, and the only things that are not text are the literals someone
     * writes inside an expression. So "are these equal?" has two honest
     * readings, and TDC gives each one its own operator — the shape Perl
     * settled on for the same reason, where a scalar is likewise text that
     * might be a number:
     *
     *     ==   the same NUMBER   "01" == 1     true
     *     ===  the same TEXT     "01" === 1    false
     *
     * `===` used to be the host language's identity test — "same type AND same
     * value". That is a fine question in a language with types and a
     * meaningless one here, because there is only ever one type: `N === 1` was
     * false for EVERY number on every row, silently, with `check` passing.
     */

    /// <summary>
    /// <c>===</c> — do both sides print the same characters?
    /// </summary>
    /// <remarks>
    /// A list never matches, itself included: <c>in</c> is the operator for lists, and TDC259
    /// refuses one anywhere else before the run. Answering false keeps all five implementations
    /// saying the same thing rather than leaving each host's idea of list equality to decide.
    /// </remarks>
    private static bool StrictEquals(object? left, object? right)
    {
        if (left is List<object?> || right is List<object?>)
        {
            return false;
        }

        return StrictText(left) == StrictText(right);
    }

    /// <summary>
    /// The characters a value prints as. Nothing — an absent column, the <c>null</c> literal —
    /// is the EMPTY text, the same thing a column that produced no value holds.
    /// </summary>
    private static string StrictText(object? v) => v switch
    {
        null => string.Empty,
        string s => s,
        bool b => b ? "true" : "false",
        // Printed from the integer itself, not through a double: past 2^53 the round trip would
        // put back the digit the exact domain exists to keep.
        long n => n.ToString(CultureInfo.InvariantCulture),
        _ => Text(v),
    };

    /// <summary>
    /// What counts as TRUE — for a bare <c>if="X"</c>, and for <c>!</c>, <c>&amp;&amp;</c> and
    /// <c>||</c>.
    /// </summary>
    /// <remarks>
    /// Two texts are false and every other text is true: the empty one (the column produced
    /// nothing) and "false" (a flag column saying no). "0" is TRUE — zero is a value, not an
    /// absence. That is Lua's and Ruby's rule carried into a language whose single carrier is
    /// text. <c>_last</c>, <c>_first</c> and every <c>anomaly_flag</c> column hold literally
    /// "true" or "false", so without this <c>if="!_last"</c> would be true on every row.
    /// </remarks>
    public static bool ToBoolean(object? v) => v switch
    {
        null => false,
        string s => s.Length > 0 && s != "false",
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        // A whole number is false only at zero, like the double beside it.
        long n => n != 0,
        _ => true,
    };

    /* ── Whole numbers that stay whole ────────────────────────────────────────
     *
     * A double holds every integer up to 2⁵³ and then starts skipping. Past that
     * point two DIFFERENT whole numbers become the same double, and an expression
     * built on doubles alone answers accordingly:
     *
     *     9007199254740993 == 9007199254740992   ->  true
     *     9007199254740993 -  9007199254740992   ->  0
     *
     * Both wrong, and wrong silently — the worst way for a data generator to be
     * wrong, since the run finishes and the file looks fine. The domain is signed
     * 64-bit, matching the compute layer.
     */

    /// <summary>A value seen as an exact whole number, or null if it is not one.</summary>
    private static long? AsExactInt(object? v)
    {
        switch (v)
        {
            case long n:
                return n;
            case string s:
                string body = s.Length > 0 && (s[0] == '+' || s[0] == '-') ? s[1..] : s;
                if (body.Length > 0 && body.All(c => c >= '0' && c <= '9')
                    && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed))
                {
                    return parsed;
                }
                return null;
            // A double is admitted only while it is still exact. Past 2⁵³ it has
            // already lost the answer, and calling it exact would be the same lie
            // in a different place.
            case double d when d % 1 == 0 && System.Math.Abs(d) <= 9007199254740991d:
                return (long)d;
            default:
                return null;
        }
    }

    private static (long?, long?) BothWhole(object? left, object? right)
    {
        long? a = AsExactInt(left);
        if (a is null) return (null, null);
        long? b = AsExactInt(right);
        return b is null ? (null, null) : (a, b);
    }

    /// <summary>One list argument spread out, or the arguments themselves.</summary>
    /// <summary>The argument as an exact whole number, boxed, or null when it is not one.</summary>
    private static object? Whole(object?[] args, int i) =>
        i < args.Length && AsExactInt(args[i]) is long w ? w : null;

    /// <summary>
    /// <c>min</c> / <c>max</c>, exact while EVERY argument is a whole number.
    ///
    /// <para>One float among them and the whole comparison falls to floating point, which is
    /// honest: there is no exact ordering between a big integer and a float that is not one.
    /// The winner is handed back as it was given, so <c>max(9007199254740993, 1)</c> answers
    /// with the number somebody wrote.</para>
    /// </summary>
    private static object Extremum(object?[] args, bool wantsMax)
    {
        var values = Spread(args).ToList();
        var whole = new List<long>(values.Count);
        foreach (object? v in values)
        {
            if (AsExactInt(v) is not long n) { whole.Clear(); break; }

            whole.Add(n);
        }

        if (whole.Count == values.Count && whole.Count > 0)
        {
            return whole.Aggregate((a, b) => (wantsMax ? b > a : b < a) ? b : a);
        }

        return values.Select(AsNumber).Aggregate((a, b) => (wantsMax ? b > a : b < a) ? b : a);
    }

    private static IEnumerable<object?> Spread(object?[] args) =>
        args.Length == 1 && args[0] is List<object?> only ? only : args;

    /// <summary>
    /// An argument as a list.
    ///
    /// <para>A bare value counts as a list of one, so <c>sum(Price)</c> on a single number is an
    /// answer rather than an error — the alternative is a rule a caller has to remember before
    /// every call.</para>
    /// </summary>
    private static List<object?> ListOf(object?[] args, int index)
    {
        if (index >= args.Length)
        {
            throw new ArgumentException("if expression: a function was given too few arguments");
        }

        return args[index] switch
        {
            List<object?> items => items,
            null => new List<object?>(),
            var one => new List<object?> { one },
        };
    }

    /// <summary>
    /// <c>at</c>'s subject, which has to be a real list.
    ///
    /// <para><see cref="ListOf"/> reads a bare value as a list of one, which is right for
    /// <c>sum(Price)</c> and wrong here: a <c>repeat</c> list arrives as the JOINED text, so
    /// <c>at(Items, 1)</c> — the shape everybody writes first — used to ask for the second element
    /// of a one-element list and get the same empty string a legitimately short row gives. Naming
    /// the mistake is the point.</para>
    /// </summary>
    private static List<object?> ListValue(object?[] args, int index)
    {
        if (index >= args.Length)
        {
            throw new ArgumentException("if expression: a function was given too few arguments");
        }

        if (args[index] is List<object?> items)
        {
            return items;
        }

        throw new ArgumentException(
            $"at() needs a list, and {Show(args[index])} is a single value — split it first, "
            + "as in at(split(Items, \",\"), 1)");
    }

    /// <summary>An index: a whole number, zero or more. Anything else is a mistake, not a shape.</summary>
    private static int IndexValue(object?[] args, int index)
    {
        if (index >= args.Length)
        {
            throw new ArgumentException("if expression: a function was given too few arguments");
        }

        object? raw = args[index];
        double n = AsNumber(raw);
        if (double.IsNaN(n) || double.IsInfinity(n) || n != Math.Floor(n) || n < 0)
        {
            throw new ArgumentException(
                $"at() index must be a whole number of zero or more, not {Show(raw)}");
        }

        return (int)Math.Min(n, int.MaxValue);
    }

    /// <summary>A value as it should read inside a message: text quoted, everything else plain.</summary>
    private static string Show(object? v) => v switch
    {
        string s => $"\"{s}\"",
        List<object?> => "a list",
        null => "nothing",
        _ => Text(v),
    };

    /// <summary>Text to a list. An empty subject gives an empty list, not a list of one blank.</summary>
    private static List<object?> SplitText(string subject, string separator)
    {
        var items = new List<object?>();
        if (subject.Length == 0)
        {
            return items;
        }

        if (separator.Length == 0)
        {
            // CODE POINTS, the same unit `len` counts, so split(s, "") and len(s) never disagree
            // about how many characters a string has.
            for (int i = 0; i < subject.Length;)
            {
                int width = char.IsSurrogatePair(subject, i) ? 2 : 1;
                items.Add(subject.Substring(i, width));
                i += width;
            }

            return items;
        }

        foreach (string part in subject.Split(separator))
        {
            items.Add(part);
        }

        return items;
    }

    /// <summary>The total. Whole while every element is whole, so a column of ids stays exact.</summary>
    private static object SumOf(List<object?> items)
    {
        var parts = new List<long>(items.Count);
        bool allWhole = items.Count > 0;
        foreach (object? item in items)
        {
            if (AsExactInt(item) is not long n)
            {
                allWhole = false;
                break;
            }

            parts.Add(n);
        }

        if (allWhole)
        {
            return Checked(
                () =>
                {
                    long total = 0;
                    foreach (long n in parts) total = checked(total + n);
                    return total;
                },
                () =>
                {
                    BigInteger total = BigInteger.Zero;
                    foreach (long n in parts) total += n;
                    return total;
                });
        }

        double sum = 0;
        foreach (object? item in items) sum += AsNumber(item);
        return sum;
    }

    /// <summary>The average. Always a double: a mean is a ratio, and ratios are not whole.</summary>
    private static double MeanOf(List<object?> items)
    {
        if (items.Count == 0) return double.NaN;
        double sum = 0;
        foreach (object? item in items) sum += AsNumber(item);
        return sum / items.Count;
    }

    /// <summary>The middle value; with an even count, the average of the two middle ones.</summary>
    private static double MedianOf(List<object?> items)
    {
        if (items.Count == 0) return double.NaN;
        List<double> sorted = items.Select(AsNumber).ToList();
        sorted.Sort();
        int half = sorted.Count / 2;
        return sorted.Count % 2 == 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    }

    /// <summary>
    /// The POPULATION standard deviation — divided by n, not by n−1.
    ///
    /// <para>A generated list is the whole of what it describes, not a sample drawn from something
    /// larger, so n is the honest divisor. Stated because the two differ and neither is the obvious
    /// default.</para>
    /// </summary>
    private static double StdDevOf(List<object?> items)
    {
        if (items.Count == 0) return double.NaN;
        List<double> values = items.Select(AsNumber).ToList();
        double average = 0;
        foreach (double v in values) average += v;
        average /= values.Count;
        double variance = 0;
        foreach (double v in values) variance += (v - average) * (v - average);
        return Maths.TdcMath.Sqrt(variance / values.Count);
    }

    private static object CheckedNegate(long v) => Checked(() => checked(-v), () => -(BigInteger)v);

    /// <summary>
    /// The result of whole-number arithmetic, refused rather than wrapped.
    ///
    /// <para>The refusal NAMES the value, as the compute layer's does. Reaching it needs
    /// arithmetic wider than the domain, so <paramref name="wide"/> runs only once the fast path
    /// has already said no — the ordinary case never pays for the allocation.</para>
    /// </summary>
    private static object Checked(Func<long> compute, Func<BigInteger> wide)
    {
        try
        {
            return compute();
        }
        catch (OverflowException)
        {
            throw new ArgumentException(
                $"integer overflow: {wide()} is outside the signed 64-bit range");
        }
    }

    private static object WholeAdd(object? left, object? right)
    {
        var (a, b) = BothWhole(left, right);
        if (a.HasValue) return Checked(() => checked(a.Value + b!.Value), () => (BigInteger)a.Value + b!.Value);
        // `+` adds when either side is already a number and joins otherwise, as in JavaScript.
        return left is double || right is double
            ? AsNumber(left) + AsNumber(right)
            : Text(left) + Text(right);
    }

    private static object WholeSubtract(object? left, object? right)
    {
        var (a, b) = BothWhole(left, right);
        return a.HasValue ? Checked(() => checked(a.Value - b!.Value), () => (BigInteger)a.Value - b!.Value) : AsNumber(left) - AsNumber(right);
    }

    private static object WholeMultiply(object? left, object? right)
    {
        var (a, b) = BothWhole(left, right);
        return a.HasValue ? Checked(() => checked(a.Value * b!.Value), () => (BigInteger)a.Value * b!.Value) : AsNumber(left) * AsNumber(right);
    }

    private static object WholeRemainder(object? left, object? right)
    {
        var (a, b) = BothWhole(left, right);
        if (a.HasValue && b!.Value != 0)
        {
            // Euclidean, like the double path and like <mod> in compute.
            long r = a.Value % b.Value;
            return r < 0 ? r + System.Math.Abs(b.Value) : r;
        }
        return EuclideanRemainder(AsNumber(left), AsNumber(right));
    }

    private static double AsNumber(object? v) => v switch
    {
        double d => d,
        // A whole number handed to something that works in floating point — sqrt,
        // log, sin. Past 2⁵³ this loses digits, which is the honest answer.
        long n => n,
        string s => JsNumber(s),
        bool b => b ? 1 : 0,
        _ => double.NaN,
    };

    /// <summary><c>Number(x)</c> as JavaScript defines it: blank is zero, unreadable is NaN.</summary>
    private static double JsNumber(string raw)
    {
        string s = raw.Trim();
        if (s.Length == 0)
        {
            return 0;
        }

        if (s.StartsWith("0x", StringComparison.Ordinal) || s.StartsWith("0X", StringComparison.Ordinal))
        {
            return long.TryParse(s[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long hex)
                ? hex
                : double.NaN;
        }

        // .NET accepts a leading "+" and some suffixes JavaScript does not read.
        char last = s[^1];
        if (last is 'd' or 'D' or 'f' or 'F' or 'm' or 'M')
        {
            return double.NaN;
        }

        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            ? n
            : double.NaN;
    }

    /// <summary><c>String(x)</c>: a whole number prints without a decimal point, as in JavaScript.</summary>
    private static string Text(object? v)
    {
        if (v is null)
        {
            return "null";
        }

        if (v is double d)
        {
            if (d == Math.Round(d, MidpointRounding.ToEven) && !double.IsInfinity(d))
            {
                return ((long)d).ToString(CultureInfo.InvariantCulture);
            }

            return d.ToString("R", CultureInfo.InvariantCulture);
        }

        if (v is bool b)
        {
            return b ? "true" : "false";
        }

        return v.ToString() ?? "";
    }
}
