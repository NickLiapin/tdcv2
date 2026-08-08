using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Tdcv2.Packs;

/// <summary>
/// How many characters a composed pack's own <c>&lt;sequence&gt;</c> produces, when that is a
/// FACT rather than a guess.
/// </summary>
/// <remarks>
/// A pack parameter replaces one of the pack's sequences for the run:
/// <c>&lt;gen type="template" value="usa.finance.aba_routing" prefix="12"/&gt;</c> swaps the
/// pack's own <c>prefix</c>. That is the documented way to pin part of an identifier.
/// <para>
/// The packs that carry a CHECK DIGIT compute it over a fixed layout, so a pinned value of the
/// wrong width does not shift the layout — it breaks it. Measured on
/// <c>usa.finance.aba_routing</c>, whose <c>prefix</c> is 2 characters and <c>tail</c> is 6:
/// <c>prefix="12345"</c> aborted the run with <c>&lt;at&gt;: index 8 is out of range</c>, and
/// <c>tail="678"</c> wrote <c>326784</c> — six digits, and not a routing number. <c>check</c>
/// passed on both.
/// </para>
/// <para>
/// So the width is worked out here, and ONLY where it can be proven from the pack's own body:
/// a <c>text</c> alternation whose items are all the same length, a <c>regex</c> of one class
/// with an exact count, a zero-padded <c>number</c> range. Everything else is absent and the
/// caller stays silent, because a refusal has to be a proof.
/// </para>
/// </remarks>
public static class ParamWidth
{
    private static readonly Regex SequenceBlock = new(
        "<sequence\\s+[^>]*name\\s*=\\s*\"([^\"]+)\"[^>]*>(.*?)</sequence>",
        RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly Regex GenTag = new(@"<gen\b([^>]*)/?>", RegexOptions.Compiled);
    private static readonly Regex Attr = new("(\\w+)\\s*=\\s*\"([^\"]*)\"", RegexOptions.Compiled);
    private static readonly Regex Container = new(@"<(compute|mix|switch|case)\b", RegexOptions.Compiled);

    /// <summary>One class or escape repeated an exact number of times.</summary>
    private static readonly Regex FixedRegex = new(
        @"^(?:\[[^\]]+\]|\\[dwsDWS]|[A-Za-z0-9])\{(\d+)\}$", RegexOptions.Compiled);

    private static readonly Regex NumberRange = new(@"^(-?\d+)\.\.(-?\d+)$", RegexOptions.Compiled);

    /// <summary>The exact character count this generator always produces, or null.</summary>
    private static int? FixedWidth(string kind, string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        if (kind == "text")
        {
            string[] items = value!.Split(',');
            if (items.Length < 2)
            {
                return null; // a single literal is not a list
            }

            int width = items[0].Length;
            foreach (string item in items)
            {
                if (item.Length != width)
                {
                    return null;
                }
            }

            return width;
        }

        if (kind == "regex")
        {
            Match m = FixedRegex.Match(value!);
            return m.Success ? int.Parse(m.Groups[1].Value) : null;
        }

        if (kind == "number")
        {
            Match m = NumberRange.Match(value!);
            if (!m.Success)
            {
                return null;
            }

            string low = m.Groups[1].Value, high = m.Groups[2].Value;
            // Only a zero-padded range has a fixed width: `1..9999` is 1 to 4 characters.
            return low.Length == high.Length && low.StartsWith("0", StringComparison.Ordinal)
                ? low.Length
                : null;
        }

        return null;
    }

    /// <summary>Parameter name → the width the pack's own sequence always produces.</summary>
    public static IReadOnlyDictionary<string, int> ParameterWidths(string body)
    {
        var out_ = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match block in SequenceBlock.Matches(body))
        {
            string name = block.Groups[1].Value;
            string inner = block.Groups[2].Value;
            MatchCollection gens = GenTag.Matches(inner);
            // Exactly one `<gen>` and nothing else that produces a value: a compound sequence,
            // a <compute>, a <mix> or a <switch> has no single width to read.
            if (gens.Count != 1 || Container.IsMatch(inner))
            {
                continue;
            }

            var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (Match a in Attr.Matches(gens[0].Groups[1].Value))
            {
                attrs[a.Groups[1].Value] = a.Groups[2].Value;
            }

            // A named <gen> is one field of a compound; repetition or formatting means the bare
            // width read below is no longer what the sequence produces.
            if (attrs.ContainsKey("name") || attrs.ContainsKey("repeat")
                || attrs.ContainsKey("mask") || attrs.ContainsKey("missing"))
            {
                continue;
            }

            int? width = FixedWidth(attrs.GetValueOrDefault("type", ""), attrs.GetValueOrDefault("value"));
            if (width != null)
            {
                out_[name] = width.Value;
            }
        }

        return out_;
    }
}
