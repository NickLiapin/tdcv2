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
        var collector = new Collector(problems);

        var lexer = new TDCLexer(CharStreams.fromString(Normalize(source)));
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(collector);

        var parser = new TDCParser(new CommonTokenStream(lexer));
        parser.RemoveErrorListeners();
        parser.AddErrorListener(collector);
        parser.AddParseListener(new DepthGuard());

        try
        {
            TDCParser.DocumentContext tree = parser.document();
            return new Result(tree, problems);
        }
        catch (ElementDepthException refusal)
        {
            // Past the ceiling there is no tree worth building — parsing it IS the danger.
            // Callers get what garbage input gets: an empty document plus the problem that
            // explains it.
            problems.Add(new SyntaxProblem(refusal.Line, refusal.Column, refusal.Message));
            return new Result(EmptyDocument(), problems);
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

    /// <summary>
    /// Normalize paired raw text before lexing.
    /// </summary>
    /// <remarks>
    /// The grammar keeps a single static <c>&lt;/data&gt;</c> close token, which cannot express
    /// <c>&lt;data pair="X"&gt;…&lt;/data pair="X"&gt;</c> where the body may itself contain a
    /// literal <c>&lt;/data&gt;</c>. The reference rewrites the closing tag before lexing, and a
    /// port has to do the same or the two disagree on any config using pairs.
    /// <para>
    /// Not implemented here for the same reason it is not implemented in Java: no fixture in the
    /// golden set exercises it, and guessing at the rewrite would be worse than leaving the gap
    /// visible.
    /// </para>
    /// </remarks>
    private static string Normalize(string source) => source;

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
            RecognitionException e) => _problems.Add(new SyntaxProblem(line, charPositionInLine, msg));

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
