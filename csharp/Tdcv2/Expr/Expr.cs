using System.Globalization;
using System.Text;

namespace Tdcv2.Expr;

/// <summary>
/// The tiny expression language behind <c>if="..."</c>.
/// </summary>
/// <remarks>
/// <para>
/// Comparison (<c>== != &lt; &gt; &lt;= &gt;=</c>), logic (<c>&amp;&amp; || !</c>) and arithmetic
/// (<c>+ - * /</c>) over sequence values, numbers and quoted strings.
/// </para>
/// <para>
/// The reference parses these with jsep, a JavaScript expression parser, so the precedence table
/// below is jsep's rather than one chosen here. Reproducing it matters: an expression like
/// <c>a == b &amp;&amp; c</c> has to bind the same way in every implementation or the engines
/// disagree about which rows appear — the kind of difference no test of a single value would
/// catch.
/// </para>
/// <para>
/// A bare word that names no sequence is its own value: <c>Gender == Male</c> works without
/// quoting "Male", which is how configs have always been written.
/// </para>
/// </remarks>
public abstract record Expr
{
    public sealed record Num(double Value) : Expr;

    public sealed record Str(string Value) : Expr;

    public sealed record Bool(bool Value) : Expr;

    public sealed record Null : Expr;

    public sealed record Name(string Value) : Expr;

    /// <summary>A dotted reference: a compound field, a value test, or a literal — resolved later.</summary>
    public sealed record Member(string Dotted) : Expr;

    public sealed record Binary(string Op, Expr Left, Expr Right) : Expr;

    public sealed record Unary(string Op, Expr Operand) : Expr;

    /// <summary>
    /// <c>x[0]</c> — subscripting, which the evaluator does not implement.
    /// </summary>
    /// <remarks>
    /// Parsed rather than rejected so the complaint can name what is unsupported. A parser
    /// stricter than the reference's turns "computed member access is not supported" into "syntax
    /// error", and the second says nothing about what to write instead.
    /// </remarks>
    public sealed record Computed(Expr Object) : Expr;

    /// <summary>jsep's binary precedence, verbatim. Higher binds tighter.</summary>
    public static IReadOnlyDictionary<string, int> Precedence { get; } = new Dictionary<string, int>
    {
        ["||"] = 1,
        ["&&"] = 2,
        ["=="] = 6,
        ["!="] = 6,
        ["==="] = 6,
        ["!=="] = 6,
        ["<"] = 7,
        [">"] = 7,
        ["<="] = 7,
        [">="] = 7,
        ["+"] = 9,
        ["-"] = 9,
        ["*"] = 10,
        ["/"] = 10,
        ["%"] = 10,
    };

    /// <summary>
    /// A hard ceiling on parenthesis nesting. The parser recurses per '(', so a generated
    /// "((((...))))" is a stack overflow — which kills a .NET process outright — for the price
    /// of a text file. Real expressions nest a handful. The scan is linear and quote-aware; the
    /// same ceiling lives in every implementation.
    /// </summary>
    private const int MaxExprNesting = 32;

    private static int ParenDepth(string source)
    {
        int depth = 0;
        int deepest = 0;
        char inString = '\0';
        bool escaped = false;
        foreach (char ch in source)
        {
            if (escaped)
            {
                escaped = false;
                continue;
            }
            if (inString != '\0')
            {
                if (ch == '\\')
                {
                    escaped = true;
                }
                else if (ch == inString)
                {
                    inString = '\0';
                }
                continue;
            }
            if (ch is '\'' or '"')
            {
                inString = ch;
            }
            else if (ch is '(' or '[')
            {
                depth++;
                deepest = Math.Max(deepest, depth);
            }
            else if (ch is ')' or ']')
            {
                depth = Math.Max(0, depth - 1);
            }
        }

        return deepest;
    }

    public static Expr Parse(string source)
    {
        if (ParenDepth(source) > MaxExprNesting)
        {
            throw new ArgumentException(
                $"nests deeper than {MaxExprNesting} levels");
        }

        var parser = new Parser(source);
        Expr result = parser.Expression(0);
        parser.SkipSpace();
        if (!parser.Done)
        {
            throw new ArgumentException(
                $"if expression: unexpected \"{parser.Rest}\" in \"{source}\"");
        }

        return result;
    }

    /// <summary>Precedence climbing over a hand-written tokenizer.</summary>
    private sealed class Parser
    {
        private static readonly string[] Operators =
        {
            // Longest first, so `<=` is never read as `<` followed by a stray `=`.
            "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%",
        };

        private readonly string _src;
        private int _pos;

        internal Parser(string src) => _src = src;

        internal bool Done => _pos >= _src.Length;

        internal string Rest => _src[_pos..];

        internal void SkipSpace()
        {
            while (_pos < _src.Length && char.IsWhiteSpace(_src[_pos]))
            {
                _pos++;
            }
        }

