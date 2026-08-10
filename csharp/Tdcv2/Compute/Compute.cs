using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using Tdcv2.Format;
using Tdcv2.Parser;

namespace Tdcv2.Compute;

/// <summary>
/// The <c>&lt;compute&gt;</c> layer — a declarative little language for check digits.
/// </summary>
/// <remarks>
/// <para>
/// Real identifiers are not random strings. A tax number, an IBAN, a national ID: each carries a
/// check digit computed from the rest of itself, and a generated one without it is rejected by the
/// very system it was generated to test. This is what makes the difference between data that merely
/// looks right and data that passes validation.
/// </para>
/// <para>
/// It is a language rather than a list of built-in algorithms because there is no such list. Every
/// country invented its own weighting, and a data pack that can express the rule can add a country
/// without touching the engine — which is exactly how the bundled packs do it.
/// </para>
/// <para>
/// The parse tree is the syntax tree: the evaluator walks the ANTLR contexts directly. That is not a
/// shortcut, it is the portability contract — every implementation walks the same shape, so there is
/// no expression grammar for anyone to re-implement slightly differently.
/// </para>
/// <para>Pure: no clock, no randomness, no files. Its only inputs are the fields visible to it.</para>
/// </remarks>
public static class Compute
{
    /// <summary>What an evaluation can see: the sequence values in scope, by name.</summary>
    public interface IFields
    {
        string? Get(string name);
    }

    private sealed class DelegateFields : IFields
    {
        private readonly Func<string, string?> _lookup;

        internal DelegateFields(Func<string, string?> lookup) => _lookup = lookup;

        public string? Get(string name) => _lookup(name);
    }

    /// <summary>Adapts a plain lookup for <see cref="IFields"/>.</summary>
    public static IFields FieldsOf(Func<string, string?> lookup) => new DelegateFields(lookup);

    /// <summary>Bindings and the contextual values that exist only inside an iteration.</summary>
    private sealed record Scope(
        IFields Fields,
        IReadOnlyDictionary<string, Value> Vars,
        Value? Current,
        BigInteger? CurrentIndex,
        Value? Acc)
    {
        internal Scope WithVar(string name, Value value)
        {
            var next = new Dictionary<string, Value>(Vars, StringComparer.Ordinal) { [name] = value };
            // The whole scope carries over: a <let> inside an iteration must not drop current/acc.
            return this with { Vars = next };
        }

        internal Scope WithIteration(Value item, BigInteger index, Value? accumulator) =>
            this with { Current = item, CurrentIndex = index, Acc = accumulator };
    }

    /// <summary>A normalised view of one element: its name, attributes and element children.</summary>
    private sealed record Node(
        string Name,
        IReadOnlyDictionary<string, string> Attrs,
        IReadOnlyList<TDCParser.ElementContext> Children);

    private static readonly Regex IntegerText = new("^-?[0-9]+$", RegexOptions.Compiled);
    private static readonly Regex SingleDigit = new("^[0-9]$", RegexOptions.Compiled);

    /// <summary>Evaluate a <c>&lt;compute&gt;</c> element to its output string.</summary>
    public static string Evaluate(TDCParser.OpenCloseElementContext computeEl, IFields fields)
    {
        var scope = new Scope(fields, new Dictionary<string, Value>(), null, null, null);
        return Value.ToOutput(EvalSlot(Elements(computeEl.content()), scope));
    }

    /// <summary>
    /// Evaluate a <c>&lt;valid&gt;</c> element's predicate.
    /// </summary>
    /// <remarks>
    /// Some identifiers have combinations that are structurally impossible — a date that does not
    /// exist inside a national ID, a region code that was never issued. A pack draws again rather
    /// than emitting one.
    /// </remarks>
    public static bool EvaluatePredicate(
        TDCParser.OpenCloseElementContext validEl, IFields fields)
    {
        var scope = new Scope(fields, new Dictionary<string, Value>(), null, null, null);
        foreach (TDCParser.ElementContext child in Elements(validEl.content()))
        {
            if (NodeName(child).Length > 0)
            {
                return EvalPredicate(child, scope);
            }
        }

        throw new ComputeError("<valid> requires a predicate child");
    }

