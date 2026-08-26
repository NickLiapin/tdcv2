using Antlr4.Runtime;

namespace Tdcv2.Parser;

/// <summary>
/// Turns TDC source text into a parse tree.
/// </summary>
/// <remarks>
/// <para>
/// The grammar comes from <c>../grammar</c>, the same two files every implementation generates its
/// parser from. Keeping one grammar is what stops the languages slowly accepting different
/// dialects of the same thing.
/// </para>
/// <para>
/// ANTLR's default behaviour is to print syntax errors to the console and carry on with a
/// best-effort tree. That is wrong for a data generator: a config that half-parsed would produce
/// data that looks plausible and is not what was asked for. Errors are collected here and the
/// caller decides.
/// </para>
/// </remarks>
public static class TdcParserFacade
{
    /// <summary>One syntax error, with the position a person can act on.</summary>
    public sealed record SyntaxProblem(int Line, int Column, string Message)
    {
        public override string ToString() => $"{Line}:{Column} {Message}";
    }

    /// <summary>A parse tree plus whatever went wrong producing it.</summary>
    public sealed record Result(TDCParser.DocumentContext Tree, IReadOnlyList<SyntaxProblem> Problems)
    {
        public bool Ok => Problems.Count == 0;
    }

    /// <summary>
    /// A hard ceiling on element nesting. The parser recurses once per nested element, so input
    /// depth IS stack depth: a runaway document must be refused, not parsed until the stack gives
    /// out (a .NET stack overflow kills the process and cannot be caught). Real configs nest a
    /// handful of levels.
    /// </summary>
    public const int MaxElementDepth = 64;

    /// <summary>Parse a config, collecting syntax errors rather than printing them.</summary>
    public static Result Parse(string source)
    {
        var problems = new List<SyntaxProblem>();
        var fromAntlr = new List<SyntaxProblem>();
        var collector = new Collector(fromAntlr);

        PairedData.Rewrite rewritten = PairedData.Preprocess(source);

        // Ahead of ANTLR's own, because they were found ahead of it: a config whose paired tags do
        // not line up is misread from that point on, and the first thing said about it should say
        // why.
        foreach (PairedData.Problem problem in rewritten.Problems)
        {
            problems.Add(new SyntaxProblem(problem.Line, problem.Column, problem.Message));
        }

        var lexer = new TDCLexer(CharStreams.fromString(rewritten.Source));
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(collector);

        var parser = new TDCParser(new CommonTokenStream(lexer));
        parser.RemoveErrorListeners();
        parser.AddErrorListener(collector);
        parser.AddParseListener(new DepthGuard());
        var closingTags = new ClosingTagGuard();
        parser.AddParseListener(closingTags);

        try
        {
            TDCParser.DocumentContext tree = parser.document();
            problems.AddRange(WithClosingTagMismatch(fromAntlr, closingTags.Found));
            return new Result(tree, problems);
        }
        catch (ElementDepthException refusal)
        {
            // Past the ceiling there is no tree worth building — parsing it IS the danger.
            // Callers get what garbage input gets: an empty document plus the problem that
            // explains it.
            problems.AddRange(fromAntlr);
            problems.Add(new SyntaxProblem(refusal.Line, refusal.Column, refusal.Message));
            return new Result(EmptyDocument(), problems);
        }
    }

    /// <summary><c>&lt;/gen&gt;</c> to <c>gen</c>. Null for anything that is not a closing tag.</summary>
    private static string? ClosingName(string? text) =>
        text is not null && text.StartsWith("</", StringComparison.Ordinal)
            && text.EndsWith(">", StringComparison.Ordinal)
            ? text.Substring(2, text.Length - 3)
            : null;

    /// <summary>
    /// Puts the mismatch in its place, and drops what the parser said after it.
    /// </summary>
    /// <remarks>
    /// Everything reported past a misplaced closing tag is reading a tree that has already gone
    /// wrong — <c>extraneous input '&lt;/tdc&gt;'</c> at the bottom of the file being the usual
    /// one. What was said BEFORE it is about a part of the document the mismatch had not reached.
    /// </remarks>
    private static List<SyntaxProblem> WithClosingTagMismatch(
        List<SyntaxProblem> problems, SyntaxProblem? mismatch)
    {
        if (mismatch is null)
        {
            return problems;
        }
        var kept = new List<SyntaxProblem>();
        foreach (SyntaxProblem problem in problems)
        {
            if (problem.Line < mismatch.Line
                || (problem.Line == mismatch.Line && problem.Column < mismatch.Column))
            {
                kept.Add(problem);
            }
        }
        kept.Add(mismatch);
        return kept;
    }

    /// <summary>
    /// Records the first closing tag whose name is not its element's.
    /// </summary>
    /// <remarks>
    /// <c>openCloseElement : LT name=NAME attr* GT content endTag=END_TAG ;</c> takes ANY name in
    /// the closing tag, so <c>&lt;sequence&gt;…&lt;/gen&gt;</c> was a structurally valid document
    /// and nothing downstream compared the two: the element is built under its OPENING name and
    /// the closing tag is thrown away.
    /// <para>
    /// Only the first is kept. A closing tag on the wrong element shifts every closing tag after
    /// it, so one typo would otherwise produce a mismatch per remaining level — all describing the
    /// same typo, and only the first placed where the author can act on it.
    /// </para>
    /// </remarks>
    private sealed class ClosingTagGuard : Antlr4.Runtime.Tree.IParseTreeListener
    {
        internal SyntaxProblem? Found { get; private set; }

