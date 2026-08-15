using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// Rendered text into a typed value.
/// </summary>
/// <remarks>
/// The engine produces strings; a typed container needs real values. Anything that cannot be
/// represented exactly is an error here — never a silent rounding, never a truncation. A synthetic
/// dataset that quietly loses digits is worse than one that refuses to be written, because the first
/// kind is discovered much later and by someone who trusted it.
/// </remarks>
public static class Convert
{
    /// <summary>A value ready for PLAIN encoding. <c>null</c> means the column is NULL on this row.</summary>
    public abstract record Value
    {
        public sealed record Bool(bool V) : Value;

        public sealed record Int(int V) : Value;

        public sealed record Long(long V) : Value;

        public sealed record Double(double V) : Value;

        public sealed record Text(string V) : Value;

        public sealed record Bytes(byte[] V) : Value;
    }

    private static readonly Regex Integer = new(@"^[+-]?\d+$", RegexOptions.Compiled);
    private static readonly Regex DatePattern = new(@"^(\d{4})-(\d{2})-(\d{2})$", RegexOptions.Compiled);
    private static readonly Regex DecimalPattern = new(@"^([+-]?)(\d+)(?:\.(\d*))?$", RegexOptions.Compiled);
    private static readonly Regex Hex32 = new("^[0-9a-f]{32}$", RegexOptions.Compiled);
    private static readonly Regex NumberText =
        new(@"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$", RegexOptions.Compiled);

    /// <summary>
    /// Convert one rendered cell.
    /// </summary>
    /// <remarks>
    /// Throws a message about the value and the expectation; the writer wraps it in the column name
    /// and the row number, so the complaint names the cell rather than the file.
    /// </remarks>
    public static Value? Of(string raw, ColumnType type)
    {
        if (raw.Length == 0)
        {
            return type.Nullable
                ? null
                : throw new ArgumentException(
                    "empty value in a required column (add |null to allow NULL)");
        }

        string text = raw.Trim();

        switch (type.Kind)
        {
            case ColumnKind.Bool:
            {
                string v = text.ToLowerInvariant();
                if (v is "true" or "1")
                {
                    return new Value.Bool(true);
                }

                if (v is "false" or "0")
                {
                    return new Value.Bool(false);
                }

                throw new ArgumentException(
                    $"\"{raw}\" is not a boolean (expected true/false or 1/0)");
            }

            case ColumnKind.Int32:
            {
                BigInteger v = ParseInteger(text, "int32");
                if (v < int.MinValue || v > int.MaxValue)
                {
                    throw new ArgumentException($"\"{raw}\" is out of range for int32");
                }

                return new Value.Int((int)v);
            }

            case ColumnKind.Int64:
            {
                BigInteger v = ParseInteger(text, "int64");
                if (v < long.MinValue || v > long.MaxValue)
                {
                    throw new ArgumentException($"\"{raw}\" is out of range for int64");
                }

                return new Value.Long((long)v);
            }

            case ColumnKind.UInt8:
                return new Value.Int((int)Unsigned(text, raw, 8));
            case ColumnKind.UInt16:
                return new Value.Int((int)Unsigned(text, raw, 16));
            case ColumnKind.UInt32:
                // Stored in a signed 32-bit slot: a value above 2^31-1 wraps to negative bits, which
                // is exactly what the unsigned annotation tells a reader to undo.
                return new Value.Int(unchecked((int)(uint)Unsigned(text, raw, 32)));
            case ColumnKind.UInt64:
                return new Value.Long(unchecked((long)(ulong)Unsigned(text, raw, 64)));
            case ColumnKind.Float:
            {
                double v = Number(text, raw);
                // Rounded to what four bytes can actually hold, so the value in memory is the value
                // on disk — otherwise the column statistics would describe numbers the file does
                // not have.
                float rounded = (float)v;
                if (!float.IsFinite(rounded))
                {
                    throw new ArgumentException($"\"{raw}\" is out of range for float");
                }

                return new Value.Double(rounded);
            }

            case ColumnKind.Float16:
            {
                double rounded = Plain.HalfToDouble(Plain.HalfBits(Number(text, raw)));
                if (!double.IsFinite(rounded))
                {
                    throw new ArgumentException($"\"{raw}\" is out of range for float16");
                }

                return new Value.Double(rounded);
            }

            case ColumnKind.Double:
                return new Value.Double(Number(text, raw));
            case ColumnKind.Date:
                return new Value.Int(Days(text));
            case ColumnKind.Timestamp:
                return new Value.Long(Millis(text, raw));
            case ColumnKind.Decimal:
                return new Value.Long(Decimal(text, type.Precision, type.Scale));
            case ColumnKind.Uuid:
                return new Value.Bytes(Uuid(text));
            case ColumnKind.String:
            case ColumnKind.Enum:
            case ColumnKind.Json:
                // Passed through untouched, surrounding spaces included.
                return new Value.Text(raw);
            default:
                throw new ArgumentException($"cannot convert to {type.Kind}");
        }
    }

