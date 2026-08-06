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

    /// <summary><c>abs(x)</c> — a call on a bare name, with its arguments already parsed.</summary>
    public sealed record Call(string Callee, IReadOnlyList<Expr> Args) : Expr;

    /// <summary><c>[US, CA, MX]</c> — only ever the right side of <c>in</c>.</summary>
    public sealed record Arr(IReadOnlyList<Expr> Items) : Expr;

    /// <summary><c>a ? b : c</c> — picks a VALUE, which is then compared like any other.</summary>
    public sealed record Conditional(Expr Test, Expr Consequent, Expr Alternate) : Expr;

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
        ["|"] = 3,
        ["^"] = 4,
        ["&"] = 5,
        ["=="] = 6,
        ["!="] = 6,
        ["==="] = 6,
        ["!=="] = 6,
        ["<"] = 7,
        [">"] = 7,
        ["<="] = 7,
        [">="] = 7,
        ["<<"] = 8,
        [">>"] = 8,
        [">>>"] = 8,
        ["+"] = 9,
        ["-"] = 9,
        ["*"] = 10,
        ["/"] = 10,
        ["%"] = 10,
        // A word operator rather than a symbol; PeekOperator keeps it from
        // swallowing a sequence called "index".
        ["in"] = 7,
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
        Expr result = parser.Ternary(0);
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
            // Longest first, so `<=` is never read as `<` followed by a stray `=`, and `&&`
            // never as two `&`. The bitwise and shift operators are here even though the engine
            // implements none of them: the reference parses whatever jsep parses and then refuses
            // the operator BY NAME, and a tokenizer that stopped at the supported set answered
            // `x & 1` with a syntax error pointing at the ampersand.
            ">>>", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "<", ">",
            "+", "-", "*", "/", "%", "&", "|", "^",
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

        /// <summary><c>a ? b : c</c>, which binds looser than every binary operator.</summary>
        /// <remarks>
        /// Wrapping the binary loop rather than living inside it is what makes
        /// <c>x > 1 ? a : b</c> read as <c>(x > 1) ? a : b</c>.
        /// </remarks>
        internal Expr Ternary(int minPrecedence)
        {
            Expr test = Expression(minPrecedence);
            SkipSpace();
            if (Done || _src[_pos] != '?')
            {
                return test;
            }

            _pos++;
            Expr consequent = Ternary(0);
            SkipSpace();
            if (Done || _src[_pos] != ':')
            {
                throw new ArgumentException($"if expression: a ? without its : in \"{_src}\"");
            }

            _pos++;
            return new Conditional(test, consequent, Ternary(0));
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
                Expr inner = Ternary(0);
                SkipSpace();
                if (Done || _src[_pos] != ')')
                {
                    throw new ArgumentException(
                        $"if expression: unbalanced parentheses in \"{_src}\"");
                }

                _pos++;
                return inner;
            }

            if (c == '[')
            {
                _pos++;
                List<Expr> items = new();
                SkipSpace();
                if (!Done && _src[_pos] == ']')
                {
                    _pos++;
                    return new Arr(items);
                }

                while (true)
                {
                    items.Add(Ternary(0));
                    SkipSpace();
                    if (Done)
                    {
                        throw new ArgumentException(
                            $"if expression: unbalanced brackets in \"{_src}\"");
                    }

                    if (_src[_pos] == ',')
                    {
                        _pos++;
                        continue;
                    }

                    if (_src[_pos] == ']')
                    {
                        _pos++;
                        break;
                    }

                    throw new ArgumentException(
                        $"if expression: unbalanced brackets in \"{_src}\"");
                }

                return new Arr(items);
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
                SkipSpace();
                // A call, but only on a bare name: `abs(x)` and never `obj.method(x)`. The
                // reference restricts it the same way, and the validator says so with a position.
                if (value is Name named && !Done && _src[_pos] == '(')
                {
                    _pos++;
                    List<Expr> args = new();
                    SkipSpace();
                    if (!Done && _src[_pos] == ')')
                    {
                        _pos++;
                    }
                    else
                    {
                        while (true)
                        {
                            args.Add(Ternary(0));
                            SkipSpace();
                            if (Done)
                            {
                                throw new ArgumentException(
                                    $"if expression: unbalanced parentheses in \"{_src}\"");
                            }

                            if (_src[_pos] == ',')
                            {
                                _pos++;
                                continue;
                            }

                            if (_src[_pos] == ')')
                            {
                                _pos++;
                                break;
                            }

                            throw new ArgumentException(
                                $"if expression: unbalanced parentheses in \"{_src}\"");
                        }
                    }

                    SkipSpace();
                    return new Call(named.Value, args);
                }

                // A subscript parses and then fails validation, so the complaint can say which
                // construct is unsupported rather than only where the parser stopped.
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
            // `in` is a WORD, so it counts only when what surrounds it cannot continue an
            // identifier — otherwise a sequence called "index" would be read as the operator
            // followed by "dex".
            if (_src.AsSpan(_pos).StartsWith("in".AsSpan(), StringComparison.Ordinal))
            {
                static bool IsWord(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '$';
                bool afterOk = _pos + 2 >= _src.Length || !IsWord(_src[_pos + 2]);
                bool beforeOk = _pos == 0 || !IsWord(_src[_pos - 1]);
                if (afterOk && beforeOk)
                {
                    return "in";
                }
            }

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
