using Antlr4.Runtime;
using Tdcv2.Parser;

namespace Tdcv2.Formatter;

/// <summary>
/// Pretty-printer for <c>.tdc</c> documents.
/// </summary>
/// <remarks>
/// <para>
/// Re-emits the parsed tree with consistent indentation, tidy attribute spacing, inline output rows,
/// and an aligned <c>&lt;map&gt;</c> table. Built to be SAFE: the formatted text must generate
/// byte-identical output to the original.
/// </para>
/// <para>
/// Preserved verbatim: <c>&lt;data&gt;</c> bodies (that is literal generator output), comments
/// reinjected from the token stream by position, and attribute order and values. Normalized:
/// indentation at four spaces a level, a single space between attributes, and <c>&lt;map&gt;</c> rows
/// on one line when short or as an aligned table when not.
/// </para>
/// <para>
/// A document with a syntax error is returned unchanged. Never reformat a file that cannot be fully
/// parsed — the output would be a guess about what the author meant.
/// </para>
/// <para>
/// The four implementations must produce the same bytes: a team using two of them would otherwise
/// get a formatting diff on every commit, which is exactly the churn a formatter exists to end.
/// </para>
/// </remarks>
public static class TdcFormatter
{
    private const string Indent = "    ";

    /// <summary>Tags whose children always go on their own indented lines.</summary>
    private static readonly HashSet<string> BlockTags = new(StringComparer.Ordinal)
    {
        "tdc", "env", "block", "sequence", "mix", "switch", "distinct", "uniq",
        "before", "after", "before_block", "after_block", "delimiter_block",
        "before_line", "after_line", "delimiter_line",
    };

    /// <summary>Longest an inlined element may be before it wraps.</summary>
    private const int InlineMax = 100;

    /// <summary>Longest a one-line <c>&lt;map&gt;</c> may be before it becomes a table.</summary>
    private const int MapInlineMax = 72;

    private readonly record struct Comment(int Position, string Text);

    private sealed class Context
    {
        internal readonly List<string> Lines = new();
        internal readonly List<Comment> Comments = new();
        internal int Index;
    }

    /// <summary>A formatted config, or the source unchanged when it does not parse.</summary>
    public static string Format(string source)
    {
        PairedData.Rewrite rewritten = PairedData.Preprocess(source);
        var lexer = new TDCLexer(CharStreams.fromString(rewritten.Source));
        var tokens = new CommonTokenStream(lexer);
        var parser = new TDCParser(tokens);

        var problems = new List<string>();
        var listener = new CollectingListener(problems);
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(listener);
        parser.RemoveErrorListeners();
        parser.AddErrorListener(listener);

        TDCParser.DocumentContext tree = parser.document();
        if (problems.Count > 0 || rewritten.Problems.Count > 0)
        {
            return source;
        }

        var context = new Context();
        tokens.Fill();
        foreach (IToken token in tokens.GetTokens())
        {
            if (token.Type == TDCLexer.COMMENT)
            {
                context.Comments.Add(
                    new Comment(token.StartIndex, (token.Text ?? "").Trim()));
            }
        }

        foreach (TDCParser.ElementContext element in tree.element())
        {
            FlushCommentsBefore(Start(element), 0, context);
            EmitElement(element, 0, context);
        }

        FlushCommentsBefore(int.MaxValue, 0, context);

        return string.Join("\n", context.Lines) + "\n";
    }

    /// <summary>
    /// Collects syntax errors instead of printing them.
    /// </summary>
    /// <remarks>
    /// ANTLR's default listener writes to the console and carries on with a best-effort tree.
    /// A formatter that reformatted a half-parsed file would rewrite it into something the author
    /// never wrote.
    /// </remarks>
    private sealed class CollectingListener : IAntlrErrorListener<int>, IAntlrErrorListener<IToken>
    {
        private readonly List<string> _problems;

        internal CollectingListener(List<string> problems) => _problems = problems;

        public void SyntaxError(
            TextWriter output, IRecognizer recognizer, int offendingSymbol, int line,
            int charPositionInLine, string msg, RecognitionException e) => _problems.Add(msg);

        public void SyntaxError(
            TextWriter output, IRecognizer recognizer, IToken offendingSymbol, int line,
            int charPositionInLine, string msg, RecognitionException e) => _problems.Add(msg);
    }

