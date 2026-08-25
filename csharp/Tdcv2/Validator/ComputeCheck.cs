using System.Text.RegularExpressions;
using Tdcv2.Errors;
using Tdcv2.Format;
using Tdcv2.Parser;

namespace Tdcv2.Validation;

/// <summary>
/// The <c>&lt;compute&gt;</c> tree, checked before it runs.
/// </summary>
/// <remarks>
/// <para>
/// Compute is a small language of its own, and its mistakes are the quiet kind: a
/// <c>&lt;var&gt;</c> nobody bound reads as empty, a <c>&lt;choose&gt;</c> with no fallback produces
/// nothing when every branch misses, a second <c>&lt;result&gt;</c> silently wins over the first.
/// None of that stops a run — it produces a check digit that is wrong, in a file of a million
/// records that all look plausible.
/// </para>
/// <para>
/// So the whole tree is walked here: unknown tags, bindings, arity, encodings, and the wrapper
/// children each construct needs. Diagnostics TDC180 through TDC189.
/// </para>
/// </remarks>
internal sealed class ComputeCheck
{
    /// <summary>A list of allowed names, truncated the way every long list in a diagnostic is.</summary>
    private static string Candidates(IReadOnlyList<string> names)
    {
        const int most = 6;
        return names.Count <= most
            ? string.Join(", ", names)
            : string.Join(", ", names.Take(most)) + $", … ({names.Count - most} more)";
    }

    private static readonly HashSet<string> Encodings = new(StringComparer.Ordinal)
    {
        "base36", "ascii", "unicode", "hex", "binary", "octal",
    };
    /// <summary>
    /// The four tags that answer TRUE or FALSE rather than producing a value.
    /// </summary>
    /// <remarks>
    /// They are compute tags, so the unknown-tag check waves them through wherever they
    /// appear; this set is what keeps a predicate out of a value position, where the
    /// evaluator's own complaint arrived only at render time and named no file, line or code.
    /// </remarks>
    private static readonly HashSet<string> PredicateTags =
        new(StringComparer.Ordinal) { "equals", "greater_than", "less_than", "is_digit" };

    /// <summary>
    /// The two <c>&lt;field&gt;</c> names that arrive as NUMBERS rather than text.
    /// </summary>
    /// <remarks>
    /// Everything else a <c>&lt;field&gt;</c> can name is a rendered value, which is text
    /// until <c>&lt;to_number&gt;</c> says otherwise. These two are counts, so they go
    /// straight into <c>&lt;add&gt;</c> or <c>&lt;mod&gt;</c> — and, for the same reason,
    /// they are not something <c>&lt;is_digit&gt;</c> can answer about. Their type is known
    /// before the run, which is what makes a refusal a proof here and impossible for a
    /// <c>&lt;field&gt;</c> in general.
    /// </remarks>
    private static readonly HashSet<string> NumericBuiltinFields =
        new(StringComparer.Ordinal) { "_count", "_total" };


    /// <summary>
    /// Tags that used to be called something else.
    /// </summary>
    /// <remarks>
    /// Without this a renamed tag falls through to "unknown compute tag", which tells a reader
    /// their spelling is wrong and not what the right one is. The rename is the one moment when
    /// the engine knows exactly what was meant, so it says so.
    /// </remarks>
    private static readonly Dictionary<string, (string To, string Why)> RenamedTags =
        new(StringComparer.Ordinal)
        {
            ["var"] = ("use",
                "It never declared anything — <let> binds a name and this reads it back, which " +
                "is what the new name says. Rename the tag; the name= attribute is unchanged."),
        };

    private static readonly HashSet<string> KnownTags = new(StringComparer.Ordinal)
    {
        // literals and references
        "int", "str", "list", "field", "use", "current", "current_index", "acc",

        // binding
        "let",

        // collections
        "each", "reduce", "join", "split", "at", "length",

        // arithmetic
        "add", "subtract", "multiply", "divide", "mod",

        // encoding and conversion
        "encode", "to_number", "pad", "concat", "upper", "lower", "capitalize", "title",
        "mask", "slice", "replace", "trim", "group",

        // conditionals and the role wrappers
        "choose", "when", "otherwise", "test", "then", "result", "over", "do", "init", "in",
        "index",

        // predicates
        "equals", "greater_than", "less_than", "is_digit",
    };

