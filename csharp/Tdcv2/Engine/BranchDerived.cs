using System;
using System.Collections.Generic;
using Tdcv2.Date;
using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Prng;

namespace Tdcv2.Engine;

/// <summary>
/// A formula or a date offset standing in a BRANCH — inside a <c>&lt;case&gt;</c>, or as one of
/// the <c>&lt;gen if="…"&gt;</c> branches of a sequence — rather than as a whole column.
/// </summary>
/// <remarks>
/// Of the four derived constructs, these two read nothing but their own row. So a branch can have
/// them as cheaply as a whole column can: for each row the branch holds, compute that row. Before
/// this class, a date offset in a branch lost <c>of=</c> and <c>plus=</c> without a word and drew an
/// unrelated date, and a formula stopped the run with an unhandled exception after <c>check</c>
/// had called the config valid.
/// <para>
/// <c>running</c>, <c>stat</c>, a formula that reads <c>prev()</c> and a pool reference are whole
/// columns by nature, and the validator keeps them out of branches (TDC295, TDC268). They never
/// reach here.
/// </para>
/// </remarks>
internal static class BranchDerived
{
    /// <summary>A formula, or a date measured from another column: the two that read only their row.</summary>
    internal static bool IsRowLocal(Gen gen) =>
        gen.Type == "formula" || DateOffset.IsOffset(gen.Type, gen.Attrs);

    /// <summary>The branch's values, one per position — <c>""</c> for a row the build will not keep.</summary>
    internal static IReadOnlyList<string> Values(
        Gen gen,
        int count,
        Sfc32 prng,
        MemoryEngine.Ctx ctx,
        PerRow.Stream? stream,
        List<long?>? instants)
    {
        var output = new string[count];
        Array.Fill(output, string.Empty);
        int RowOf(int i) => stream?.RowAt(i) ?? i;
        bool Kept(int row) => ctx.Kept is null || ctx.Kept.Contains(row);
        bool Has(string name) => ctx.HasSibling?.Invoke(name) == true;

        if (gen.Type == "formula")
        {
            string source = (gen.Attrs.GetValueOrDefault("expr") ?? string.Empty).Trim();
            if (source.Length == 0)
            {
                return output; // no expr= — the validator reports it
            }

            int? decimals = Formula.DecimalsOf(gen.Attrs);
            for (int i = 0; i < count; i++)
            {
                int row = RowOf(i);
                if (!Kept(row))
                {
                    continue;
                }

                // A column this row does not have leaves the cell empty, as it does for a formula
                // that is a whole column: a zero nobody generated is not an answer. No previous
                // row: prev() makes a formula a whole column, which TDC295 keeps out of a branch.
                output[i] = Formula.ValueAtRow(
                    source, decimals, row, Has, name => ctx.SiblingAt?.Invoke(name, row)) ?? "";
            }

            return output;
        }

        // A date offset: the same measurement the whole-column offset makes, row by row. A ranged
        // plus= draws its step from the row's own stream — (seed, stream, row) — so the step a row
        // gets does not depend on which other rows the branch holds.
        var stamps = new long?[count];
        string of = DateOffset.SourceOf(gen.Attrs);
        DateStep.OffsetResult parsed = DateStep.ParseOffset(gen.Attrs.GetValueOrDefault("plus"));
        if (Has(of) && parsed.Offset is { } offset)
        {
            string format = (gen.Attrs.GetValueOrDefault("format") ?? string.Empty).Trim();
            if (format.Length == 0)
            {
                format = "L";
            }

            long?[]? kept = ctx.Instants is not null && ctx.Instants.TryGetValue(of, out long?[]? found)
                ? found
                : null;
            string column = stream is null ? string.Empty : stream.Id.Split('#')[0];
            for (int i = 0; i < count; i++)
            {
                int row = RowOf(i);
                if (!Kept(row))
                {
                    continue;
                }

                string? text = ctx.SiblingAt?.Invoke(of, row);
                if (string.IsNullOrWhiteSpace(text))
                {
                    continue;
                }

                if (DateOffset.StartOfRow(column, gen.Attrs, kept, row, text) is not { } start)
                {
                    continue;
                }

                Sfc32 draw = stream is null ? prng : PerRow.RowGenerator(stream, row);
                PlainDateTime landed = DateStep.ApplyOffset(start, offset, DateOffset.DrawSteps(offset, draw));
                stamps[i] = Calendar.ToEpochMillis(landed);
                output[i] = DateFormatter.Format(landed, format, ctx.Locale);
            }
        }

        instants?.AddRange(stamps);
        return output;
    }

    /// <summary>
    /// Every column some date offset measures from, wherever the offset stands — a whole column, a
    /// <c>&lt;case&gt;</c> at any depth, an <c>if=</c> branch.
    /// </summary>
    /// <remarks>
    /// Those columns keep the instant they generated, so the offset works from the value whatever
    /// <c>format=</c> spelled it as.
    /// </remarks>
    internal static HashSet<string> OffsetSources(Config config)
    {
        var sources = new HashSet<string>(StringComparer.Ordinal);
        void Visit(Gen? gen)
        {
            if (gen is not null && DateOffset.IsOffset(gen.Type, gen.Attrs))
            {
                sources.Add(DateOffset.SourceOf(gen.Attrs));
            }
        }

        void VisitCase(Case c)
        {
            foreach (CasePart part in c.Parts)
            {
                if (part.Gen is not null)
                {
                    Visit(part.Gen);
                }
                else if (part.Mix is not null)
                {
                    foreach (Case inner in part.Mix.Cases)
                    {
                        VisitCase(inner);
                    }
                }
                else if (part.SwitchSpec is not null)
                {
                    VisitSwitch(part.SwitchSpec);
                }
            }
        }

        void VisitSwitch(Switch sw)
        {
            foreach (SwitchEntry entry in sw.Entries)
            {
                VisitCase(entry.Value);
            }

            if (sw.Fallback is not null)
            {
                VisitCase(sw.Fallback);
            }
        }

        foreach (SequenceSpec spec in config.Sequences)
        {
            Visit(spec.Gen);
            foreach (Branch branch in spec.Branches ?? Array.Empty<Branch>())
            {
                Visit(branch.Gen);
            }

            foreach (Case c in spec.Mix?.Cases ?? Array.Empty<Case>())
            {
                VisitCase(c);
            }

            if (spec.SwitchSpec is not null)
            {
                VisitSwitch(spec.SwitchSpec);
            }
        }

        return sources;
    }

    /// <summary>The context, keeping only <paramref name="rows"/> of what it builds — narrowed, never widened.</summary>
    internal static MemoryEngine.Ctx KeepingOnly(MemoryEngine.Ctx ctx, IEnumerable<int> rows)
    {
        var kept = new HashSet<int>();
        foreach (int row in rows)
        {
            if (ctx.Kept is null || ctx.Kept.Contains(row))
            {
                kept.Add(row);
            }
        }

        return ctx with { Kept = kept };
    }
}
