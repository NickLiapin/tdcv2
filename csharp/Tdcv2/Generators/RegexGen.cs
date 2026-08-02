using System.Text;
using System.Text.RegularExpressions;
using Tdcv2.Prng;
using Tdcv2.Unicode;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="regex" value="..."/&gt;</c> — a value that matches a pattern.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately not the platform's regular-expression engine. Two reasons, and both are about the
/// product rather than about convenience:
/// </para>
/// <list type="bullet">
///   <item>
///     This runs a pattern <em>forwards</em>, producing a string, where an engine runs one
///     backwards to test a string. Nothing in .NET does the forward direction.
///   </item>
///   <item>
///     Every pattern here has a finite longest output, checked before a single value is made.
///     <c>*</c> and <c>+</c> are rejected outright, and <c>.</c> means a printable ASCII character
///     rather than "almost anything". A config that asked for an unbounded pattern would otherwise
///     be a request for an arbitrarily large file.
///   </item>
/// </list>
/// <para>
/// The subset is portable on purpose: no platform's dialect quirks, no Unicode property classes, no
/// lookaround. What is accepted produces the same string from the same seed in every implementation
/// of TDC.
/// </para>
/// </remarks>
public static class RegexGen
{
    public const int DefaultMaxLength = 32;

    internal static readonly IReadOnlyList<string> Digits = Alphabets.Between('0', '9');
    internal static readonly IReadOnlyList<string> Lower = Alphabets.Between('a', 'z');
    internal static readonly IReadOnlyList<string> Upper = Alphabets.Between('A', 'Z');
    internal static readonly IReadOnlyList<string> PrintableAscii = Alphabets.Between(' ', '~');
    internal static readonly IReadOnlyList<string> Word = BuildWord();
    internal static readonly IReadOnlyList<string> Spaces = new[] { " ", "\t" };

    private static readonly Regex AlphabetName = new("^[A-Za-z0-9._-]+$", RegexOptions.Compiled);

    private static IReadOnlyList<string> BuildWord()
    {
        var result = new List<string>(Upper);
        result.AddRange(Lower);
        result.AddRange(Digits);
        result.Add("_");
        return result;
    }

    // ── the tree ─────────────────────────────────────────────────────────────────────────────

    public abstract record Node
    {
        public sealed record Empty : Node;

        public sealed record Literal(string Value) : Node;

        public sealed record Chars(IReadOnlyList<string> Values) : Node;

        public sealed record Sequence(IReadOnlyList<Node> Parts) : Node;

        public sealed record Alternation(IReadOnlyList<Node> Choices) : Node;

        public sealed record Repeat(Node Inner, int Min, int Max) : Node;

        public sealed record Capture(int Index, Node Inner, long MaxLength) : Node;

