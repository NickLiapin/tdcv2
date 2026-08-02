using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;

namespace Tdcv2.Generators;

/// <summary>
/// <c>accumulate=</c> — a running total inside one record's <c>repeat</c> list.
///
/// A cell holding <c>100,150,150</c> becomes <c>100,250,400</c>. That is the shape most
/// "I need a running total" questions actually have: a receipt's subtotal, the elapsed
/// time of a session, the odometer over the legs of a trip. The accumulation lives inside
/// ONE record, which is why it costs nothing — a record is computed whole anyway, so rows
/// stay independent and streaming, parallel workers and GetAt are untouched.
///
/// The one decision worth defending is the arithmetic. Five implementations have to
/// produce the same bytes, and floating point does not: <c>0.1 + 0.2</c> prints
/// differently in JavaScript, Python, Java, C# and Rust. So the sum is done on SCALED
/// INTEGERS — <see cref="BigInteger"/> here, matching the reference's arbitrary precision
/// exactly rather than picking a width and hoping.
///
/// <c>min</c> and <c>max</c> are different in a useful way: their result IS one of the
/// inputs, so the winning element's own text is returned unchanged. A value that arrived
/// as <c>007</c> stays <c>007</c>.
/// </summary>
internal static class Accumulate
{
    /// <summary>What a running accumulation can do. Each keeps a value that only ever moves one way.</summary>
    internal static readonly string[] Ops = { "sum", "min", "max" };

