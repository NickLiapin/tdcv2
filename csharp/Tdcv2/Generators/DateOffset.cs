using System;
using System.Collections.Generic;
using Tdcv2.Date;
using Tdcv2.Prng;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="date" of="Admitted" plus="3..10d"&gt;</c> — a date measured from another date.
/// </summary>
/// <remarks>
/// The interval is in almost every real record — admitted and discharged, ordered and shipped,
/// issued and expires, the start and end of a shift — and it could not be said at all. Two
/// independent date columns put the discharge BEFORE the admission on a third of the rows, and the
/// workaround people reach for, non-overlapping windows ("admitted in January, discharged April to
/// June"), throws away exactly what the interval is for: its length, and how that length is
/// distributed. "Most stay a week, a few stay months" had no way to be written.
/// <para>
/// A generator sees no other column, by design — that is what makes a column's values a function
/// of the seed and the row index alone. This reads a sibling, so it is resolved in the engine
/// beside <c>running</c> and <c>stat</c>, in declaration order, which is also why <c>of=</c> must
/// name a column declared ABOVE it.
/// </para>
/// </remarks>
public static class DateOffset
{
    /// <summary>The column this date is measured from, or <c>""</c> when the generator did not say.</summary>
    public static string SourceOf(IReadOnlyDictionary<string, string> attrs) =>
        (attrs.GetValueOrDefault("of") ?? string.Empty).Trim();

    /// <summary>True when this <c>&lt;gen type="date"&gt;</c> is an offset rather than a draw.</summary>
    public static bool IsOffset(string type, IReadOnlyDictionary<string, string> attrs) =>
        type == "date" && SourceOf(attrs).Length > 0;

    /// <summary>The offset column, and its own instants when a third column measures from it.</summary>
    /// <remarks>
    /// One draw per row, and only when the offset is a RANGE: <c>plus="7d"</c> is a fixed distance
    /// and consumes no randomness at all, so a config that pins the interval leaves every other
    /// column exactly where it was.
    /// <para>
    /// A row whose source is empty — outside a parent filter, or a source that was itself filtered
    /// — stays empty. There is no date to measure from, and inventing one would put a value in a
    /// cell the config said should have none.
    /// </para>
    /// </remarks>
    public static (string[] Values, long?[]? Instants) Build(
        string name,
        IReadOnlyDictionary<string, string> attrs,
        IReadOnlyList<string> source,
        long?[]? instants,
        int count,
        Sfc32 prng,
        string? locale,
        bool keepInstants,
        IReadOnlyDictionary<string, string[]> columns)
    {
        var values = new string[count];
        DateStep.OffsetResult parsed = DateStep.ParseOffset(attrs.GetValueOrDefault("plus"));
        DateStep.ColumnOffset? byColumn =
            parsed.Ok ? null : DateStep.ParseColumnOffset(attrs.GetValueOrDefault("plus"));
        string[]? distance = byColumn is not null && columns.TryGetValue(byColumn.Column, out string[]? found)
            ? found
            : null;

        // A bad plus=, or a column nobody declared, is a diagnostic, not a crash.
        if ((!parsed.Ok && byColumn is null) || (byColumn is not null && distance is null))
        {
            return (values, null);
        }

        string format = (attrs.GetValueOrDefault("format") ?? string.Empty).Trim();
        if (format.Length == 0)
        {
            format = "L";
        }

        // An offset is itself a date this engine produced, so it keeps its own value when a THIRD
        // column measures from it — signed, expires a year later, remind a month before that.
        long?[]? own = keepInstants ? new long?[count] : null;

        for (int i = 0; i < count; i++)
        {
            string? text = i < source.Count ? source[i] : null;
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            PlainDateTime? start = StartOfRow(name, attrs, instants, i, text);
            if (start is not { } from)
            {
                continue;
            }

            PlainDateTime landed;
            if (byColumn is not null && distance is not null)
            {
                long? steps = StepsFromColumn(name, byColumn, i < distance.Length ? distance[i] : null, i);
                if (steps is not { } n)
                {
                    continue;
                }

                landed = DateStep.AddStep(from, byColumn.Unit, n);
            }
            else if (parsed.Offset is { } offset)
            {
                landed = DateStep.ApplyOffset(from, offset, DrawSteps(offset, prng));
            }
            else
            {
                continue;
            }

            if (own is not null)
            {
                own[i] = Calendar.ToEpochMillis(landed);
            }

            values[i] = DateFormatter.Format(landed, format, locale);
        }

        return (values, own);
    }