    private static int Start(ParserRuleContext node) => node.Start?.StartIndex ?? 0;

    private static void FlushCommentsBefore(int position, int depth, Context context)
    {
        while (context.Index < context.Comments.Count)
        {
            Comment comment = context.Comments[context.Index];
            if (comment.Position >= position)
            {
                break;
            }

            context.Lines.Add(Repeat(Indent, depth) + comment.Text);
            context.Index++;
        }
    }

    private static void EmitElement(TDCParser.ElementContext element, int depth, Context context)
    {
        if (element.mapElement() is { } map)
        {
            EmitMap(map, depth, context);
            return;
        }

        if (element.dataElement() is { } data)
        {
            context.Lines.Add(Repeat(Indent, depth) + DataString(data));
            return;
        }

        if (element.selfClosingElement() is { } self)
        {
            context.Lines.Add(
                Repeat(Indent, depth) + "<" + self.name.Text + AttrString(self.attr()) + "/>");
            return;
        }

        if (element.openCloseElement() is { } open)
        {
            EmitOpen(open, depth, context);
        }
    }

    private static void EmitOpen(
        TDCParser.OpenCloseElementContext node, int depth, Context context)
    {
        string name = node.name.Text;
        string openTag = "<" + name + AttrString(node.attr()) + ">";
        IReadOnlyList<TDCParser.ElementContext> children = Children(node.content());
        string pad = Repeat(Indent, depth);

        if (children.Count == 0)
        {
            context.Lines.Add(pad + openTag + "</" + name + ">");
            return;
        }

        string? inline = !BlockTags.Contains(name) && !HasCommentWithin(node, context)
            ? TryInlineOpen(node)
            : null;
        if (inline is not null && (pad + inline).Length <= InlineMax)
        {
            context.Lines.Add(pad + inline);
            return;
        }

        context.Lines.Add(pad + openTag);
        foreach (TDCParser.ElementContext child in children)
        {
            FlushCommentsBefore(Start(child), depth + 1, context);
            EmitElement(child, depth + 1, context);
        }

        context.Lines.Add(pad + "</" + name + ">");
    }

    private static IReadOnlyList<TDCParser.ElementContext> Children(
        TDCParser.ContentContext? content) =>
        content is null ? Array.Empty<TDCParser.ElementContext>() : content.element();

    /// <summary>One-line rendering, or null when the element must span several.</summary>
    private static string? TryInline(TDCParser.ElementContext element)
    {
        if (element.mapElement() is { } map)
        {
            return InlineMap(map);
        }

        if (element.dataElement() is { } data)
        {
            return DataString(data);
        }

        if (element.selfClosingElement() is { } self)
        {
            return "<" + self.name.Text + AttrString(self.attr()) + "/>";
        }

        return element.openCloseElement() is { } open ? TryInlineOpen(open) : "";
    }

    private static string? TryInlineOpen(TDCParser.OpenCloseElementContext node)
    {
        string name = node.name.Text;
        if (BlockTags.Contains(name))
        {
            return null;
        }

        string openTag = "<" + name + AttrString(node.attr()) + ">";
        IReadOnlyList<TDCParser.ElementContext> children = Children(node.content());
        if (children.Count == 0)
        {
            return openTag + "</" + name + ">";
        }

        var inner = new System.Text.StringBuilder();
        foreach (TDCParser.ElementContext child in children)
        {
            string? part = TryInline(child);
            if (part is null)
            {
                return null;
            }

            inner.Append(part);
        }

        return openTag + inner + "</" + name + ">";
    }

    // ── <data> ───────────────────────────────────────────────────────────────────────────────

    private static string DataString(TDCParser.DataElementContext node)
    {
        if (node is not TDCParser.DataWithBodyContext body)
        {
            // A self-closing <data …/> has no body.
            return "<data" + AttrString(EmptyAttrs(node)) + "/>";
        }

        string attrs = AttrString(body.attr());
        IReadOnlyDictionary<string, string> map = AttrMap(body.attr());
        string close = map.TryGetValue("pair", out string? pair)
            ? "</data pair=\"" + pair + "\">"
            : "</data>";
        return "<data" + attrs + ">"
            + PairedData.Restore(body.dataContent().GetText()) + close;
    }