    // ── slots ────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A slot: any number of <c>&lt;let&gt;</c> bindings followed by exactly one value expression.
    /// </summary>
    /// <remarks>
    /// Bindings accumulate, so a later <c>&lt;let&gt;</c> and the final expression both see the
    /// earlier ones — which is what lets a long check-digit computation be written as a series of
    /// named steps instead of one unreadable nest.
    /// </remarks>
    private static Value EvalSlot(IReadOnlyList<TDCParser.ElementContext> children, Scope scope)
    {
        Scope local = scope;
        Value? result = null;
        foreach (TDCParser.ElementContext child in children)
        {
            if (NodeName(child) == "let")
            {
                Node n = ToNode(child);
                local = local.WithVar(
                    n.Attrs.GetValueOrDefault("name", ""), EvalSlot(n.Children, local));
            }
            else
            {
                result = Eval(child, local);
            }
        }

        return result ?? throw new ComputeError("empty expression slot: no value produced");
    }

    private static Value EvalWrapper(Node n, string wrapper, Scope scope) =>
        EvalSlot(RequireChild(n, wrapper).Children, scope);

    // ── the evaluator ────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The builtin row counters, which are numbers rather than text. <c>_first</c> and
    /// <c>_last</c> are deliberately absent: they are the strings "true" and "false".
    /// </summary>
    private static readonly HashSet<string> NumericBuiltinFields = new() { "_count", "_total" };

