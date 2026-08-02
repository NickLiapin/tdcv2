using System.Globalization;
using System.Text.RegularExpressions;

namespace Tdcv2.Output;

/// <summary>Everything a column may be declared as.</summary>
public enum ColumnKind
{
    Bool,
    Int32,
    Int64,

    // Unsigned integers store the same bytes and are annotated so a reader knows the top bit is
    // magnitude rather than sign.
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Float,
    Float16,
    Double,
    String,
    Enum,
    Date,
    Timestamp,
    Decimal,
    Uuid,
    Json,

    /// <summary>A list of the element type — <c>type="[]int64"</c>.</summary>
    List,
}

/// <summary>
/// The declared type of an output column: <c>type="int64"</c>, <c>type="double|null"</c>,
/// <c>type="decimal(18,2)|null"</c> on a named <c>&lt;data&gt;</c>.
/// </summary>
/// <remarks>
/// <para>
/// Every text output is a string, which means whoever reads the file has to guess all over again
/// which column is a number and which only looks like one — and guesses wrong, turning <c>007</c>
/// into <c>7</c>. A declared type says it once, in the config, where the person who knows the answer
/// is already writing.
/// </para>
/// <para>
/// Only parsing lives here. What a type becomes on disk belongs to the writer, so a second format
/// could reuse this without inheriting Parquet's opinions.
/// </para>
/// </remarks>
public sealed class ColumnType
{
    /// <summary>The widest decimal an int64 can hold; 10^19 overflows a signed 64-bit integer.</summary>
    private const int MaxDecimalPrecision = 18;

    private static readonly Regex Head =
        new(@"^([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?$", RegexOptions.Compiled);

    private ColumnType(
        ColumnKind kind, bool nullable, int precision, int scale, ColumnType? element)
    {
        Kind = kind;
        Nullable = nullable;
        Precision = precision;
        Scale = scale;
        Element = element;
    }

    public ColumnKind Kind { get; }

    /// <summary><c>|null</c> — the column may hold a real NULL rather than an empty string.</summary>
    public bool Nullable { get; }

    /// <summary>decimal only: total digits.</summary>
    public int Precision { get; }

    /// <summary>decimal only: digits after the point.</summary>
    public int Scale { get; }

    /// <summary>A list's element type, or <c>null</c> when this is not a list.</summary>
    public ColumnType? Element { get; }

    public bool IsList => Kind == ColumnKind.List;

    /// <summary>
    /// Parse a <c>type="…"</c> that may be a list.
    /// </summary>
    /// <remarks>
    /// In <c>[]int64|null</c> the <c>|null</c> binds to the ELEMENT — read left to right, "a list of
    /// (int64 or nothing)". That is what <c>missing=</c> on a repeating generator needs: it blanks
    /// individual elements, never the list itself. There is no nullable list, because an empty cell
    /// is an empty list and there is no way to say "no list at all".
    /// </remarks>
    public static ColumnType ParseOutput(string raw)
    {
        string text = raw.Trim();
        if (!text.StartsWith("[]", StringComparison.Ordinal))
        {
            return Parse(text);
        }

        string inner = text[2..].Trim();
        if (inner.Length == 0)
        {
            throw new ArgumentException("list type needs an element type, e.g. []int64");
        }

        if (inner.StartsWith("[]", StringComparison.Ordinal))
        {
            throw new ArgumentException($"nested lists are not supported, got \"{text}\"");
        }

        return new ColumnType(ColumnKind.List, false, 0, 0, Parse(inner));
    }

    /// <summary>Parse a scalar <c>type="…"</c>. Throws with a message meant for whoever wrote it.</summary>
    public static ColumnType Parse(string raw)
    {
        string[] segments = raw.Split('|');
        string head = segments[0].Trim();
        if (head.Length == 0)
        {
            throw new ArgumentException("column type must not be empty");
        }

        bool nullable = false;
        foreach (string segment in segments.Skip(1))
        {
            if (segment.Trim().ToLowerInvariant() == "null")
            {
                nullable = true;
            }
            else
            {
                throw new ArgumentException(
                    $"unknown type modifier \"{segment.Trim()}\" (only \"null\" is supported)");
            }
        }

        Match match = Head.Match(head);
        ColumnKind? kind = match.Success ? KindOf(match.Groups[1].Value) : null;
        if (kind is null or ColumnKind.List)
        {
            throw new ArgumentException($"unknown column type \"{head}\"");
        }

        string? parameters = match.Groups[2].Success ? match.Groups[2].Value : null;

        if (kind != ColumnKind.Decimal)
        {
            if (parameters is not null)
            {
                throw new ArgumentException($"only decimal takes parameters, got \"{head}\"");
            }

            return new ColumnType(kind.Value, nullable, 0, 0, null);
        }

        if (parameters is null)
        {
            throw new ArgumentException("decimal requires (precision,scale), e.g. decimal(18,2)");
        }

        string[] parts = parameters.Split(',');
        if (parts.Length != 2)
        {
            throw new ArgumentException($"decimal requires (precision,scale), got \"{head}\"");
        }

        int precision = IntegerOr(parts[0].Trim(), int.MinValue);
        int scale = IntegerOr(parts[1].Trim(), int.MinValue);
        if (precision < 1 || precision > MaxDecimalPrecision)
        {
            throw new ArgumentException(
                $"decimal precision must be an integer 1..{MaxDecimalPrecision}, "
                + $"got \"{parts[0].Trim()}\"");
        }

        if (scale < 0 || scale > precision)
        {
            throw new ArgumentException(
                $"decimal scale must be an integer 0..precision ({precision}), "
                + $"got \"{parts[1].Trim()}\"");
        }

        return new ColumnType(ColumnKind.Decimal, nullable, precision, scale, null);
    }

    private static ColumnKind? KindOf(string name) =>
        Enum.TryParse(name, ignoreCase: true, out ColumnKind kind) ? kind : null;

    private static int IntegerOr(string raw, int fallback) =>
        int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? value
            : fallback;
}
