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
        bool keepInstants)
    {
        var values = new string[count];
        DateStep.OffsetResult parsed = DateStep.ParseOffset(attrs.GetValueOrDefault("plus"));
        if (parsed.Offset is not { } offset)
        {
            return (values, null); // a bad plus= is a diagnostic, not a crash
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

            PlainDateTime landed = DateStep.ApplyOffset(from, offset, DrawSteps(offset, prng));
            if (own is not null)
            {
                own[i] = Calendar.ToEpochMillis(landed);
            }

            values[i] = DateFormatter.Format(landed, format, locale);
        }

        return (values, own);
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
    private static PlainDateTime? StartOfRow(
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
    private static long DrawSteps(DateStep.OffsetSpec offset, Sfc32 prng)
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
internal sealed class DateOffsetException : Exception
{
    public DateOffsetException(string message, Exception inner)
        : base(message, inner)
    {
    }
}