    private static BigInteger ParseInteger(string text, string what) =>
        Integer.IsMatch(text)
            ? BigInteger.Parse(text, CultureInfo.InvariantCulture)
            : throw new ArgumentException($"\"{text}\" is not an integer ({what})");

    private static double Number(string text, string raw)
    {
        // .NET accepts a leading "+", thousands separators under some styles, and culture-specific
        // decimal points; JavaScript's Number() does not, and the implementations have to refuse the
        // same strings.
        if (!NumberText.IsMatch(text))
        {
            throw new ArgumentException($"\"{raw}\" is not a number");
        }

        double v = double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
        return double.IsFinite(v) ? v : throw new ArgumentException($"\"{raw}\" is not a number");
    }

    /// <summary>An unsigned integer of the given width, with negatives refused outright.</summary>
    private static BigInteger Unsigned(string text, string raw, int bits)
    {
        BigInteger v = ParseInteger(text, "uint" + bits);
        if (v.Sign < 0)
        {
            throw new ArgumentException($"\"{raw}\" is negative, but the column is unsigned");
        }

        BigInteger limit = (BigInteger.One << bits) - 1;
        return v <= limit
            ? v
            : throw new ArgumentException($"\"{raw}\" is out of range for uint{bits}");
    }

    /// <summary>Days since the epoch — how Parquet stores a date.</summary>
    private static int Days(string text)
    {
        Match m = DatePattern.Match(text);
        if (!m.Success)
        {
            throw new ArgumentException($"\"{text}\" is not a date (expected YYYY-MM-DD)");
        }

        int year = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        int month = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        int day = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
        try
        {
            var date = new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc);
            return (int)(date - DateTime.UnixEpoch).TotalDays;
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new ArgumentException($"\"{text}\" is not a date (no such calendar day)");
        }
    }

    private static long Millis(string text, string raw)
    {
        // Offset-qualified first; a bare local timestamp is read as UTC, as the reference does.
        if (DateTimeOffset.TryParse(
                text, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out DateTimeOffset parsed))
        {
            return parsed.ToUnixTimeMilliseconds();
        }

        throw new ArgumentException($"\"{raw}\" is not a timestamp (expected ISO-8601)");
    }

    /// <summary>A decimal as its unscaled integer — refusing anything the declared type cannot hold.</summary>
    private static long Decimal(string text, int precision, int scale)
    {
        Match m = DecimalPattern.Match(text);
        if (!m.Success)
        {
            throw new ArgumentException($"\"{text}\" is not a decimal");
        }

        string fraction = m.Groups[3].Success ? m.Groups[3].Value : "";
        if (fraction.Length > scale)
        {
            throw new ArgumentException(
                $"\"{text}\" has more decimal places than the declared scale {scale} — refusing "
                + "to round");
        }

        string digits = m.Groups[2].Value + fraction.PadRight(scale, '0');
        string significant = digits.TrimStart('0');
        if (significant.Length > precision)
        {
            throw new ArgumentException(
                $"\"{text}\" exceeds the declared precision {precision}");
        }

        BigInteger unscaled = BigInteger.Parse(digits, CultureInfo.InvariantCulture);
        if (m.Groups[1].Value == "-")
        {
            unscaled = -unscaled;
        }

        return unscaled >= long.MinValue && unscaled <= long.MaxValue
            ? (long)unscaled
            : throw new ArgumentException($"\"{text}\" does not fit a 64-bit decimal");
    }

    private static byte[] Uuid(string text)
    {
        string hex = text.Replace("-", "").ToLowerInvariant();
        if (!Hex32.IsMatch(hex))
        {
            throw new ArgumentException($"\"{text}\" is not a uuid");
        }

        var result = new byte[16];
        for (int i = 0; i < 16; i++)
        {
            result[i] = byte.Parse(
                hex.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        return result;
    }
}