        internal Expr Expression(int minPrecedence)
        {
            Expr left = UnaryExpr();
            while (true)
            {
                SkipSpace();
                string? op = PeekOperator();
                if (op is null)
                {
                    return left;
                }

                int precedence = Precedence[op];
                if (precedence < minPrecedence)
                {
                    return left;
                }

                _pos += op.Length;
                // Left-associative: the right operand stops at anything this loop can handle.
                Expr right = Expression(precedence + 1);
                left = new Binary(op, left, right);
            }
        }

        private Expr UnaryExpr()
        {
            SkipSpace();
            if (_pos < _src.Length)
            {
                char c = _src[_pos];
                if (c == '!' && !_src.AsSpan(_pos).StartsWith("!=".AsSpan(), StringComparison.Ordinal))
                {
                    _pos++;
                    return new Unary("!", UnaryExpr());
                }

                if ((c == '-' || c == '+') && !IsNumberStart())
                {
                    _pos++;
                    return new Unary(c.ToString(), UnaryExpr());
                }

                // `~` parses and then fails validation, rather than failing to parse. The
                // reference's expression library accepts it too, and both have to refuse the same
                // configs for the same stated reason — "unsupported operator" says more than
                // "syntax error" does.
                if (c == '~')
                {
                    _pos++;
                    return new Unary("~", UnaryExpr());
                }
            }

            return Primary();
        }

        /// <summary>A leading <c>-</c> belongs to the number when a digit follows it directly.</summary>
        private bool IsNumberStart() => _pos + 1 < _src.Length && char.IsDigit(_src[_pos + 1]);

        private Expr Primary()
        {
            SkipSpace();
            if (Done)
            {
                throw new ArgumentException("if expression: ends where a value was expected");
            }

            char c = _src[_pos];

            if (c == '(')
            {
                _pos++;
                Expr inner = Expression(0);
                SkipSpace();
                if (Done || _src[_pos] != ')')
                {
                    throw new ArgumentException(
                        $"if expression: unbalanced parentheses in \"{_src}\"");
                }

                _pos++;
                return inner;
            }

            if (c == '\'' || c == '"')
            {
                return StringLiteral(c);
            }

            if (char.IsDigit(c) || (c == '-' && IsNumberStart()))
            {
                return NumberLiteral();
            }

            if (char.IsLetter(c) || c == '_' || c == '$')
            {
                Expr value = Word();
                // A subscript parses and then fails validation, so the complaint can say which
                // construct is unsupported rather than only where the parser stopped.
                SkipSpace();
                while (!Done && _src[_pos] == '[')
                {
                    _pos++;
                    Expression(0);
                    SkipSpace();
                    if (Done || _src[_pos] != ']')
                    {
                        throw new ArgumentException(
                            $"if expression: unbalanced brackets in \"{_src}\"");
                    }

                    _pos++;
                    SkipSpace();
                    value = new Computed(value);
                }

                return value;
            }

            throw new ArgumentException(
                $"if expression: cannot read \"{_src[_pos..]}\" in \"{_src}\"");
        }

        private Expr StringLiteral(char quote)
        {
            _pos++;
            var result = new StringBuilder();
            while (_pos < _src.Length && _src[_pos] != quote)
            {
                char c = _src[_pos];
                if (c == '\\' && _pos + 1 < _src.Length)
                {
                    _pos++;
                    c = _src[_pos];
                }

                result.Append(c);
                _pos++;
            }

            if (Done)
            {
                throw new ArgumentException($"if expression: unterminated string in \"{_src}\"");
            }

            _pos++;
            return new Str(result.ToString());
        }

        private Expr NumberLiteral()
        {
            int start = _pos;
            if (_src[_pos] == '-')
            {
                _pos++;
            }

            while (_pos < _src.Length && (char.IsDigit(_src[_pos]) || _src[_pos] == '.'))
            {
                _pos++;
            }

            return new Num(double.Parse(_src[start.._pos], CultureInfo.InvariantCulture));
        }

        private Expr Word()
        {
            var parts = new List<string> { Identifier() };
            while (_pos < _src.Length && _src[_pos] == '.')
            {
                _pos++;
                parts.Add(Identifier());
            }

            if (parts.Count == 1)
            {
                return parts[0] switch
                {
                    "true" => new Bool(true),
                    "false" => new Bool(false),
                    "null" => new Null(),
                    _ => new Name(parts[0]),
                };
            }

            return new Member(string.Join(".", parts));
        }

        private string Identifier()
        {
            int start = _pos;
            while (_pos < _src.Length)
            {
                char c = _src[_pos];
                if (char.IsLetterOrDigit(c) || c == '_' || c == '$')
                {
                    _pos++;
                }
                else
                {
                    break;
                }
            }

            if (start == _pos)
            {
                throw new ArgumentException($"if expression: expected a name in \"{_src}\"");
            }

            return _src[start.._pos];
        }

        private string? PeekOperator()
        {
            foreach (string op in Operators)
            {
                if (_src.AsSpan(_pos).StartsWith(op.AsSpan(), StringComparison.Ordinal))
                {
                    return op;
                }
            }

            return null;
        }
    }
}