    /// <summary>
    /// Tags the compute spec describes but this version does not ship, so the diagnostic explains
    /// the gap instead of reading like a typo.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> HintsByTag =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["param"] =
                "<param> belongs to the compute-def/use feature, which is not implemented yet. "
                + "An inline <compute> takes no parameters — read the value with "
                + "<field name=\"…\"/> instead.",
        };

    private static readonly Regex IntegerText = new(@"^-?\d+$", RegexOptions.Compiled);

    /// <summary>One node of the tree, flattened out of the two shapes the grammar produces.</summary>
    private sealed record Node(
        string Name,
        IReadOnlyDictionary<string, string> Attrs,
        IReadOnlyList<TDCParser.ElementContext> Children,
        int Line,
        int Column);

    /// <summary>What is visible where: the bound variables, and which bodies we are inside.</summary>
    private sealed record Scope(
        IReadOnlySet<string> Vars, bool InIteration, bool InReduce, IReadOnlySet<string>? KnownFields)
    {
        internal Scope WithVars(IReadOnlySet<string> newVars) => this with { Vars = newVars };

        internal Scope Iterating(bool reduce) =>
            this with { InIteration = true, InReduce = reduce || InReduce };
    }

    private readonly List<Diagnostic> _diagnostics;

    internal ComputeCheck(List<Diagnostic> diagnostics) => _diagnostics = diagnostics;

    /// <summary>Check one <c>&lt;compute&gt;</c>.</summary>
    /// <param name="knownFields">
    /// The names <c>&lt;field&gt;</c> may read, or <c>null</c> when the caller does not know them —
    /// a pack generator's body is checked without the run's sequences in view.
    /// </param>
    internal void Check(
        TDCParser.OpenCloseElementContext computeEl, IReadOnlySet<string>? knownFields)
    {
        var scope = new Scope(
            new HashSet<string>(StringComparer.Ordinal), false, false, knownFields);

        // Documented as "at most once". A second one silently wins and the first is discarded, so a
        // config can compute something entirely different from what its author read top to bottom.
        bool seenResult = false;
        foreach (TDCParser.ElementContext child in computeEl.content().element())
        {
            Node? node = ToNode(child);
            if (node is null || node.Name != "result")
            {
                continue;
            }

            if (seenResult)
            {
                Report(
                    node, "TDC189", "<compute> has more than one <result>",
                    "Only the last one would be used and the earlier ones silently dropped. "
                    + "Keep a single <result>.");
            }

            seenResult = true;
        }

        // <result> is documented as the single exit of a <compute>, and it was not authoritative:
        // the block kept the LAST value-producing child whatever its tag, so a stray sibling
        // written after <result> silently overrode it — the very fault TDC189 exists to prevent
        // between two <result>s.
        //
        // A <compute> with NO <result> is left alone on purpose: a body that is simply the
        // value-producing tree is a shape the docs teach and the shared cases use.
        if (seenResult)
        {
            foreach (TDCParser.ElementContext child in computeEl.content().element())
            {
                Node? node = ToNode(child);
                if (node is null || node.Name == "result" || node.Name == "let")
                {
                    continue;
                }

                Report(
                    node, "TDC189",
                    $"<{node.Name}> sits beside <result> in the same <compute>",
                    "The value comes from <result>, and a sibling written after it used to "
                    + "override that in silence. Move this inside <result>, bind it with <let>, "
                    + "or delete it.");
            }
        }

        WalkSlot(computeEl.content().element(), scope);
    }

    /// <summary>
    /// A slot: <c>&lt;let&gt;</c> prefixes bind for the siblings after them, and the last child is
    /// the value.
    /// </summary>
    private void WalkSlot(IReadOnlyList<TDCParser.ElementContext> children, Scope scope)
    {
        var bound = new HashSet<string>(scope.Vars, StringComparer.Ordinal);
        foreach (TDCParser.ElementContext child in children)
        {
            Node? node = ToNode(child);
            if (node is null)
            {
                continue;
            }

            if (node.Name == "let")
            {
                string name = node.Attrs.GetValueOrDefault("name", "");
                if (bound.Contains(name))
                {
                    Report(
                        node, "TDC185",
                        $"<let name=\"{name}\"> shadows an outer binding of the same name", null);
                }

                WalkSlot(
                    node.Children,
                    scope.WithVars(new HashSet<string>(bound, StringComparer.Ordinal)));
                bound.Add(name);
            }
            else
            {
                WalkExpr(
                    child, scope.WithVars(new HashSet<string>(bound, StringComparer.Ordinal)));
            }
        }
    }

    /// <summary>A construct that needs one named wrapper child, like <c>&lt;each&gt;&lt;over&gt;…</c>.</summary>
    private void WalkWrapper(Node node, string wrapper, Scope scope)
    {
        foreach (TDCParser.ElementContext child in node.Children)
        {
            Node? inner = ToNode(child);
            if (inner is not null && inner.Name == wrapper)
            {
                WalkSlot(inner.Children, scope);
                return;
            }
        }

        Report(node, "TDC187", $"<{node.Name}> requires a <{wrapper}> child", null);
    }

    private void WalkExpr(TDCParser.ElementContext element, Scope scope)
    {
        Node? node = ToNode(element);
        if (node is null)
        {
            return;
        }

        // A predicate answers TRUE or FALSE, so it is not a value. It is a compute tag, so
        // the unknown-tag check below waves it through wherever it appears — and
        // <result><greater_than>…</greater_than></result> then passed check and died mid-run
        // with a message carrying no code, no line and no file.
        if (PredicateTags.Contains(node.Name))
        {
            Report(
                node, "TDC180",
                $"<{node.Name}> is a predicate, not a value — it is valid only inside <test>",
                "A predicate answers true or false, and this position wants something to print. "
                + $"Wrap it: <choose><when><test><{node.Name}>…</{node.Name}></test></when>"
                + "<then>…</then></choose>.");
            return;
        }

        if (RenamedTags.TryGetValue(node.Name, out (string To, string Why) renamed))
        {
            Report(
                node, "TDC288", $"<{node.Name}> has been renamed to <{renamed.To}>", renamed.Why);
            return;
        }

        if (!KnownTags.Contains(node.Name))
        {
            Report(
                node, "TDC180", $"unknown compute tag <{node.Name}>",
                // The reference falls back to naming the tags a <compute> takes when the unknown
                // one has no note of its own. Without the fallback the refusal said only that the
                // tag is unknown, and left the reader to go and find the list -- on the one
                // diagnostic whose whole job is to point at it.
                HintsByTag.GetValueOrDefault(node.Name)
                    ?? $"Allowed inside <compute>: {Candidates(KnownTags.OrderBy(t => t, StringComparer.Ordinal).ToList())}.");
            return;
        }

        switch (node.Name)
        {
            case "current":
            case "current_index":
                if (!scope.InIteration)
                {
                    Report(
                        node, "TDC181",
                        $"<{node.Name}/> is only valid inside a <do> iteration body", null);
                }

                return;

            case "acc":
                if (!scope.InReduce)
                {
                    Report(
                        node, "TDC181", "<acc/> is only valid inside a <reduce> <do> body", null);
                }

                return;

            case "use":
            {
                string name = node.Attrs.GetValueOrDefault("name", "");
                if (!scope.Vars.Contains(name))
                {
                    Report(
                        node, "TDC182",
                        $"<use name=\"{name}\"> is not bound by an enclosing <let>", null);
                }

                return;
            }

            case "field":
            {
                string name = node.Attrs.GetValueOrDefault("name", "");
                if (scope.KnownFields is not null && !scope.KnownFields.Contains(name))
                {
                    Report(
                        node, "TDC182",
                        $"<field name=\"{name}\"> refers to a value that is not in scope", null);
                }

                return;
            }

            case "int":
            {
                string raw = node.Attrs.GetValueOrDefault("v", "").Trim();
                if (!IntegerText.IsMatch(raw))
                {
                    Report(
                        node, "TDC188",
                        $"<int v=\"{node.Attrs.GetValueOrDefault("v", "")}\"> is not an integer",
                        "Write a whole number, e.g. <int v=\"42\"/>. For text use <str v=\"…\"/>.");
                }

                return;
            }

            case "str":
                // A literal string: nothing about it can be wrong here.
                return;

            case "group":
                {
                    // A size the engine cannot use turns grouping OFF and says nothing, so the
                    // column comes out looking like the tag was never written. size="2.5" is
                    // worse: measured "12 34 567", grouped by neither 2 nor 3.
                    string? size = node.Attrs.GetValueOrDefault("size");
                    if (size is not null
                        && !System.Text.RegularExpressions.Regex.IsMatch(size.Trim(), "^[1-9][0-9]*$"))
                    {
                        Report(
                            node,
                            "TDC188",
                            $"<group size=\"{size.Trim()}\"> is not a whole number of characters",
                            "Write a positive whole number. A size the engine cannot use would turn "
                        + "grouping off and leave the value unchanged, with nothing to show why.");
                    }
                }

                WalkSlot(node.Children, scope);
                return;

            case "list":
            case "add":
            case "multiply":
            case "concat":
                // <list> has two spellings and reads only the first: with v= set the children are
                // never evaluated, so writing both keeps whichever the author was not looking at.
                if (node.Name == "list"
                    && node.Attrs.ContainsKey("v")
                    && CountNodes(node) > 0)
                {
                    Report(
                        node,
                        "TDC189",
                        "<list> has both v= and children",
                        "Only v= is read; the children are silently dropped. Keep one spelling: "
                            + "v=\"1,2,3\" for a literal list, or child elements for a computed one.");
                }

                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;

            case "mod":
            case "divide":
            {
                int count = CountNodes(node);
                if (count != 2)
                {
                    Report(
                        node, "TDC183",
                        $"<{node.Name}> requires exactly 2 children, found {count}", null);
                }

                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;
            }

            case "subtract":
                if (CountNodes(node) < 1)
                {
                    Report(node, "TDC183", "<subtract> requires at least one child", null);
                }

                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;

            case "each":
                CheckSlotNames(node, "over", "do");
                WalkWrapper(node, "over", scope);
                WalkWrapper(node, "do", scope.Iterating(false));
                return;

            case "reduce":
                CheckSlotNames(node, "over", "init", "do");
                WalkWrapper(node, "over", scope);
                WalkWrapper(node, "init", scope);
                WalkWrapper(node, "do", scope.Iterating(true));
                return;

            case "at":
                CheckSlotNames(node, "in", "index");
                WalkWrapper(node, "in", scope);
                WalkWrapper(node, "index", scope);
                return;

            case "mask":
            {
                // The filter form of the same fault is TDC256 in Validator. A mask with no
                // pattern has nothing to keep, and the engine answered that literally: it
                // returned the empty string.
                string pattern = node.Attrs.GetValueOrDefault("pattern", "").Trim();
                if (pattern.Length == 0)
                {
                    Report(
                        node, "TDC256",
                        "<mask> needs a pattern= — without one it returns the empty string", null);
                }
                else
                {
                    // And the pattern itself. mask= on a gen and the mask: filter are both
                    // pre-checked; this route was not, so the documented easy typo — x[1-2], a
                    // hyphen where the range wants ".." — passed check and aborted the run with
                    // no code, no file and no line.
                    try
                    {
                        Mask.Check(pattern);
                    }
                    catch (ArgumentException e)
                    {
                        Report(
                            node, "TDC199", e.Message,
                            "Indices are 0-based; ranges use \"..\", e.g. pattern=\"x[0..3]\" or "
                            + "pattern=\"w[-1], w[0]\".");
                    }
                }

                WalkSlot(node.Children, scope);
                return;
            }

            case "encode":
            {
                string @as = node.Attrs.GetValueOrDefault("as", "");
                if (!Encodings.Contains(@as))
                {
                    Report(node, "TDC186", $"<encode>: unknown encoding \"{@as}\"", null);
                }

                NumericBuiltinArgument(node.Children, "encode");
                WalkSlot(node.Children, scope);
                return;
            }

            case "choose":
                WalkChoose(node, scope);
                return;

            case "over":
                Report(
                    node, "TDC181", "<over> is only valid inside <each> or <reduce>",
                    "It names the list being walked. Outside those tags there is nothing to walk.");
                return;

            default:
                WalkSlot(node.Children, scope);
                return;
        }
    }

    /// <summary>
    /// A child in a SLOT position that names no slot this tag has.
    /// </summary>
    /// <remarks>
    /// <c>&lt;choose&gt;</c>, <c>&lt;when&gt;</c>, <c>&lt;each&gt;</c>, <c>&lt;reduce&gt;</c> and
    /// <c>&lt;at&gt;</c> do not evaluate their children in order — each looks up the slots it
    /// knows by name and ignores everything else. So a misspelled slot name was never walked,
    /// never validated, and never run. Measured on the compute overview's own Luhn example with
    /// <c>&lt;when&gt;</c> spelled <c>&lt;wen&gt;</c>: the <c>&lt;otherwise&gt;</c> won every row
    /// and every card number came out invalid, while <c>check</c> called the config valid.
    /// The stray part is deliberately NOT walked — what the author meant is unknown.
    /// </remarks>
    private void CheckSlotNames(Node node, params string[] slots)
    {
        foreach (TDCParser.ElementContext child in node.Children)
        {
            Node? inner = ToNode(child);
            if (inner is null || Array.IndexOf(slots, inner.Name) >= 0)
            {
                continue;
            }

            string allowed = string.Join(" and ", Array.ConvertAll(slots, s => $"<{s}>"));
            Report(
                inner,
                "TDC180",
                $"<{node.Name}> has no <{inner.Name}> part",
                $"Inside <{node.Name}> only {allowed} are read; anything else is silently "
                    + "ignored, so a misspelling here changes the result without any other sign.");
        }
    }

    private void WalkChoose(Node node, Scope scope)
    {
        CheckSlotNames(node, "when", "otherwise");
        bool hasOtherwise = false;
        foreach (TDCParser.ElementContext child in node.Children)
        {
            Node? inner = ToNode(child);
            if (inner is null)
            {
                continue;
            }

            if (inner.Name == "when")
            {
                WalkWhen(inner, scope);
            }
            else if (inner.Name == "otherwise")
            {
                hasOtherwise = true;
                WalkSlot(inner.Children, scope);
            }
        }

        if (!hasOtherwise)
        {
            // Without it, a row matching no branch computes nothing at all — and an empty check
            // digit is indistinguishable from a value that happens to be blank.
            Report(node, "TDC184", "<choose> requires an <otherwise> branch", null);
        }
    }

    private void WalkWhen(Node node, Scope scope)
    {
        CheckSlotNames(node, "test", "then");
        Node? test = null;
        foreach (TDCParser.ElementContext child in node.Children)
        {
            Node? inner = ToNode(child);
            if (inner is not null && inner.Name == "test")
            {
                test = inner;
                break;
            }
        }

        if (test is null)
        {
            Report(node, "TDC187", "<when> requires a <test> child", null);
        }
        else
        {
            foreach (TDCParser.ElementContext child in test.Children)
            {
                Node? predicate = ToNode(child);
                if (predicate is not null)
                {
                    WalkPredicate(predicate, scope);
                    break;
                }
            }
        }

        WalkWrapper(node, "then", scope);
    }

    /// <summary>
    /// <c>&lt;is_digit&gt;</c> and <c>&lt;encode&gt;</c> both want ONE CHARACTER OF TEXT, and
    /// both took a number without a word said.
    /// </summary>
    /// <remarks>
    /// The two failures look nothing alike, which is why only one of them was ever noticed.
    /// <c>&lt;is_digit&gt;</c> answered "no" on every row — including rows 1 to 9, where the
    /// count plainly is a digit — and check called the config valid. <c>&lt;encode&gt;</c> did
    /// stop the run, but with "expected a single-character string" and no file, no line and no
    /// code, on a config check had also called valid. Same cause, so one refusal covers both.
    /// </remarks>
    /// <summary>
    /// A <c>&lt;str&gt;</c> literal under a comparison, holding something that is not a number.
    /// </summary>
    /// <remarks>
    /// The three comparisons work on NUMBERS. A string of digits is accepted and read as one —
    /// <c>&lt;equals&gt;&lt;str v="7"/&gt;&lt;int v="7"/&gt;&lt;/equals&gt;</c> is true — so the
    /// tag is not "integers only", and refusing every <c>&lt;str&gt;</c> would break a config
    /// that works. What cannot work is a <c>&lt;str&gt;</c> whose text is not a number:
    /// measured, the run stopped with "expected an integer in &lt;equals&gt;, got the string
    /// ab", naming no file, no line and no code, on a config check had called valid.
    /// Only a LITERAL is checked — what a <c>&lt;field&gt;</c> will hold is not known before the
    /// run, and a refusal here has to be a proof.
    /// </remarks>
    private void ComparisonLiterals(Node node)
    {
        foreach (TDCParser.ElementContext child in node.Children)
        {
            Node? inner = ToNode(child);
            if (inner is null || inner.Name != "str")
            {
                continue;
            }

            string raw = inner.Attrs.TryGetValue("v", out string? v) ? v : "";
            if (Regex.IsMatch(raw.Trim(), "^-?[0-9]+$"))
            {
                continue;
            }

            Report(
                inner, "TDC287",
                $"<{node.Name}> compares numbers, and <str v=\"{raw}\"> is not one",
                "A <str> holding digits is read as the number it spells, so <str v=\"7\"/> is " +
                "fine. This one is not a number, so the run would stop on the first row. Use " +
                "<int>, or <to_number> around the value you meant to compare.");
        }
    }

    private void NumericBuiltinArgument(
        IReadOnlyList<TDCParser.ElementContext> children, string tag)
    {
        foreach (TDCParser.ElementContext child in children)
        {
            Node? inner = ToNode(child);
            string named = inner is not null && inner.Name == "field"
                ? (inner.Attrs.TryGetValue("name", out string? n) ? n : "")
                : "";
            if (inner is null || !NumericBuiltinFields.Contains(named))
            {
                continue;
            }

            string hint = tag == "is_digit"
                ? "It would answer \"no\" on every row, including the rows where the count is " +
                  "a single digit. Compare the number itself with <equals> or <less_than>, or " +
                  "put the digit you mean into a <str>."
                : "The run would stop with \"expected a single-character string\", naming no " +
                  "file and no line. Wrap it in <concat> to turn the number into its digits — " +
                  "<encode> still needs exactly one of them — or put the character you mean " +
                  "into a <str>.";
            Report(
                inner, "TDC286",
                $"<{tag}> asks about one character of text, and <field name=\"{named}\"> is a number",
                hint);
        }
    }

    private void WalkPredicate(Node node, Scope scope)
    {
        switch (node.Name)
        {
            case "equals":
            case "greater_than":
            case "less_than":
                if (CountNodes(node) != 2)
                {
                    Report(node, "TDC183", $"<{node.Name}> requires exactly 2 children", null);
                }

                ComparisonLiterals(node);
                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;

            case "is_digit":
                NumericBuiltinArgument(node.Children, "is_digit");
                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;

            default:
                Report(
                    node, "TDC180",
                    $"unknown predicate <{node.Name}> (valid only inside <test>)", null);
                return;
        }
    }

    // ── plumbing ─────────────────────────────────────────────────────────────────────────────

    private static Node? ToNode(TDCParser.ElementContext element)
    {
        TDCParser.OpenCloseElementContext open = element.openCloseElement();
        if (open is not null)
        {
            return new Node(
                open.name.Text, Attributes(open.attr()), open.content().element(),
                open.Start.Line, open.Start.Column);
        }

        TDCParser.SelfClosingElementContext self = element.selfClosingElement();
        if (self is not null)
        {
            return new Node(
                self.name.Text, Attributes(self.attr()),
                Array.Empty<TDCParser.ElementContext>(), self.Start.Line, self.Start.Column);
        }

        // A <data> body, which carries no compute node.
        return null;
    }

    /// <summary>How many of a node's children are elements — a text body is not an argument.</summary>
    private static int CountNodes(Node node) =>
        node.Children.Count(child => ToNode(child) is not null);

    private static IReadOnlyDictionary<string, string> Attributes(TDCParser.AttrContext[] attrs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TDCParser.AttrContext attr in attrs)
        {
            string raw = attr.attrValue.Text;
            result[attr.attrName.Text] = raw.Substring(1, raw.Length - 2);
        }

        return result;
    }

    private void Report(Node node, string code, string message, string? hint) =>
        _diagnostics.Add(Diagnostic.Error(code, message, hint ?? "", node.Line, node.Column));
}
