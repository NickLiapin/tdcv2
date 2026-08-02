using System.Collections.Concurrent;
using System.Globalization;

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

    private static object? Eval(Expr node, IScope scope) => node switch
    {
        Expr.Num n => n.Value,
        Expr.Str s => s.Value,
        Expr.Bool b => b.Value,
        Expr.Null => null,
        // An unknown name is its own value, which is what lets `Gender == Male` go unquoted.
        Expr.Name n => scope.Has(n.Value) ? scope.Value(n.Value) : n.Value,
        Expr.Member m => MemberOf(m.Dotted, scope),
        Expr.Unary u => UnaryOp(u.Op, Eval(u.Operand, scope)),
        Expr.Binary b => BinaryOp(b.Op, Eval(b.Left, scope), Eval(b.Right, scope)),
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
        "-" => -AsNumber(arg),
        "+" => AsNumber(arg),
        _ => throw new ArgumentException($"if expression: unsupported operator {op}"),
    };

    private static object BinaryOp(string op, object? left, object? right) => op switch
    {
        "==" => LooseEquals(left, right),
        "!=" => !LooseEquals(left, right),
        "===" => StrictEquals(left, right),
        "!==" => !StrictEquals(left, right),
        "<" => AsNumber(left) < AsNumber(right),
        ">" => AsNumber(left) > AsNumber(right),
        "<=" => AsNumber(left) <= AsNumber(right),
        ">=" => AsNumber(left) >= AsNumber(right),
        "&&" => ToBoolean(left) && ToBoolean(right),
        "||" => ToBoolean(left) || ToBoolean(right),
        // `+` adds when either side is already a number and joins otherwise, as in JavaScript.
        "+" => left is double || right is double
            ? AsNumber(left) + AsNumber(right)
            : Text(left) + Text(right),
        "-" => AsNumber(left) - AsNumber(right),
        "*" => AsNumber(left) * AsNumber(right),
        "/" => AsNumber(left) / AsNumber(right),
        "%" => AsNumber(left) % AsNumber(right),
        _ => throw new ArgumentException($"if expression: unsupported operator {op}"),
    };

    /// <summary>
    /// Loose equality. A number against a numeric-looking string compares as numbers, so
    /// <c>_count == 5</c> works even though <c>_count</c> arrives as text; everything else
    /// compares as text.
    /// </summary>
    private static bool LooseEquals(object? left, object? right)
    {
        if (left is double a1 && right is string s1)
        {
            double b = JsNumber(s1);
            if (!double.IsNaN(b))
            {
                return a1 == b;
            }
        }

        if (right is double b2 && left is string s2)
        {
            double a = JsNumber(s2);
            if (!double.IsNaN(a))
            {
                return a == b2;
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

        return Text(left) == Text(right);
    }

    private static bool StrictEquals(object? left, object? right)
    {
        if (left is null || right is null)
        {
            return left is null && right is null;
        }

        return left.GetType() == right.GetType() && left.Equals(right);
    }

    public static bool ToBoolean(object? v) => v switch
    {
        null => false,
        string s => s.Length > 0 && s != "false",
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        _ => true,
    };

    private static double AsNumber(object? v) => v switch
    {
        double d => d,
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
