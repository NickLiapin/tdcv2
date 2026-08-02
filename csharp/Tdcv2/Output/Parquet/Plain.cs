using System.Text;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// PLAIN encoding — the simplest Parquet value layout: values back to back, little-endian, with no
/// dictionary and no compression of their own.
/// </summary>
/// <remarks>
/// Correct and portable, which is what a first version should be. Denser encodings can be added
/// later without changing anything a reader accepts.
/// </remarks>
public static class Plain
{
    public static byte[] Int32(IReadOnlyList<int> values)
    {
        var result = new byte[values.Count * 4];
        for (int i = 0; i < values.Count; i++)
        {
            BitConverter.TryWriteBytes(result.AsSpan(i * 4), values[i]);
        }

        return LittleEndian(result, 4);
    }

    public static byte[] Int64(IReadOnlyList<long> values)
    {
        var result = new byte[values.Count * 8];
        for (int i = 0; i < values.Count; i++)
        {
            BitConverter.TryWriteBytes(result.AsSpan(i * 8), values[i]);
        }

        return LittleEndian(result, 8);
    }

    public static byte[] Doubles(IReadOnlyList<double> values)
    {
        var result = new byte[values.Count * 8];
        for (int i = 0; i < values.Count; i++)
        {
            BitConverter.TryWriteBytes(result.AsSpan(i * 8), values[i]);
        }

        return LittleEndian(result, 8);
    }

    public static byte[] Floats(IReadOnlyList<double> values)
    {
        var result = new byte[values.Count * 4];
        for (int i = 0; i < values.Count; i++)
        {
            BitConverter.TryWriteBytes(result.AsSpan(i * 4), (float)values[i]);
        }

        return LittleEndian(result, 4);
    }

    /// <summary>Each value is a four-byte little-endian length followed by its bytes.</summary>
    public static byte[] ByteArray(IReadOnlyList<string> values)
    {
        var result = new MemoryStream();
        foreach (string value in values)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            result.WriteByte((byte)(bytes.Length & 0xff));
            result.WriteByte((byte)((bytes.Length >> 8) & 0xff));
            result.WriteByte((byte)((bytes.Length >> 16) & 0xff));
            result.WriteByte((byte)((bytes.Length >> 24) & 0xff));
            result.Write(bytes, 0, bytes.Length);
        }

        return result.ToArray();
    }

    /// <summary>Fixed-width values — a sixteen-byte UUID, say — carry no length prefix.</summary>
    public static byte[] Fixed(IReadOnlyList<byte[]> values)
    {
        var result = new MemoryStream();
        foreach (byte[] value in values)
        {
            result.Write(value, 0, value.Length);
        }

        return result.ToArray();
    }

    /// <summary>Booleans are bit-packed, least significant bit first.</summary>
    public static byte[] Booleans(IReadOnlyList<bool> values)
    {
        var result = new byte[(values.Count + 7) / 8];
        for (int i = 0; i < values.Count; i++)
        {
            if (values[i])
            {
                result[i >> 3] |= (byte)(1 << (i & 7));
            }
        }

        return result;
    }

    public static byte[] Float16(IReadOnlyList<double> values)
    {
        var result = new byte[values.Count * 2];
        for (int i = 0; i < values.Count; i++)
        {
            int bits = HalfBits(values[i]);
            result[i * 2] = (byte)(bits & 0xff);
            result[(i * 2) + 1] = (byte)((bits >> 8) & 0xff);
        }

        return result;
    }

    /// <summary>
    /// IEEE-754 half precision as sixteen bits.
    /// </summary>
    /// <remarks>
    /// Parquet has no physical type for it — a FLOAT16 lives in a two-byte fixed array — so the bits
    /// are assembled by hand. Rounding is half-to-even, matching every other implementation: a
    /// different rule would put different bytes in the file for the same input, which is exactly what
    /// a cross-language guarantee forbids.
    /// </remarks>
    public static int HalfBits(double value)
    {
        int x = BitConverter.SingleToInt32Bits((float)value);

        int sign = ((int)((uint)x >> 31) & 1) << 15;
        int exponent = (int)((uint)x >> 23) & 0xff;
        int mantissa = x & 0x7fffff;

        // Infinity keeps a zero mantissa; a NaN must keep a non-zero one, or it would arrive as
        // infinity on the other side.
        if (exponent == 0xff)
        {
            return sign | 0x7c00 | (mantissa == 0 ? 0 : 0x0200);
        }

        int unbiased = exponent - 127;
        if (unbiased > 15)
        {
            return sign | 0x7c00; // beyond half's range
        }

        if (unbiased >= -14)
        {
            // Normal: drop thirteen of the twenty-three mantissa bits, rounding half to even.
            int keep = (int)((uint)mantissa >> 13);
            if (RoundsUp(mantissa & 0x1fff, 0x1000, keep))
            {
                keep++;
            }

            int half = unbiased + 15;
            if (keep == 0x400)
            {
                keep = 0; // the mantissa carried into the exponent
                half++;
            }

            return half >= 0x1f ? sign | 0x7c00 : sign | (half << 10) | keep;
        }

        if (unbiased < -25)
        {
            return sign; // smaller than any subnormal, so a signed zero
        }

        // Subnormal: restore the implicit leading one, then shift it down to fit.
        int full = mantissa | 0x800000;
        int shift = -unbiased - 1;
        int keepSub = (int)((uint)full >> shift);
        if (RoundsUp(full & ((1 << shift) - 1), 1 << (shift - 1), keepSub))
        {
            keepSub++;
        }

        return sign | keepSub;
    }

    /// <summary>
    /// Round half to even, the IEEE-754 default.
    /// </summary>
    /// <remarks>
    /// The simpler round-half-up is the version most often copied around, and it disagrees on exact
    /// ties: 2049 becomes 2050 rather than 2048. Ties are common in generated data, so the wrong rule
    /// here would quietly put different bytes in the file than every other Parquet writer produces.
    /// </remarks>
    private static bool RoundsUp(int dropped, int halfPoint, int keep) =>
        dropped > halfPoint || (dropped == halfPoint && (keep & 1) == 1);

    /// <summary>Half-precision bits back to a number.</summary>
    public static double HalfToDouble(int bits)
    {
        double sign = (bits & 0x8000) != 0 ? -1 : 1;
        int exponent = (bits >> 10) & 0x1f;
        int mantissa = bits & 0x03ff;
        if (exponent == 0)
        {
            return sign * Math.Pow(2, -14) * (mantissa / 1024.0);
        }

        if (exponent == 0x1f)
        {
            return mantissa == 0 ? sign * double.PositiveInfinity : double.NaN;
        }

        return sign * Math.Pow(2, exponent - 15) * (1 + (mantissa / 1024.0));
    }

    /// <summary>
    /// The file is little-endian wherever it runs.
    /// </summary>
    /// <remarks>
    /// .NET runs on big-endian hardware too, and BitConverter follows the machine. A Parquet file
    /// written on one would be unreadable everywhere else, so the bytes are reversed per value
    /// rather than trusted.
    /// </remarks>
    private static byte[] LittleEndian(byte[] buffer, int width)
    {
        if (BitConverter.IsLittleEndian)
        {
            return buffer;
        }

        for (int i = 0; i < buffer.Length; i += width)
        {
            Array.Reverse(buffer, i, width);
        }

        return buffer;
    }
}