        public sealed record Backref(int Index) : Node;
    }

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, int documentMaxLength, Sfc32 prng)
    {
        // A limit on the tag itself wins over the document's. That is how a pack can ship a UUID
        // pattern — 36 characters, well past the default 32 — without every config having to raise
        // its own ceiling to accommodate it.
        int limit = attrs.TryGetValue("regex_max_length", out string? own)
            ? ParseMaxLength(own)
            : documentMaxLength;
        Node root = Compile(attrs.GetValueOrDefault("value", ""), limit);

        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            result.Add(Render(root, new Dictionary<int, string>(), prng));
        }

        return result;
    }

    public static Node Compile(string pattern, int regexMaxLength)
    {
        var parser = new Parser(pattern);
        Node root = parser.Parse();
        long max = MaxLength(root, parser.CaptureMaxLengths);
        if (max > regexMaxLength)
        {
            throw new ArgumentException(
                $"regex can produce {max} characters, which exceeds "
                + $"regex_max_length={regexMaxLength}");
        }

        return root;
    }

    public static int ParseMaxLength(string? raw)
    {
        if (raw is null)
        {
            return DefaultMaxLength;
        }

        if (!int.TryParse(raw.Trim(), out int value) || value <= 0)
        {
            throw new ArgumentException(
                $"regex_max_length must be a positive integer, got \"{raw}\"");
        }

        return value;
    }

    // ── generating ───────────────────────────────────────────────────────────────────────────

    private static string Render(Node node, Dictionary<int, string> captures, Sfc32 prng)
    {
        switch (node)
        {
            case Node.Empty:
                return "";
            case Node.Literal l:
                return l.Value;
            case Node.Chars c:
                return Rand.Pick(prng, c.Values);
            case Node.Sequence s:
            {
                var text = new StringBuilder();
                // In order, always. Each part may take draws, so a different order is different data.
                foreach (Node part in s.Parts)
                {
                    text.Append(Render(part, captures, prng));
                }

                return text.ToString();
            }

            case Node.Alternation a:
                return Render(Rand.Pick(prng, a.Choices), captures, prng);
            case Node.Repeat r:
            {
                int times = Rand.NextInt(prng, r.Min, r.Max + 1);
                var text = new StringBuilder();
                for (int i = 0; i < times; i++)
                {
                    text.Append(Render(r.Inner, captures, prng));
                }

                return text.ToString();
            }

            case Node.Capture c:
            {
                string value = Render(c.Inner, captures, prng);
                captures[c.Index] = value;
                return value;
            }

            case Node.Backref b:
                return captures.GetValueOrDefault(b.Index, "");
            default:
                throw new InvalidOperationException($"regex: unhandled node {node}");
        }
    }

    /// <summary>The longest string the pattern can produce — computed before generating, never after.</summary>
    private static long MaxLength(Node node, IReadOnlyDictionary<int, long> captureMaxLengths)
    {
        switch (node)
        {
            case Node.Empty:
                return 0;
            case Node.Literal:
            case Node.Chars:
                return 1;
            case Node.Sequence s:
            {
                long total = 0;
                foreach (Node part in s.Parts)
                {
                    total = Guard(total + MaxLength(part, captureMaxLengths));
                }

                return total;
            }

            case Node.Alternation a:
            {
                long best = 0;
                foreach (Node choice in a.Choices)
                {
                    best = Math.Max(best, MaxLength(choice, captureMaxLengths));
                }

                return best;
            }

            case Node.Repeat r:
                return Guard(MaxLength(r.Inner, captureMaxLengths) * r.Max);
            case Node.Capture c:
                return c.MaxLength;
            case Node.Backref b:
                return captureMaxLengths.TryGetValue(b.Index, out long len) ? len : 0;
            default:
                throw new InvalidOperationException($"regex: unhandled node {node}");
        }
    }

    private static long Guard(long value)
    {
        if (value < 0 || value > int.MaxValue)
        {
            throw new ArgumentException("regex: maximum length is too large");
        }

        return value;
    }

    // ── parsing ──────────────────────────────────────────────────────────────────────────────

    internal sealed class Parser
    {
        private readonly string _pattern;
        private int _pos;
        private int _captureCount;
        private int _closedCaptureCount;

        internal readonly Dictionary<int, long> CaptureMaxLengths = new();

        internal Parser(string pattern) => _pattern = pattern;

        internal Node Parse()
        {
            Node node = Alternation();
            if (!AtEnd)
            {
                throw Error($"unexpected \"{Peek}\"");
            }

            return node;
        }

        private Node Alternation()
        {
            var choices = new List<Node> { Sequence() };
            while (Peek == "|")
            {
                _pos++;
                choices.Add(Sequence());
            }

            return choices.Count == 1 ? choices[0] : new Node.Alternation(choices);
        }

        private Node Sequence()
        {
            var parts = new List<Node>();
            while (!AtEnd)
            {
                string ch = Peek!;
                if (ch == ")" || ch == "|")
                {
                    break;
                }

                parts.Add(RepeatedAtom());
            }

            if (parts.Count == 0)
            {
                return new Node.Empty();
            }

            return parts.Count == 1 ? parts[0] : new Node.Sequence(parts);
        }

        private Node RepeatedAtom()
        {
            Node atom = Atom();
            string? ch = Peek;
            switch (ch)
            {
                case null:
                    return atom;
                case "?":
                    _pos++;
                    return FinishRepeat(atom, 0, 1);
                case "*":
                    throw Error("unbounded \"*\" quantifier is not allowed; use \"{0,n}\"");
                case "+":
                    throw Error("unbounded \"+\" quantifier is not allowed; use \"{1,n}\"");
                case "{":
                    return BoundedRepeat(atom);
                default:
                    return atom;
            }
        }

        private Node FinishRepeat(Node node, int min, int max)
        {
            if (max < min)
            {
                throw Error($"invalid quantifier bounds {{{min},{max}}}");
            }

            string? next = Peek;
            if (next == "?")
            {
                throw Error("lazy quantifiers are not supported");
            }

            if (next == "*" || next == "+" || next == "{")
            {
                throw Error("stacked quantifiers are not supported");
            }

            return new Node.Repeat(node, min, max);
        }

        private Node BoundedRepeat(Node node)
        {
            Expect("{");
            string minText = DigitRun();
            if (minText.Length == 0)
            {
                throw Error("quantifier must start with a number");
            }

            int min = SafeInt(minText);
            if (Peek == "}")
            {
                _pos++;
                return FinishRepeat(node, min, min);
            }

            Expect(",");
            string maxText = DigitRun();
            if (maxText.Length == 0)
            {
                throw Error("unbounded \"{n,}\" quantifier is not allowed; use \"{n,m}\"");
            }

            int max = SafeInt(maxText);
            Expect("}");
            return FinishRepeat(node, min, max);
        }

        private Node Atom()
        {
            string? ch = Peek;
            switch (ch)
            {
                case null:
                    return new Node.Empty();
                case "(":
                    return Group();
                case "[":
                    return CharClass();
                case "\\":
                    return Escape();
                case ".":
                    _pos++;
                    return Chars(PrintableAscii);
                case "^":
                case "$":
                    // Anchors match a position rather than a character, and a generated value is
                    // the whole string, so both are already true. They contribute nothing.
                    _pos++;
                    return new Node.Empty();
                case "*":
                case "+":
                case "?":
                case "{":
                    throw Error($"quantifier \"{ch}\" has no target");
                default:
                    _pos++;
                    return new Node.Literal(ch);
            }
        }

        private Node Group()
        {
            Expect("(");
            bool capturing = true;
            if (Peek == "?")
            {
                if (string.CompareOrdinal(_pattern, _pos, "?:", 0, 2) == 0)
                {
                    _pos += 2;
                    capturing = false;
                }
                else
                {
                    throw Error("lookaround, named, and conditional groups are not supported");
                }
            }

            int index = 0;
            if (capturing)
            {
                index = ++_captureCount;
            }

            Node node = Alternation();
            Expect(")");

            if (!capturing)
            {
                return node;
            }

            // A backreference is only legal once its group has closed, which is what this tracks.
            _closedCaptureCount = Math.Max(_closedCaptureCount, index);
            long groupMax = MaxLength(node, CaptureMaxLengths);
            CaptureMaxLengths[index] = groupMax;
            return new Node.Capture(index, node, groupMax);
        }

        private Node CharClass()
        {
            Expect("[");
            bool negated = Peek == "^";
            if (negated)
            {
                _pos++;
            }

            var collected = new List<string>();
            bool sawAtom = false;
            while (!AtEnd && Peek != "]")
            {
                sawAtom = true;
                ClassAtom start = ReadClassAtom();
                if (Peek == "-" && PeekNext is not null && PeekNext != "]")
                {
                    _pos++;
                    ClassAtom end = ReadClassAtom();
                    if (start.Single is null || end.Single is null)
                    {
                        throw Error("character class ranges must use single-character endpoints");
                    }

                    int lo = char.ConvertToUtf32(start.Single, 0);
                    int hi = char.ConvertToUtf32(end.Single, 0);
                    if (lo > hi)
                    {
                        throw Error($"invalid character range \"{start.Single}-{end.Single}\"");
                    }

                    collected.AddRange(Alphabets.Between(lo, hi));
                }
                else
                {
                    collected.AddRange(start.Values);
                }
            }

            Expect("]");
            if (!sawAtom)
            {
                throw Error("empty character classes are not supported");
            }

            var unique = new HashSet<string>(collected, StringComparer.Ordinal);
            List<string> final;
            if (negated)
            {
                final = new List<string>();
                foreach (string ch in PrintableAscii)
                {
                    if (!unique.Contains(ch))
                    {
                        final.Add(ch);
                    }
                }
            }
            else
            {
                final = Distinct(collected);
            }

            if (final.Count == 0)
            {
                throw Error("character class has no available characters");
            }

            return Chars(final);
        }

        private readonly record struct ClassAtom(IReadOnlyList<string> Values, string? Single);

        private ClassAtom ReadClassAtom()
        {
            string? ch = Peek;
            if (ch is null)
            {
                throw Error("unterminated character class");
            }

            if (ch == "\\")
            {
                return ClassEscape();
            }

            _pos++;
            return new ClassAtom(new[] { ch }, ch);
        }

        private ClassAtom ClassEscape()
        {
            Expect("\\");
            string ch = EscapedChar();
            switch (ch)
            {
                case "d":
                    return new ClassAtom(Digits, null);
                case "D":
                    return new ClassAtom(Inverse(Digits), null);
                case "w":
                    return new ClassAtom(Word, null);
                case "W":
                    return new ClassAtom(Inverse(Word), null);
                case "s":
                    return new ClassAtom(Spaces, null);
                case "S":
                    return new ClassAtom(Inverse(Spaces), null);
                case "a":
                    return Peek != "{"
                        ? new ClassAtom(new[] { ch }, ch)
                        : new ClassAtom(NamedAlphabet(), null);
                case "n":
                case "r":
                    throw Error("multiline escapes are not supported");
                case "t":
                    return new ClassAtom(new[] { "\t" }, "\t");
                case "p":
                case "P":
                    throw Error("Unicode property classes are not supported");
                default:
                    return new ClassAtom(new[] { ch }, ch);
            }
        }

        private Node Escape()
        {
            Expect("\\");
            string ch = EscapedChar();
            if (IsDigit(ch))
            {
                string indexText = ch + DigitRun();
                int index = SafeInt(indexText);
                if (index <= 0 || index > _closedCaptureCount)
                {
                    throw Error(
                        $"backreference \"\\{indexText}\" points to a group that is not generated yet");
                }

                return new Node.Backref(index);
            }

            switch (ch)
            {
                case "d":
                    return Chars(Digits);
                case "D":
                    return Chars(Inverse(Digits));
                case "w":
                    return Chars(Word);
                case "W":
                    return Chars(Inverse(Word));
                case "s":
                    return Chars(Spaces);
                case "S":
                    return Chars(Inverse(Spaces));
                case "a":
                    return Peek != "{" ? new Node.Literal(ch) : Chars(NamedAlphabet());
                case "n":
                case "r":
                    throw Error("multiline escapes are not supported");
                case "t":
                    return new Node.Literal("\t");
                case "p":
                case "P":
                    throw Error("Unicode property classes are not supported");
                default:
                    return new Node.Literal(ch);
            }
        }

        /// <summary><c>\a{name}</c> — a named alphabet, the escape that has no equivalent anywhere else.</summary>
        private IReadOnlyList<string> NamedAlphabet()
        {
            Expect("{");
            var name = new StringBuilder();
            while (!AtEnd && Peek != "}")
            {
                name.Append(Peek);
                _pos++;
            }

            Expect("}");
            if (name.Length == 0)
            {
                throw Error("alphabet escape \"\\a{...}\" requires a non-empty name");
            }

            if (!AlphabetName.IsMatch(name.ToString()))
            {
                throw Error($"invalid alphabet name \"{name}\"");
            }

            IReadOnlyList<string>? resolved = Alphabets.Chars(name.ToString());
            if (resolved is null)
            {
                throw Error($"unknown alphabet \"{name}\"");
            }

            return resolved;
        }

        private string EscapedChar()
        {
            string? ch = Peek;
            if (ch is null)
            {
                throw Error("dangling escape at end of pattern");
            }

            _pos++;
            return ch;
        }

        private string DigitRun()
        {
            var text = new StringBuilder();
            while (!AtEnd && IsDigit(Peek))
            {
                text.Append(Peek);
                _pos++;
            }

            return text.ToString();
        }

        private void Expect(string expected)
        {
            string? actual = Peek;
            if (actual != expected)
            {
                throw Error(
                    $"expected \"{expected}\" but found \"{actual ?? "end of pattern"}\"");
            }

            _pos++;
        }

        private bool AtEnd => _pos >= _pattern.Length;

        private string? Peek => AtEnd ? null : _pattern.Substring(_pos, 1);

        private string? PeekNext =>
            _pos + 1 >= _pattern.Length ? null : _pattern.Substring(_pos + 1, 1);

        private int SafeInt(string text)
        {
            if (!int.TryParse(text, out int value) || value < 0)
            {
                throw Error($"invalid quantifier number \"{text}\"");
            }

            return value;
        }

        private ArgumentException Error(string message) =>
            new($"regex: {message} at offset {_pos}");
    }

    internal static bool IsDigit(string? ch) =>
        ch is { Length: 1 } && ch[0] >= '0' && ch[0] <= '9';

    private static Node Chars(IReadOnlyList<string> values) => new Node.Chars(Distinct(values));

    /// <summary>Duplicates removed, first occurrence kept — the order is what a draw index means.</summary>
    private static List<string> Distinct(IReadOnlyList<string> values)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<string>(values.Count);
        foreach (string v in values)
        {
            if (seen.Add(v))
            {
                result.Add(v);
            }
        }

        return result;
    }

    internal static IReadOnlyList<string> Inverse(IReadOnlyList<string> excluded)
    {
        var exclude = new HashSet<string>(excluded, StringComparer.Ordinal);
        var result = new List<string>();
        foreach (string ch in PrintableAscii)
        {
            if (!exclude.Contains(ch))
            {
                result.Add(ch);
            }
        }

        return result;
    }
}