    private static Value Eval(TDCParser.ElementContext el, Scope scope)
    {
        Node n = ToNode(el);
        switch (n.Name)
        {
            // literals
            case "int":
            {
                string raw = n.Attrs.GetValueOrDefault("v", "");
                if (!IntegerText.IsMatch(raw))
                {
                    throw new ComputeError($"<int>: \"{raw}\" is not an integer");
                }

                return Value.Of(BigInteger.Parse(raw));
            }

            case "str":
                return Value.Of(n.Attrs.GetValueOrDefault("v", ""));
            case "list":
            {
                if (n.Attrs.TryGetValue("v", out string? raw))
                {
                    var literal = new List<Value>();
                    foreach (string part in raw.Split(','))
                    {
                        string p = part.Trim();
                        if (p.Length == 0)
                        {
                            continue;
                        }

                        if (!IntegerText.IsMatch(p))
                        {
                            throw new ComputeError($"<list>: \"{p}\" is not an integer");
                        }

                        literal.Add(Value.Of(BigInteger.Parse(p)));
                    }

                    return Value.Of(literal);
                }

                var built = new List<Value>();
                foreach (TDCParser.ElementContext c in n.Children)
                {
                    built.Add(Eval(c, scope));
                }

                return Value.Of(built);
            }

            // references
            case "field":
            {
                string name = n.Attrs.GetValueOrDefault("name", "");
                string value = scope.Fields.Get(name)
                    ?? throw new ComputeError($"<field>: \"{name}\" is not in scope");
                // A sequence's value is text, and AsInt deliberately refuses a multi-digit string
                // so that "the third character" and "the number 375" stay different things. The
                // row counters are not text: _count and _total are numbers by nature. Without
                // this they were strings, so the single-digit escape hatch carried them to row 9
                // and the tenth row failed. _first and _last stay out — they are the words "true"
                // and "false".
                if (NumericBuiltinFields.Contains(name)
                    && long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture,
                        out long counter))
                {
                    return Value.Of(counter);
                }

                return Value.Of(value);
            }

            case "use":
            {
                string name = n.Attrs.GetValueOrDefault("name", "");
                return scope.Vars.TryGetValue(name, out Value? value)
                    ? value
                    : throw new ComputeError($"<use>: \"{name}\" is not bound");
            }

            case "current":
                return scope.Current
                    ?? throw new ComputeError("<current/> used outside an iteration");
            case "current_index":
                return scope.CurrentIndex is { } index
                    ? Value.Of(index)
                    : throw new ComputeError("<current_index/> used outside an iteration");
            case "acc":
                return scope.Acc ?? throw new ComputeError("<acc/> used outside a <reduce>");
            case "let":
                throw new ComputeError("<let> is a binding prefix, not a value expression");

            // collections
            case "each":
            {
                IReadOnlyList<Value> items = IterableOf(EvalWrapper(n, "over", scope));
                Node body = RequireChild(n, "do");
                var mapped = new List<Value>(items.Count);
                for (int i = 0; i < items.Count; i++)
                {
                    mapped.Add(EvalSlot(body.Children, scope.WithIteration(items[i], i, null)));
                }

                return Value.Of(mapped);
            }

            case "reduce":
            {
                IReadOnlyList<Value> items = IterableOf(EvalWrapper(n, "over", scope));
                Node body = RequireChild(n, "do");
                Value acc = EvalWrapper(n, "init", scope);
                for (int i = 0; i < items.Count; i++)
                {
                    acc = EvalSlot(body.Children, scope.WithIteration(items[i], i, acc));
                }

                return acc;
            }

            case "join":
            {
                string sep = n.Attrs.GetValueOrDefault("sep", "");
                Value value = EvalSlot(n.Children, scope);
                if (value is not Value.Lst list)
                {
                    throw new ComputeError("<join>: expected a list");
                }

                return Value.Of(string.Join(sep, list.V.Select(Value.AsStr)));
            }

            // The exact inverse of <join>, and the fourth way to get a list.
            //
            // Before it there were three — a literal <list v="…">, the result of <each>, and a
            // string walked CHARACTER by character — and none of them could read back a column
            // that `repeat=` had joined. So "sum quantity x price over the lines of this order"
            // could not be said at all unless the two lists happened to have the same length.
            case "split":
            {
                string sep = n.Attrs.GetValueOrDefault("sep", "");
                // An empty separator is refused rather than given a meaning. C# would answer with
                // the whole string as one piece, JavaScript with every character, Python not at
                // all — so any reading here would make one implementation disagree with the rest.
                // Walking a string character by character already has a spelling: <over> takes a
                // string directly.
                if (sep.Length == 0)
                {
                    throw new ComputeError(
                        "<split>: sep= is empty — to walk a string character by character, put it "
                        + "in <over> directly, which is what an empty separator would have to mean");
                }

                Value target = EvalSlot(n.Children, scope);
                if (target is not Value.Str text)
                {
                    throw new ComputeError("<split>: expected a string, got a list");
                }

                var pieces = new List<Value>();
                foreach (string piece in text.V.Split(sep))
                {
                    pieces.Add(Value.Of(piece));
                }

                return Value.Of(pieces);
            }

            case "at":
            {
                Value coll = EvalWrapper(n, "in", scope);
                if (coll is not Value.Lst list)
                {
                    throw new ComputeError("<at>: <in> must be a list");
                }

                int idx = (int)Value.AsInt(EvalWrapper(n, "index", scope), "<at> index");
                if (idx >= 0 && idx < list.V.Count)
                {
                    return list.V[idx];
                }

                return n.Attrs.TryGetValue("default", out string? dflt)
                    ? Value.Of(Value.ParseIntStrict(dflt))
                    : throw new ComputeError(
                        $"<at>: index {idx} is out of range and no default is set");
            }

            case "length":
            {
                Value value = EvalSlot(n.Children, scope);
                return value switch
                {
                    Value.Str s => Value.Of(Mask.CodePoints(s.V).Count),
                    Value.Lst l => Value.Of(l.V.Count),
                    _ => throw new ComputeError("<length>: expected a string or list"),
                };
            }

            // arithmetic
            case "add":
            {
                BigInteger sum = BigInteger.Zero;
                foreach (TDCParser.ElementContext c in n.Children)
                {
                    sum += Value.AsInt(Eval(c, scope), "<add>");
                }

                return Value.Of(sum);
            }

            case "multiply":
            {
                BigInteger product = BigInteger.One;
                foreach (TDCParser.ElementContext c in n.Children)
                {
                    product *= Value.AsInt(Eval(c, scope), "<multiply>");
                }

                return Value.Of(product);
            }

            case "subtract":
            {
                if (n.Children.Count == 0)
                {
                    throw new ComputeError("<subtract> requires at least one child");
                }

                BigInteger acc = Value.AsInt(Eval(n.Children[0], scope), "<subtract>");
                for (int i = 1; i < n.Children.Count; i++)
                {
                    acc -= Value.AsInt(Eval(n.Children[i], scope), "<subtract>");
                }

                return Value.Of(acc);
            }

            case "mod":
            {
                IReadOnlyList<TDCParser.ElementContext> two = RequireTwo(n);
                return Value.Of(
                    Value.Mod(Value.AsInt(Eval(two[0], scope)), Value.AsInt(Eval(two[1], scope))));
            }

            case "divide":
            {
                IReadOnlyList<TDCParser.ElementContext> two = RequireTwo(n);
                return Value.Of(
                    Value.FloorDiv(
                        Value.AsInt(Eval(two[0], scope)), Value.AsInt(Eval(two[1], scope))));
            }

            // conversion
            case "encode":
            {
                Value value = EvalSlot(n.Children, scope);
                if (value is not Value.Str s)
                {
                    throw new ComputeError("<encode>: expected a single-character string");
                }

                return Value.Of(Encode.EncodeChar(s.V, n.Attrs.GetValueOrDefault("as", "")));
            }

            case "to_number":
                return Value.Of(Value.ParseIntStrict(Value.AsStr(EvalSlot(n.Children, scope))));
            case "pad":
            {
                int width = IntAttr(n, "width", 0);
                string fill = n.Attrs.GetValueOrDefault("fill", "0");
                return Value.Of(PadStart(Value.AsStr(EvalSlot(n.Children, scope)), width, fill));
            }

            case "concat":
            {
                var text = new StringBuilder();
                foreach (TDCParser.ElementContext c in n.Children)
                {
                    text.Append(Value.AsStr(Eval(c, scope)));
                }

                return Value.Of(text.ToString());
            }

            // text
            case "upper":
            case "lower":
            case "capitalize":
            case "title":
                return Value.Of(
                    Transforms.ApplyCase(n.Name, Value.AsStr(EvalSlot(n.Children, scope))));
            case "mask":
                return Value.Of(
                    Mask.Apply(
                        n.Attrs.GetValueOrDefault("pattern", ""),
                        Value.AsStr(EvalSlot(n.Children, scope))));
            case "slice":
            {
                string? to = n.Attrs.GetValueOrDefault("to");
                return Value.Of(
                    Transforms.Slice(
                        Value.AsStr(EvalSlot(n.Children, scope)),
                        IntAttr(n, "from", 0),
                        to is null ? null : int.Parse(to.Trim())));
            }

            case "replace":
            {
                string from = n.Attrs.GetValueOrDefault("from", "");
                string value = Value.AsStr(EvalSlot(n.Children, scope));
                return Value.Of(
                    from.Length == 0
                        ? value
                        : value.Replace(from, n.Attrs.GetValueOrDefault("to", "")));
            }

            case "trim":
                return Value.Of(Value.AsStr(EvalSlot(n.Children, scope)).Trim());
            case "group":
                return Value.Of(
                    Transforms.Group(
                        Value.AsStr(EvalSlot(n.Children, scope)),
                        IntAttr(n, "size", 3),
                        n.Attrs.GetValueOrDefault("sep", " ")));

            case "choose":
                return EvalChoose(n, scope);

            // Role wrappers carry no meaning of their own; they name a slot.
            case "result":
            case "do":
            case "over":
            case "init":
            case "in":
            case "index":
            case "then":
            case "otherwise":
                return EvalSlot(n.Children, scope);

            default:
                throw new ComputeError($"unknown compute tag <{n.Name}>");
        }
    }

    private static Value EvalChoose(Node n, Scope scope)
    {
        Node? otherwise = null;
        foreach (TDCParser.ElementContext child in n.Children)
        {
            Node cn = ToNode(child);
            if (cn.Name == "when")
            {
                if (EvalTest(RequireChild(cn, "test"), scope))
                {
                    return EvalSlot(RequireChild(cn, "then").Children, scope);
                }
            }
            else if (cn.Name == "otherwise")
            {
                otherwise = cn;
            }
        }

        return otherwise is not null
            ? EvalSlot(otherwise.Children, scope)
            : throw new ComputeError("<choose>: no <when> matched and no <otherwise> present");
    }

    private static bool EvalTest(Node test, Scope scope)
    {
        if (test.Children.Count == 0)
        {
            throw new ComputeError("<test> requires a predicate child");
        }

        return EvalPredicate(test.Children[0], scope);
    }

    private static bool EvalPredicate(TDCParser.ElementContext el, Scope scope)
    {
        Node n = ToNode(el);
        switch (n.Name)
        {
            case "equals":
            case "greater_than":
            case "less_than":
            {
                IReadOnlyList<TDCParser.ElementContext> two = RequireTwo(n);
                BigInteger x = Value.AsInt(Eval(two[0], scope), $"<{n.Name}>");
                BigInteger y = Value.AsInt(Eval(two[1], scope), $"<{n.Name}>");
                return n.Name switch
                {
                    "equals" => x == y,
                    "greater_than" => x > y,
                    _ => x < y,
                };
            }

            case "is_digit":
            {
                if (n.Children.Count == 0)
                {
                    throw new ComputeError("<is_digit> requires a child");
                }

                return Eval(n.Children[0], scope) is Value.Str s && SingleDigit.IsMatch(s.V);
            }

            default:
                throw new ComputeError(
                    $"unknown predicate <{n.Name}> (valid only inside <test>)");
        }
    }

    // ── tree helpers ─────────────────────────────────────────────────────────────────────────

    /// <summary>A string iterates by code point, a list by element. Anything else cannot be walked.</summary>
    private static IReadOnlyList<Value> IterableOf(Value value) => value switch
    {
        Value.Str s => Mask.CodePoints(s.V).Select(Value.Of).ToArray(),
        Value.Lst l => l.V,
        _ => throw new ComputeError("<over>: expected a string or list to iterate"),
    };

    private static Node ToNode(TDCParser.ElementContext el)
    {
        TDCParser.OpenCloseElementContext open = el.openCloseElement();
        if (open is not null)
        {
            return new Node(open.name.Text, Attributes(open.attr()), Elements(open.content()));
        }

        TDCParser.SelfClosingElementContext self = el.selfClosingElement();
        if (self is not null)
        {
            return new Node(
                self.name.Text, Attributes(self.attr()), Array.Empty<TDCParser.ElementContext>());
        }

        throw new ComputeError("unexpected <data> or malformed element inside <compute>");
    }

    private static string NodeName(TDCParser.ElementContext el)
    {
        TDCParser.OpenCloseElementContext open = el.openCloseElement();
        if (open is not null)
        {
            return open.name.Text;
        }

        TDCParser.SelfClosingElementContext self = el.selfClosingElement();
        return self is not null ? self.name.Text : "";
    }

    private static Node RequireChild(Node n, string name)
    {
        foreach (TDCParser.ElementContext child in n.Children)
        {
            if (NodeName(child) == name)
            {
                return ToNode(child);
            }
        }

        throw new ComputeError($"<{n.Name}> requires a <{name}> child");
    }

    private static IReadOnlyList<TDCParser.ElementContext> RequireTwo(Node n)
    {
        if (n.Children.Count != 2)
        {
            throw new ComputeError($"<{n.Name}> requires exactly 2 children");
        }

        return n.Children;
    }

    private static IReadOnlyList<TDCParser.ElementContext> Elements(
        TDCParser.ContentContext? content) =>
        content is null ? Array.Empty<TDCParser.ElementContext>() : content.element();

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

    private static int IntAttr(Node n, string name, int fallback)
    {
        string? raw = n.Attrs.GetValueOrDefault(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        return int.TryParse(raw.Trim(), out int value)
            ? value
            : throw new ComputeError($"<{n.Name}>: \"{name}\" must be a whole number");
    }

    /// <summary>Pad on the left by code point, so a multi-character fill repeats and then truncates.</summary>
    private static string PadStart(string value, int width, string fill)
    {
        int length = Mask.CodePoints(value).Count;
        if (length >= width || fill.Length == 0)
        {
            return value;
        }

        var pad = new StringBuilder();
        while (Mask.CodePoints(pad.ToString()).Count < width - length)
        {
            pad.Append(fill);
        }

        IReadOnlyList<string> cps = Mask.CodePoints(pad.ToString());
        return string.Concat(cps.Take(width - length)) + value;
    }
}
