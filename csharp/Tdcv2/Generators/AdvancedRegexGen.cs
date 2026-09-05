using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Tdcv2.Distribution;
using Tdcv2.Prng;
using Tdcv2.Unicode;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="advanced_regex" .../&gt;</c> — the same finite subset, plus exact shares.
/// </summary>
/// <remarks>
/// <para><c>(?%{70:RU;20:US;10:DE})</c></para>
/// <para>
/// Seventy per cent of the column reads <c>RU</c>, exactly — not "seventy per cent on average".
/// Branches are themselves full patterns, so a weighted choice can hold a weighted choice.
/// </para>
/// <para>
/// It lives beside the plain <c>regex</c> generator rather than inside it, because an exact share is
/// only meaningful over a whole column. That forces a different way of generating: every row is
/// built <b>together</b>, level by level, with rows bucketed by the branch they were assigned. The
/// plain generator builds one value at a time and never has to know how many rows there are.
/// </para>
/// <para>
/// A consequence worth stating: the two dialects consume the generator in different orders, so the
/// same pattern produces different data under <c>regex</c> and <c>advanced_regex</c>. That is not a
/// defect to be reconciled — it follows from what an exact share requires.
/// </para>
/// </remarks>
public static class AdvancedRegexGen
{
    /// <summary>Inside a weighted branch these end it, on top of the usual <c>)</c> and <c>|</c>.</summary>
    private static readonly HashSet<string> BranchStop = new(StringComparer.Ordinal) { ";", "}" };

    private static readonly Regex AlphabetName = new("^[A-Za-z0-9._-]+$", RegexOptions.Compiled);

    private static readonly HashSet<string> NoStop = new(StringComparer.Ordinal);

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

        public sealed record Weighted(IReadOnlyList<Branch> Choices) : Node;