        public void EnterEveryRule(ParserRuleContext ctx)
        {
        }

        public void ExitEveryRule(ParserRuleContext ctx)
        {
            if (Found is not null || ctx.RuleIndex != TDCParser.RULE_openCloseElement)
            {
                return;
            }
            var element = (TDCParser.OpenCloseElementContext)ctx;
            IToken open = element.name;
            IToken close = element.endTag;
            // Recovery can leave either token missing or synthesised. A guess about what the
            // author meant to close is worth less than the parser's own complaint about the tag.
            if (open is null || close is null || close.Type != TDCParser.END_TAG)
            {
                return;
            }
            string? closes = ClosingName(close.Text);
            if (closes is null || closes == open.Text)
            {
                return;
            }
            Found = new SyntaxProblem(
                close.Line,
                close.Column,
                "</" + closes + "> closes <" + open.Text + ">, which was opened on line "
                    + open.Line.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        public void VisitTerminal(Antlr4.Runtime.Tree.ITerminalNode node)
        {
        }

        public void VisitErrorNode(Antlr4.Runtime.Tree.IErrorNode node)
        {
        }
    }

    /// <summary>A tree with nothing in it, for when the source is refused mid-parse.</summary>
    private static TDCParser.DocumentContext EmptyDocument() =>
        new TDCParser(new CommonTokenStream(new TDCLexer(CharStreams.fromString("")))).document();

    /// <summary>Raised when a document nests elements deeper than <see cref="MaxElementDepth"/>.</summary>
    private sealed class ElementDepthException : Exception
    {
        internal ElementDepthException(int line, int column)
            : base(
                "elements nested deeper than " + MaxElementDepth
                + " levels — refusing a runaway document")
        {
            Line = line;
            Column = column;
        }

        internal int Line { get; }

        internal int Column { get; }
    }

    /// <summary>
    /// Counts <c>element</c> rule entries and refuses the level past the ceiling. A parse
    /// listener fires before the rule body recurses — exactly the moment the 65th level is about
    /// to open and the stack is still shallow.
    /// </summary>
    private sealed class DepthGuard : Antlr4.Runtime.Tree.IParseTreeListener
    {
        private int _depth;

        public void EnterEveryRule(ParserRuleContext ctx)
        {
            if (ctx.RuleIndex != TDCParser.RULE_element)
            {
                return;
            }
            _depth++;
            if (_depth > MaxElementDepth)
            {
                throw new ElementDepthException(ctx.Start.Line, ctx.Start.Column);
            }
        }

        public void ExitEveryRule(ParserRuleContext ctx)
        {
            if (ctx.RuleIndex == TDCParser.RULE_element)
            {
                _depth--;
            }
        }

        public void VisitTerminal(Antlr4.Runtime.Tree.ITerminalNode node)
        {
        }

        public void VisitErrorNode(Antlr4.Runtime.Tree.IErrorNode node)
        {
        }
    }

    /// <summary>Collects what ANTLR would otherwise print and forget.</summary>
    private sealed class Collector : IAntlrErrorListener<IToken>, IAntlrErrorListener<int>
    {
        private readonly List<SyntaxProblem> _problems;

        internal Collector(List<SyntaxProblem> problems) => _problems = problems;

        public void SyntaxError(
            TextWriter output,
            IRecognizer recognizer,
            IToken offendingSymbol,
            int line,
            int charPositionInLine,
            string msg,
            RecognitionException e)
        {
            string message = msg;
            if (recognizer is Antlr4.Runtime.Parser parser && offendingSymbol?.Type == TokenConstants.EOF)
            {
                string? open = EnclosingOpenTag(parser);
                if (open is not null)
                {
                    message = $"<{open}> is never closed";
                }
            }

            _problems.Add(new SyntaxProblem(line, charPositionInLine, message));
        }

        /// <summary>The tag that was still open when the input ended.</summary>
        /// <remarks>
        /// ANTLR's own words for this are <c>mismatched input '&lt;EOF&gt;' expecting '&lt;/data&gt;'</c>
        /// and <c>missing END_TAG at '&lt;EOF&gt;'</c> — the first names the tag in a shape a reader
        /// has to decode, the second does not name it at all. The parser knows which rule it was
        /// inside and that rule carries the tag's name, so the question is answerable: walk out to
        /// the nearest tag-opening rule and read it. <c>null</c> when no such rule is on the stack,
        /// in which case ANTLR's message stands — a wrong guess would be worse than jargon.
        /// </remarks>
        private static string? EnclosingOpenTag(Antlr4.Runtime.Parser parser)
        {
            for (RuleContext? ctx = parser.Context; ctx is not null; ctx = ctx.Parent)
            {
                switch (parser.RuleNames[ctx.RuleIndex])
                {
                    case "dataElement":
                        return "data";
                    case "mapElement":
                        return "map";
                    case "openCloseElement":
                        // `openCloseElement : LT name=NAME attr* GT content endTag=END_TAG`
                        IToken? named = ((TDCParser.OpenCloseElementContext)ctx).name;
                        return string.IsNullOrEmpty(named?.Text) ? null : named!.Text;
                    default:
                        break; // Not a tag-opening rule; keep walking out.
                }
            }

            return null;
        }

        public void SyntaxError(
            TextWriter output,
            IRecognizer recognizer,
            int offendingSymbol,
            int line,
            int charPositionInLine,
            string msg,
            RecognitionException e) => _problems.Add(new SyntaxProblem(line, charPositionInLine, msg));
    }
}