    private static TDCParser.AttrContext[] EmptyAttrs(TDCParser.DataElementContext node) =>
        node is TDCParser.DataSelfClosedContext self
            ? self.attr()
            : Array.Empty<TDCParser.AttrContext>();

    // ── <map> ────────────────────────────────────────────────────────────────────────────────

    private readonly record struct Row(string Keys, string Value);

    private static IReadOnlyList<Row> MapRows(TDCParser.MapElementContext node)
    {
        if (node is not TDCParser.MapWithBodyContext body)
        {
            return Array.Empty<Row>();
        }

        var rows = new List<Row>();
        foreach (string raw in body.mapContent().GetText().Split(','))
        {
            string row = raw.Trim();
            if (row.Length == 0)
            {
                continue;
            }

            int colon = row.IndexOf(':');
            if (colon < 0)
            {
                continue;
            }

            List<string> keys = row[..colon]
                .Split('|')
                .Select(part => part.Trim())
                .Where(part => part.Length > 0)
                .ToList();
            if (keys.Count == 0)
            {
                continue;
            }

            rows.Add(new Row(string.Join("|", keys), row[(colon + 1)..].Trim()));
        }

        return rows;
    }

    private static string InlineMap(TDCParser.MapElementContext node)
    {
        string parts = string.Join(", ", MapRows(node).Select(r => r.Keys + ":" + r.Value));
        return "<map" + AttrString(MapAttrs(node)) + ">" + parts + "</map>";
    }

    private static TDCParser.AttrContext[] MapAttrs(TDCParser.MapElementContext node) => node switch
    {
        TDCParser.MapWithBodyContext body => body.attr(),
        TDCParser.MapSelfClosedContext self => self.attr(),
        _ => Array.Empty<TDCParser.AttrContext>(),
    };

    private static void EmitMap(TDCParser.MapElementContext node, int depth, Context context)
    {
        string pad = Repeat(Indent, depth);
        IReadOnlyList<Row> rows = MapRows(node);
        if (rows.Count == 0)
        {
            context.Lines.Add(pad + "<map" + AttrString(MapAttrs(node)) + "></map>");
            return;
        }

        string inline = InlineMap(node);
        if (rows.Count <= 1 || (pad + inline).Length <= MapInlineMax)
        {
            context.Lines.Add(pad + inline);
            return;
        }

        // An aligned table: keys padded to the widest, a " : " separator, and a trailing comma on
        // all but the last row — the map reader splits on commas.
        int width = rows.Max(r => r.Keys.Length);
        context.Lines.Add(pad + "<map" + AttrString(MapAttrs(node)) + ">");
        for (int i = 0; i < rows.Count; i++)
        {
            string comma = i < rows.Count - 1 ? "," : "";
            context.Lines.Add(
                pad + Indent + rows[i].Keys.PadRight(width) + " : " + rows[i].Value + comma);
        }

        context.Lines.Add(pad + "</map>");
    }

    // ── attributes and comments ──────────────────────────────────────────────────────────────

    private static IReadOnlyDictionary<string, string> AttrMap(TDCParser.AttrContext[] attrs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TDCParser.AttrContext attr in attrs)
        {
            if (attr.attrName is null)
            {
                continue;
            }

            string value = attr.attrValue?.Text ?? "";
            if (value.Length >= 2 && value.StartsWith('"') && value.EndsWith('"'))
            {
                value = value[1..^1];
            }

            result[attr.attrName.Text] = value;
        }

        return result;
    }

    private static string AttrString(TDCParser.AttrContext[] attrs)
    {
        var result = new System.Text.StringBuilder();
        foreach (KeyValuePair<string, string> entry in AttrMap(attrs))
        {
            if (entry.Key.Length > 0)
            {
                result.Append(' ').Append(entry.Key).Append("=\"").Append(entry.Value).Append('"');
            }
        }

        return result.ToString();
    }

    private static bool HasCommentWithin(ParserRuleContext node, Context context)
    {
        int from = node.Start?.StartIndex ?? 0;
        int to = node.Stop?.StopIndex ?? from;
        return context.Comments.Any(c => c.Position > from && c.Position < to);
    }

    private static string Repeat(string text, int times) =>
        times <= 0 ? "" : string.Concat(Enumerable.Repeat(text, times));
}