    /// <summary>
    /// Read <c>accumulate=</c> where an unknown op simply means "none".
    ///
    /// The engine path uses this one. By the time a value is drawn the validator has
    /// already refused a misspelled op (TDC238), so throwing here would only turn a
    /// reported problem into a crash.
    /// </summary>
    internal static string? Read(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("accumulate") ?? "").Trim();
        return Array.IndexOf(Ops, raw) >= 0 ? raw : null;
    }

    /// <summary>The same, but strict — the validator's copy, which turns a bad op into a diagnostic.</summary>
    internal static string? Parse(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("accumulate") ?? "").Trim();
        if (raw.Length == 0)
        {
            return null;
        }

        if (Array.IndexOf(Ops, raw) < 0)
        {
            throw new AccumulateException(
                $"accumulate=\"{raw}\" is not one of {string.Join(", ", Ops)}");
        }

        return raw;
    }

    /// <summary>
    /// Turn a list into its running accumulation.
    ///
    /// An EMPTY element stays empty and leaves the accumulator alone. That is what
    /// <c>missing=</c> produces, and "no reading that day" should not reset a meter or
    /// count as a zero-value transaction.
    /// </summary>
    internal static IReadOnlyList<string> Apply(IReadOnlyList<string> parts, string op)
    {
        // One pass to learn the widest fraction, so every element is compared and summed
        // at the same scale. Done first because the scale of the total must not depend on
        // which elements happened to come earlier.
        int scale = 0;
        var numbers = new (BigInteger Value, int Scale)?[parts.Count];
        for (int i = 0; i < parts.Count; i++)
        {
            if (parts[i].Trim().Length == 0)
            {
                continue;
            }

            (BigInteger, int) number = ParseFixed(parts[i]);
            numbers[i] = number;
            scale = Math.Max(scale, number.Item2);
        }

        var result = new List<string>(parts.Count);
        BigInteger? acc = null;
        string accText = "";
        for (int i = 0; i < parts.Count; i++)
        {
            if (numbers[i] is not { } number)
            {
                result.Add(parts[i]);
                continue;
            }

            BigInteger scaled = number.Value * BigInteger.Pow(10, scale - number.Scale);
            if (acc is not { } current)
            {
                acc = scaled;
                accText = parts[i];
            }
            else if (op == "sum")
            {
                acc = current + scaled;
            }
            else if ((scaled < current) == (op == "min"))
            {
                acc = scaled;
                accText = parts[i];
            }

            // min/max return an element that already exists, so its own spelling is kept;
            // sum produces a new number and is formatted at the shared scale.
            result.Add(op == "sum" ? FormatFixed(acc.Value, scale) : accText);
        }

        return result;
    }

    /// <summary>
    /// The same fold, but down a COLUMN instead of across a list.
    ///
    /// <c>&lt;gen type="running"&gt;</c> is this: row i's value is the accumulation of every
    /// row up to it. Reusing <see cref="Apply"/> rather than writing a second fold is
    /// deliberate — the arithmetic, the scale rule and the treatment of an empty cell then
    /// cannot drift apart between the two features.
    ///
    /// <c>base</c> is prepended and its result dropped, which is exactly "start from an
    /// opening balance": it joins the scale pool, so an opening <c>1000.00</c> widens the
    /// whole column to two decimals the way a reader would expect.
    ///
    /// <c>resetAt</c> splits the column into segments, each accumulated on its own — one
    /// running balance per account rather than one for the file.
    /// </summary>
    internal static string?[] ApplyColumn(
        string?[] values, string op, string? baseText, string?[]? resetAt)
    {
        var out_ = new string?[values.Length];
        int start = 0;
        while (start < values.Length)
        {
            int end;
            if (resetAt is null)
            {
                end = values.Length;
            }
            else
            {
                end = start + 1;
                while (end < values.Length && resetAt[end] == resetAt[start])
                {
                    end++;
                }
            }

            var parts = new List<string>();
            if (baseText is not null)
            {
                parts.Add(baseText);
            }

            for (int i = start; i < end; i++)
            {
                parts.Add(values[i] ?? "");
            }

            IReadOnlyList<string> running = Apply(parts, op);
            int offset = baseText is null ? 0 : 1;
            for (int i = start; i < end; i++)
            {
                // A row outside a parent filter has no value, and gains none: the
                // accumulator passed over it without counting it.
                out_[i] = values[i] is null ? null : running[i - start + offset];
            }

            start = end;
        }

        return out_;
    }

    /// <summary>
    /// One element as a value scaled by 10^scale.
    ///
    /// Deliberately strict. A generator that produces words has no running total, and
    /// quietly treating <c>abc</c> as zero would hand back a column that adds up to
    /// something and means nothing.
    /// </summary>
    private static (BigInteger Value, int Scale) ParseFixed(string text)
    {
        string trimmed = text.Trim();
        string body = trimmed.Length > 0 && (trimmed[0] == '+' || trimmed[0] == '-')
            ? trimmed.Substring(1)
            : trimmed;
        int dot = body.IndexOf('.');
        string whole = dot < 0 ? body : body.Substring(0, dot);
        string fraction = dot < 0 ? "" : body.Substring(dot + 1);
        bool shaped = whole.Length > 0
            && (dot < 0 || fraction.Length > 0)
            && AllDigits(whole)
            && AllDigits(fraction);
        if (!shaped)
        {
            throw new AccumulateException(
                $"accumulate=: \"{text}\" is not a number, so there is nothing to accumulate. "
                + "A running total needs numeric elements — accumulate= belongs on a numeric "
                + "generator.");
        }

        BigInteger magnitude = BigInteger.Parse(whole + fraction, CultureInfo.InvariantCulture);
        return (trimmed.StartsWith('-') ? -magnitude : magnitude, fraction.Length);
    }

    private static bool AllDigits(string text)
    {
        foreach (char c in text)
        {
            if (c < '0' || c > '9')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Back to text at <c>scale</c> decimal places, with no float in the path.</summary>
    private static string FormatFixed(BigInteger value, int scale)
    {
        if (scale == 0)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        bool negative = value.Sign < 0;
        string digits = BigInteger.Abs(value)
            .ToString(CultureInfo.InvariantCulture)
            .PadLeft(scale + 1, '0');
        int split = digits.Length - scale;
        return (negative ? "-" : "")
            + digits.Substring(0, split)
            + "."
            + digits.Substring(split);
    }
}

/// <summary>A misspelled op, or an element that is not a number.</summary>
internal sealed class AccumulateException : Exception
{
    internal AccumulateException(string message)
        : base(message)
    {
    }
}