    /// <summary>The largest whole number every implementation reads exactly — JavaScript's safe integer.</summary>
    private const long MaxSafe = 9_007_199_254_740_991L;

    private static readonly System.Text.RegularExpressions.Regex Whole =
        new("^-?[0-9]+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// How many steps row <c>i</c> moves when <c>plus=</c> names a column, or null when its cell is
    /// empty — <c>missing=</c> blanked it, or a parent filter left the row without one — and the
    /// date stays empty with it, as it does when the date it is measured from is missing.
    /// </summary>
    /// <remarks>
    /// Only a whole number is a distance. A decimal is refused rather than rounded: <c>1.5</c> hours
    /// is ninety minutes, and silently landing on one or two hours would put a wrong time in a
    /// column that looks right. No draw is taken, so adding such a column moves no other value.
    /// </remarks>
    public static long? StepsFromColumn(string name, DateStep.ColumnOffset offset, string? cell, int i)
    {
        string text = (cell ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return null;
        }

        if (Whole.IsMatch(text)
            && long.TryParse(text, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out long n)
            && n >= -MaxSafe && n <= MaxSafe)
        {
            return offset.Sign * n;
        }

        throw new DateOffsetException(
            $"date offset (\"{name}\"): \"{text}\" in column \"{offset.Column}\" on row {i + 1} is not a "
            + "whole number. plus= reads the distance from that column, so it has to hold one — 15, -3, "
            + "120; for a fraction of an hour, count in minutes.",
            null);
    }

    /// <summary>The date row <c>i</c> is measured FROM, or null when the row has none.</summary>
    /// <remarks>
    /// Three readings, in this order:
    /// <list type="number">
    /// <item>
    /// <b>The instant the source column kept.</b> A <c>&lt;gen type="date"&gt;</c> this engine
    /// built remembers what it generated, so the offset works from the value and <c>format=</c> is
    /// free to be anything at all — the cell may read <c>March 2</c> or <c>02.03.2026</c> and the
    /// arithmetic is the same either way.
    /// </item>
    /// <item>
    /// <b>No instant on a column that carries them.</b> <c>missing="0.1"</c> blanked that cell: the
    /// column HAS a date for other rows and none for this one. The offset has nothing to measure
    /// and the cell stays empty.
    /// </item>
    /// <item>
    /// <b>The text, read as ISO.</b> A date that came from a file or a pack has only its spelling
    /// left. The ISO form has one reading in every locale, so it is accepted; anything else is
    /// refused rather than guessed at, because <c>02/03/2026</c> is the 2nd of March in one locale
    /// and the 3rd of February in another.
    /// </item>
    /// </list>
    /// </remarks>
    internal static PlainDateTime? StartOfRow(
        string name,
        IReadOnlyDictionary<string, string> attrs,
        long?[]? instants,
        int i,
        string text)
    {
        if (instants is not null)
        {
            long? kept = i < instants.Length ? instants[i] : null;
            return kept is { } millis ? Calendar.FromEpochMillis(millis) : null;
        }

        try
        {
            return DateParse.DateTime(text.Trim()).Value;
        }
        catch (Exception error) when (error is not DateOffsetException)
        {
            throw new DateOffsetException(
                $"date offset (\"{name}\"): \"{text}\" in column \"{SourceOf(attrs)}\" is not a "
                + "date this can measure from. A date TDC generated carries its own value and any "
                + "format= works; one read from a file or a pack has only its text, and only the "
                + "ISO form (YYYY-MM-DD) means the same thing in every locale.",
                error);
        }
    }

    /// <summary>How many steps this row moves.</summary>
    /// <remarks>
    /// A fixed offset takes no draw, which is what lets <c>plus="7d"</c> be added to a config
    /// without shifting any other column. A range takes exactly one.
    /// </remarks>
    internal static long DrawSteps(DateStep.OffsetSpec offset, Sfc32 prng)
    {
        if (offset.Lo == offset.Hi)
        {
            return offset.Lo;
        }

        long span = offset.Hi - offset.Lo + 1;
        return offset.Lo + Math.Min(span - 1, (long)(prng.Next() * span));
    }
}

/// <summary>A source column an offset cannot read.</summary>
internal sealed class DateOffsetException : InvalidOperationException
{
    public DateOffsetException(string message, Exception? inner)
        : base(message, inner)
    {
    }
}
