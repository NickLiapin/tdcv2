using System.Text.RegularExpressions;
using Tdcv2.Errors;
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
    private static readonly HashSet<string> Encodings = new(StringComparer.Ordinal)
    {
        "base36", "ascii", "unicode", "hex", "binary", "octal",
    };

    private static readonly HashSet<string> KnownTags = new(StringComparer.Ordinal)
    {
        // literals and references
        "int", "str", "list", "field", "var", "current", "current_index", "acc",

        // binding
        "let",

        // collections
        "each", "reduce", "join", "at", "length",

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

        if (!KnownTags.Contains(node.Name))
        {
            Report(
                node, "TDC180", $"unknown compute tag <{node.Name}>",
                HintsByTag.GetValueOrDefault(node.Name));
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

            case "var":
            {
                string name = node.Attrs.GetValueOrDefault("name", "");
                if (!scope.Vars.Contains(name))
                {
                    Report(
                        node, "TDC182",
                        $"<var name=\"{name}\"> is not bound by an enclosing <let>", null);
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

            case "list":
            case "add":
            case "multiply":
            case "concat":
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
                WalkWrapper(node, "over", scope);
                WalkWrapper(node, "do", scope.Iterating(false));
                return;

            case "reduce":
                WalkWrapper(node, "over", scope);
                WalkWrapper(node, "init", scope);
                WalkWrapper(node, "do", scope.Iterating(true));
                return;

            case "at":
                WalkWrapper(node, "in", scope);
                WalkWrapper(node, "index", scope);
                return;

            case "mask":
            {
                // The filter form of the same fault is TDC256 in Validator. A mask with no
                // pattern has nothing to keep, and the engine answered that literally: it
                // returned the empty string.
                if (node.Attrs.GetValueOrDefault("pattern", "").Trim().Length == 0)
                {
                    Report(
                        node, "TDC256",
                        "<mask> needs a pattern= — without one it returns the empty string", null);
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

    private void WalkChoose(Node node, Scope scope)
    {
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

                foreach (TDCParser.ElementContext child in node.Children)
                {
                    WalkExpr(child, scope);
                }

                return;

            case "is_digit":
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
