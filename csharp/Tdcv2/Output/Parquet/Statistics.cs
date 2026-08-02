using System.Text;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// The min, the max and the NULL count of a column chunk.
/// </summary>
/// <remarks>
/// <para>
/// This is what lets a reader skip a whole row group: asked for <c>price &gt; 500</c>, it reads the
/// chunk's maximum and moves on without decoding a byte. Cheap to produce — every value is already
/// in hand — and a large win for whoever queries the file.
/// </para>
/// <para>
/// The danger runs the other way from most features: wrong statistics are worse than none. A maximum
/// that is too low makes a reader skip a group that did contain matching rows, and the query returns
/// fewer results with no error and no warning. So the comparisons here follow Parquet's declared sort
/// orders rather than the language's defaults — byte arrays compare as unsigned UTF-8 bytes, NaN
/// never takes part in a bound, and the unsigned kinds are compared unsigned even though they are
/// stored in signed slots.
/// </para>
/// <para>
/// Only <c>min_value</c>/<c>max_value</c> are written, never the deprecated <c>min</c>/<c>max</c>:
/// the old pair had ambiguous signedness that readers disagreed about, and writing a field readers
/// may misread is the same trap as writing a wrong bound.
/// </para>
/// </remarks>
public static class Statistics
{
    /// <summary>PLAIN-encoded bounds; <c>null</c> when the chunk holds no non-NULL value at all.</summary>
    public sealed record Result(byte[]? MinValue, byte[]? MaxValue, int NullCount);

    /// <summary>
    /// Min, max and NULL count for one column chunk.
    /// </summary>
    /// <remarks>
    /// <paramref name="nullCount"/> is supplied by the caller because for a list column the NULLs
    /// live in the definition levels rather than among the values.
    /// </remarks>
    public static Result Compute(
        ColumnType type, IReadOnlyList<Convert.Value?> present, int nullCount)
    {
        Convert.Value? min = null;
        Convert.Value? max = null;

        foreach (Convert.Value? value in present)
        {
            if (value is null || Unusable(type, value))
            {
                continue;
            }

            if (min is null || Compare(type, value, min) < 0)
            {
                min = value;
            }

            if (max is null || Compare(type, value, max) > 0)
            {
                max = value;
            }
        }

        return min is null
            ? new Result(null, null, nullCount)
            : new Result(EncodeOne(type, min), EncodeOne(type, max!), nullCount);
    }

    /// <summary>Unsigned byte-wise comparison — Parquet's sort order for a byte array.</summary>
    public static int CompareBytes(byte[] a, byte[] b)
    {
        int shared = Math.Min(a.Length, b.Length);
        for (int i = 0; i < shared; i++)
        {
            if (a[i] != b[i])
            {
                return a[i] < b[i] ? -1 : 1;
            }
        }

        return a.Length.CompareTo(b.Length);
    }

    /// <summary>PLAIN encoding of ONE value, as statistics store it — no length prefix.</summary>
    private static byte[] EncodeOne(ColumnType type, Convert.Value value) => type.Kind switch
    {
        ColumnKind.Bool => new[] { (byte)(((Convert.Value.Bool)value).V ? 1 : 0) },
        ColumnKind.Int32 or ColumnKind.Date or ColumnKind.UInt8 or ColumnKind.UInt16
            or ColumnKind.UInt32 => Plain.Int32(new[] { ((Convert.Value.Int)value).V }),
        ColumnKind.Float => Plain.Floats(new[] { ((Convert.Value.Double)value).V }),
        ColumnKind.Float16 => Plain.Float16(new[] { ((Convert.Value.Double)value).V }),
        ColumnKind.Int64 or ColumnKind.Timestamp or ColumnKind.Decimal or ColumnKind.UInt64 =>
            Plain.Int64(new[] { ((Convert.Value.Long)value).V }),
        ColumnKind.Double => Plain.Doubles(new[] { ((Convert.Value.Double)value).V }),
        ColumnKind.String or ColumnKind.Enum or ColumnKind.Json =>
            Encoding.UTF8.GetBytes(((Convert.Value.Text)value).V),
        ColumnKind.Uuid => ((Convert.Value.Bytes)value).V,
        _ => Array.Empty<byte>(),
    };

    /// <summary>Order two present values of this column type, following Parquet's rules for it.</summary>
    private static int Compare(ColumnType type, Convert.Value a, Convert.Value b)
    {
        switch (type.Kind)
        {
            case ColumnKind.Bool:
                return ((Convert.Value.Bool)a).V.CompareTo(((Convert.Value.Bool)b).V);
            case ColumnKind.Int32:
            case ColumnKind.Date:
            // The small unsigned kinds keep their true value in the signed slot.
            case ColumnKind.UInt8:
            case ColumnKind.UInt16:
                return ((Convert.Value.Int)a).V.CompareTo(((Convert.Value.Int)b).V);
            case ColumnKind.Float:
            case ColumnKind.Float16:
            case ColumnKind.Double:
            {
                double x = ((Convert.Value.Double)a).V;
                double y = ((Convert.Value.Double)b).V;
                return double.IsNaN(x) || double.IsNaN(y) ? 0 : x.CompareTo(y);
            }

            case ColumnKind.UInt32:
                // Stored as wrapped signed bits, so compared unsigned — otherwise a value above
                // 2^31 would look smaller than one, and the bound would exclude real rows.
                return ((uint)((Convert.Value.Int)a).V).CompareTo((uint)((Convert.Value.Int)b).V);
            case ColumnKind.UInt64:
                return ((ulong)((Convert.Value.Long)a).V).CompareTo(
                    (ulong)((Convert.Value.Long)b).V);
            case ColumnKind.Int64:
            case ColumnKind.Timestamp:
            case ColumnKind.Decimal:
                return ((Convert.Value.Long)a).V.CompareTo(((Convert.Value.Long)b).V);
            case ColumnKind.String:
            case ColumnKind.Enum:
            case ColumnKind.Json:
                return CompareBytes(
                    Encoding.UTF8.GetBytes(((Convert.Value.Text)a).V),
                    Encoding.UTF8.GetBytes(((Convert.Value.Text)b).V));
            case ColumnKind.Uuid:
                return CompareBytes(((Convert.Value.Bytes)a).V, ((Convert.Value.Bytes)b).V);
            default:
                return 0;
        }
    }

    /// <summary>A value that cannot take part in a bound. NaN only, for now.</summary>
    private static bool Unusable(ColumnType type, Convert.Value value) =>
        type.Kind is ColumnKind.Double or ColumnKind.Float or ColumnKind.Float16
        && double.IsNaN(((Convert.Value.Double)value).V);
}