        /// <summary>
        /// <c>(?if{sex=male:MR;sex=female:MS})</c> — pick a branch from what an EARLIER named
        /// group produced on this row.
        /// </summary>
        /// <remarks>
        /// The one construct here that reads rather than draws. Everything else decides a row
        /// from randomness alone, which is why a pattern could describe an address or an
        /// identifier but never a title that agrees with a sex chosen two characters earlier.
        /// Branches are tried in the order written and the first match wins, so a <c>*</c> is an
        /// "otherwise" wherever it stands — and a row matching NO branch produces nothing at all,
        /// which is what <c>*</c> exists to prevent.
        /// </remarks>
        public sealed record Conditional(IReadOnlyList<CondBranch> Branches) : Node;
    }

    public sealed record Branch(double Percent, Node Inner);

    /// <summary>One branch of <c>(?if{…})</c>; <c>Test</c> is null for the <c>*</c> branch.</summary>
    public sealed record CondBranch(CondTest? Test, Node Inner);

    /// <summary>Which capture a branch reads, and the text it must equal.</summary>
    public sealed record CondTest(int Capture, string Value);

    /// <summary>One row under construction: what it has so far, and what its groups captured.</summary>
    private sealed class RowState
    {
        internal readonly StringBuilder Out = new();
        internal readonly Dictionary<int, string> Captures = new();
    }

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, int documentMaxLength, Sfc32 prng)
    {
        int limit = attrs.TryGetValue("regex_max_length", out string? own)
            ? RegexGen.ParseMaxLength(own)
            : documentMaxLength;
        Node root = Compile(attrs.GetValueOrDefault("value", ""), limit);

        var rows = new List<RowState>(count);
        for (int i = 0; i < count; i++)
        {
            rows.Add(new RowState());
        }

        GenerateInto(root, rows, prng);
        return rows.Select(r => r.Out.ToString()).ToArray();
    }

    public static Node Compile(string pattern, int regexMaxLength)
    {
        var parser = new Parser(pattern);
        Node root = parser.Parse();
        long max = MaxLength(root, parser.CaptureMaxLengths);
        if (max > regexMaxLength)
        {
            throw new ArgumentException(
                $"advanced_regex can produce {max} characters, which exceeds "
                + $"regex_max_length={regexMaxLength}");
        }

        return root;
    }

    /// <summary>Whether a pattern uses a weighted choice — the thing that needs a whole column at once.</summary>
    public static bool HasWeightedChoice(string pattern)
    {
        try
        {
            var parser = new Parser(pattern);
            parser.Parse();
            return parser.WeightedChoiceCount > 0;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            // A malformed pattern is not this question's business; the real parse error surfaces
            // when the generator runs.
            return false;
        }
    }

    // ── generating, a level at a time across every row ────────────────────────────────────────

    private static void GenerateInto(Node node, List<RowState> rows, Sfc32 prng)
    {
        if (rows.Count == 0)
        {
            return;
        }

        switch (node)
        {
            case Node.Empty:
                return;
            case Node.Literal l:
                foreach (RowState row in rows)
                {
                    row.Out.Append(l.Value);
                }

                return;
            case Node.Chars c:
                foreach (RowState row in rows)
                {
                    row.Out.Append(Rand.Pick(prng, c.Values));
                }

                return;
            case Node.Sequence s:
                foreach (Node part in s.Parts)
                {
                    GenerateInto(part, rows, prng);
                }

                return;
            case Node.Alternation a:
            {
                // Assign every row a branch first, then run each branch once over its own rows.
                List<List<RowState>> buckets = Buckets(a.Choices.Count);
                foreach (RowState row in rows)
                {
                    buckets[Rand.NextInt(prng, 0, a.Choices.Count)].Add(row);
                }

                for (int i = 0; i < a.Choices.Count; i++)
                {
                    if (buckets[i].Count > 0)
                    {
                        GenerateInto(a.Choices[i], buckets[i], prng);
                    }
                }

                return;
            }

            case Node.Repeat r:
            {
                var counts = new int[rows.Count];
                for (int i = 0; i < rows.Count; i++)
                {
                    counts[i] = Rand.NextInt(prng, r.Min, r.Max + 1);
                }

                // One pass per repetition, over the rows still repeating — so every row's first
                // repetition is drawn before any row's second.
                for (int step = 0; step < r.Max; step++)
                {
                    var active = new List<RowState>();
                    for (int i = 0; i < rows.Count; i++)
                    {
                        if (counts[i] > step)
                        {
                            active.Add(rows[i]);
                        }
                    }

                    GenerateInto(r.Inner, active, prng);
                }

                return;
            }

            case Node.Capture c:
            {
                var starts = new int[rows.Count];
                for (int i = 0; i < rows.Count; i++)
                {
                    starts[i] = rows[i].Out.Length;
                }

                GenerateInto(c.Inner, rows, prng);
                for (int i = 0; i < rows.Count; i++)
                {
                    rows[i].Captures[c.Index] =
                        rows[i].Out.ToString(starts[i], rows[i].Out.Length - starts[i]);
                }

                return;
            }

            case Node.Backref b:
                foreach (RowState row in rows)
                {
                    row.Out.Append(row.Captures.GetValueOrDefault(b.Index, ""));
                }

                return;
            case Node.Weighted w:
            {
                // The reason this generator exists: an exact apportionment over the column, the
                // same Hamilton machinery percent= uses, rather than an independent draw per row.
                var indexes = new List<int>(w.Choices.Count);
                var percents = new double[w.Choices.Count];
                for (int i = 0; i < w.Choices.Count; i++)
                {
                    indexes.Add(i);
                    percents[i] = w.Choices[i].Percent;
                }

                IReadOnlyList<int> selected = Hamilton.Distribute(rows.Count, indexes, percents, prng);
                List<List<RowState>> buckets = Buckets(w.Choices.Count);
                for (int i = 0; i < rows.Count; i++)
                {
                    buckets[selected[i]].Add(rows[i]);
                }

                for (int i = 0; i < w.Choices.Count; i++)
                {
                    if (buckets[i].Count > 0)
                    {
                        GenerateInto(w.Choices[i].Inner, buckets[i], prng);
                    }
                }

                return;
            }

            case Node.Conditional c:
            {
                // Each row to the FIRST branch it passes, then the branches in the order
                // written. Rows that pass no branch are left untouched — nothing is appended —
                // which is the only honest answer when the pattern says nothing about the value
                // the row actually holds.
                List<List<RowState>> buckets = Buckets(c.Branches.Count);
                foreach (RowState row in rows)
                {
                    for (int i = 0; i < c.Branches.Count; i++)
                    {
                        CondTest? test = c.Branches[i].Test;
                        string held = row.Captures.GetValueOrDefault(test?.Capture ?? 0, string.Empty);
                        if (test is null || held == test.Value)
                        {
                            buckets[i].Add(row);
                            break;
                        }
                    }
                }

                for (int i = 0; i < c.Branches.Count; i++)
                {
                    if (buckets[i].Count > 0)
                    {
                        GenerateInto(c.Branches[i].Inner, buckets[i], prng);
                    }
                }

                return;
            }

            default:
                throw new InvalidOperationException($"advanced_regex: unhandled node {node}");
        }
    }

    private static List<List<RowState>> Buckets(int size)
    {
        var result = new List<List<RowState>>(size);
        for (int i = 0; i < size; i++)
        {
            result.Add(new List<RowState>());
        }

        return result;
    }

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
            case Node.Weighted w:
            {
                long best = 0;
                foreach (Branch branch in w.Choices)
                {
                    best = Math.Max(best, MaxLength(branch.Inner, captureMaxLengths));
                }

                return best;
            }

            case Node.Conditional c:
            {
                // The longest branch: a row takes exactly one of them, so the widest the
                // conditional can be is the widest branch — never their sum.
                long best = 0;
                foreach (CondBranch branch in c.Branches)
                {
                    best = Math.Max(best, MaxLength(branch.Inner, captureMaxLengths));
                }

                return best;
            }

            default:
                throw new InvalidOperationException($"advanced_regex: unhandled node {node}");
        }
    }

    private static long Guard(long value)
    {
        if (value < 0 || value > int.MaxValue)
        {
            throw new ArgumentException("advanced_regex: maximum length is too large");
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

        internal int WeightedChoiceCount;

        internal readonly Dictionary<int, long> CaptureMaxLengths = new();

        /// <summary><c>(?&lt;name&gt;…)</c> → its capture index, filled as each named group CLOSES.</summary>
        /// <remarks>
        /// Closing rather than opening, so <c>(?&lt;a&gt;(?if{a=x:y}))</c> cannot read the group
        /// it is inside: at that point the group has produced nothing, and the condition would
        /// compare against the empty string on every row.
        /// </remarks>
        private readonly Dictionary<string, int> _groupNames = new(StringComparer.Ordinal);

        internal Parser(string pattern) => _pattern = pattern;

        internal Node Parse()
        {
            Node node = Alternation(NoStop);
            if (!AtEnd)
            {
                throw Error($"unexpected \"{Peek}\"");
            }

            return node;
        }

        private Node Alternation(HashSet<string> stop)
        {
            var choices = new List<Node> { Sequence(stop) };
            while (Peek == "|")
            {
                _pos++;
                choices.Add(Sequence(stop));
            }

            return choices.Count == 1 ? choices[0] : new Node.Alternation(choices);
        }

        private Node Sequence(HashSet<string> stop)
        {
            var parts = new List<Node>();
            while (!AtEnd)
            {
                string ch = Peek!;
                if (ch == ")" || ch == "|" || stop.Contains(ch))
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
            switch (Peek)
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
                    return Chars(RegexGen.PrintableAscii);
                case "^":
                case "$":
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
            if (Peek == "?" && StartsHere("?%{"))
            {
                _pos += 3;
                Node weighted = WeightedChoice();
                Expect(")");
                return weighted;
            }

            if (Peek == "?" && StartsHere("?if{"))
            {
                _pos += 4;
                Node conditional = Conditional();
                Expect(")");
                return conditional;
            }

            bool capturing = true;
            string? name = null;
            if (Peek == "?")
            {
                if (StartsHere("?:"))
                {
                    _pos += 2;
                    capturing = false;
                }
                else if (StartsHere("?<") && !IsLookbehind())
                {
                    _pos += 2;
                    name = GroupName();
                }
                else
                {
                    throw Error(
                        "this group is not supported — advanced_regex has (?:…), (?<name>…), "
                        + "(?%{…}) and (?if{…}). Lookaround and numbered conditionals decide "
                        + "what a pattern MATCHES, and nothing here is matching anything");
                }
            }

            int index = 0;
            if (capturing)
            {
                index = ++_captureCount;
            }

            Node node = Alternation(NoStop);
            Expect(")");
            if (!capturing)
            {
                return node;
            }

            _closedCaptureCount = Math.Max(_closedCaptureCount, index);
            long groupMax = MaxLength(node, CaptureMaxLengths);
            CaptureMaxLengths[index] = groupMax;
            if (name is not null)
            {
                _groupNames[name] = index;
            }

            return new Node.Capture(index, node, groupMax);
        }

        /// <summary><c>(?&lt;=…)</c> and <c>(?&lt;!…)</c> are LOOKBEHIND, not a group named "=".</summary>
        private bool IsLookbehind()
        {
            char after = _pos + 2 < _pattern.Length ? _pattern[_pos + 2] : ' ';
            return after == '=' || after == '!';
        }

        /// <summary>The <c>name</c> of <c>(?&lt;name&gt;…)</c>, up to the closing <c>&gt;</c>.</summary>
        private string GroupName()
        {
            int start = _pos;
            while (!AtEnd && Peek != ">")
            {
                _pos++;
            }

            string name = _pattern[start.._pos];
            Expect(">");
            if (name.Length == 0)
            {
                throw Error("a named group needs a name: (?<sex>…)");
            }

            // Spelled out rather than char.IsAsciiLetter: this targets net6.0, where that
            // helper does not exist, and "letter" here means ASCII in all five implementations.
            static bool IsLetter(char c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            static bool IsLetterOrDigit(char c) => IsLetter(c) || (c >= '0' && c <= '9');
            bool headOk = IsLetter(name[0]) || name[0] == '_';
            if (!headOk || !name.All(c => IsLetterOrDigit(c) || c == '_'))
            {
                throw Error(
                    $"group name \"{name}\" must start with a letter or \"_\" and hold only "
                    + "letters, digits and \"_\"");
            }

            // Two groups under one name would make `(?if{name=…})` a coin toss between them,
            // decided by whichever the parser happened to record last.
            if (_groupNames.ContainsKey(name))
            {
                throw Error($"group name \"{name}\" is already used");
            }

            return name;
        }

        /// <summary>
        /// <c>?if{sex=male:MR;sex=female:MS}</c> — the <c>(?if{</c> is already consumed.
        /// </summary>
        /// <remarks>
        /// Each branch is a full pattern, so weighted choices and further conditionals nest
        /// inside them exactly as they do inside a weighted branch.
        /// </remarks>
        private Node Conditional()
        {
            var branches = new List<CondBranch>();
            while (!AtEnd)
            {
                SkipSpaces();
                if (Peek == "}")
                {
                    throw Error("conditional must contain at least one branch");
                }

                CondTest? test = ConditionalTest();
                Node node = Alternation(BranchStop);
                branches.Add(new CondBranch(test, node));

                string? ch = Peek;
                if (ch == ";")
                {
                    _pos++;
                    continue;
                }

                if (ch == "}")
                {
                    _pos++;
                    return new Node.Conditional(branches);
                }

                throw Error("expected \";\" or \"}\" in conditional");
            }

            throw Error("unterminated conditional");
        }

        /// <summary><c>name=value</c> before a branch's <c>:</c>, or <c>*</c> for every other row.</summary>
        private CondTest? ConditionalTest()
        {
            int start = _pos;
            while (!AtEnd && Peek != ":" && Peek != "}")
            {
                _pos++;
            }

            string raw = _pattern[start.._pos];
            Expect(":");
            if (raw == "*")
            {
                return null;
            }

            int split = raw.IndexOf('=', StringComparison.Ordinal);
            if (split < 0)
            {
                throw Error(
                    $"conditional branch \"{raw}\" must read a group: name=value, or \"*\" "
                    + "for every other row");
            }

            string name = raw[..split].Trim();
            if (!_groupNames.TryGetValue(name, out int capture))
            {
                // Declared LATER is the same as not declared at all here: the pattern is
                // generated left to right, so a group further along has produced nothing to
                // compare against and the branch could never be taken.
                throw Error(
                    $"conditional reads \"{name}\", which no (?<{name}>…) group before it "
                    + "declares");
            }

            return new CondTest(capture, raw[(split + 1)..]);
        }

        private Node WeightedChoice()
        {
            var choices = new List<Branch>();
            while (!AtEnd)
            {
                SkipSpaces();
                if (Peek == "}")
                {
                    throw Error("weighted choice must contain at least one branch");
                }

                double percent = Weight();
                SkipSpaces();
                Expect(":");
                Node node = Alternation(BranchStop);
                choices.Add(new Branch(percent, node));

                string? ch = Peek;
                if (ch == ";")
                {
                    _pos++;
                    continue;
                }

                if (ch == "}")
                {
                    _pos++;
                    double sum = choices.Sum(b => b.Percent);
                    if (Math.Abs(sum - 100) > 0.0001)
                    {
                        throw Error(
                            $"weighted choice percentages sum to {Text(sum)}, expected 100");
                    }

                    WeightedChoiceCount++;
                    return new Node.Weighted(choices);
                }

                throw Error("expected \";\" or \"}\" in weighted choice");
            }

            throw Error("unterminated weighted choice");
        }

        private double Weight()
        {
            int start = _pos;
            while (!AtEnd && (RegexGen.IsDigit(Peek) || Peek == "."))
            {
                _pos++;
            }

            string raw = _pattern[start.._pos];
            if (raw.Length == 0
                || !double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
                || !double.IsFinite(value)
                || value < 0)
            {
                throw Error($"invalid weighted choice percent \"{raw}\"");
            }

            return value;
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
                foreach (string ch in RegexGen.PrintableAscii)
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
                    return new ClassAtom(RegexGen.Digits, null);
                case "D":
                    return new ClassAtom(RegexGen.Inverse(RegexGen.Digits), null);
                case "w":
                    return new ClassAtom(RegexGen.Word, null);
                case "W":
                    return new ClassAtom(RegexGen.Inverse(RegexGen.Word), null);
                case "s":
                    return new ClassAtom(RegexGen.Spaces, null);
                case "S":
                    return new ClassAtom(RegexGen.Inverse(RegexGen.Spaces), null);
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
            if (RegexGen.IsDigit(ch))
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
                    return Chars(RegexGen.Digits);
                case "D":
                    return Chars(RegexGen.Inverse(RegexGen.Digits));
                case "w":
                    return Chars(RegexGen.Word);
                case "W":
                    return Chars(RegexGen.Inverse(RegexGen.Word));
                case "s":
                    return Chars(RegexGen.Spaces);
                case "S":
                    return Chars(RegexGen.Inverse(RegexGen.Spaces));
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
            while (!AtEnd && RegexGen.IsDigit(Peek))
            {
                text.Append(Peek);
                _pos++;
            }

            return text.ToString();
        }

        private void SkipSpaces()
        {
            while (Peek == " " || Peek == "\t")
            {
                _pos++;
            }
        }

        private void Expect(string expected)
        {
            string? actual = Peek;
            if (actual != expected)
            {
                throw Error($"expected \"{expected}\" but found \"{actual ?? "end of pattern"}\"");
            }

            _pos++;
        }

        private bool StartsHere(string text) =>
            _pos + text.Length <= _pattern.Length
            && string.CompareOrdinal(_pattern, _pos, text, 0, text.Length) == 0;

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
            new($"advanced_regex: {message} at offset {_pos}");

        /// <summary>A whole number prints without a decimal point, as the other three do.</summary>
        private static string Text(double v) =>
            v == Math.Floor(v) && double.IsFinite(v)
                ? ((long)v).ToString(CultureInfo.InvariantCulture)
                : v.ToString("R", CultureInfo.InvariantCulture);
    }

    private static Node Chars(IReadOnlyList<string> values) => new Node.Chars(Distinct(values));

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
}
