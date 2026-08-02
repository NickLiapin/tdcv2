namespace Tdcv2.Output.Parquet;

/// <summary>
/// The RLE / bit-packed hybrid, which dictionary indices and level streams both ride on.
/// </summary>
/// <remarks>
/// <para>
/// Two shapes share one stream, told apart by the low bit of a varint header. An RLE run is
/// <c>varint(count &lt;&lt; 1)</c> followed by the repeated value; a bit-packed run is
/// <c>varint((groups &lt;&lt; 1) | 1)</c> followed by groups of eight values packed at the given bit
/// width, least significant bit first.
/// </para>
/// <para>
/// Which shape is used matters more than it sounds. A categorical column — "Moscow", "Paris",
/// "Berlin" — is shuffled across rows, so consecutive repeats are rare and an RLE-only encoder
/// spends about two bytes per value, barely better than the text it replaced. Bit-packing spends
/// bits: two per value for three categories, a sixteen-fold difference on the same data. So packing
/// is the default and RLE is kept for the genuinely constant case.
/// </para>
/// </remarks>
public static class Rle
{
    /// <summary>Bits needed to address <paramref name="count"/> distinct entries; one for a single entry.</summary>
    public static int DictionaryBitWidth(int count)
    {
        if (count <= 1)
        {
            return count == 0 ? 0 : 1;
        }

        int bits = 0;
        while ((1 << bits) < count)
        {
            bits++;
        }

        return bits;
    }

    /// <summary>
    /// Dictionary indices for a data page.
    /// </summary>
    /// <remarks>
    /// The result begins with one byte holding the bit width. That byte belongs to the page body
    /// rather than to the hybrid stream, and a reader expects it in exactly that place.
    /// </remarks>
    public static byte[] DictionaryIndices(int[] indices, int bitWidth)
    {
        var result = new MemoryStream();
        result.WriteByte((byte)bitWidth);
        if (indices.Length > 0)
        {
            int first = indices[0];
            bool constant = indices.All(index => index == first);
            // A column holding one value all the way down collapses to a few bytes; anything else
            // packs, because shuffled categories have no runs worth exploiting.
            byte[] body = constant
                ? RleRun(first, indices.Length, bitWidth)
                : BitPacked(indices, bitWidth);
            result.Write(body, 0, body.Length);
        }

        return result.ToArray();
    }

    /// <summary>
    /// A level stream, RLE-encoded.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Definition levels say how deep a value actually exists — for a flat column, 1 present and 0
    /// for NULL; for a list, also an empty list and a null element. Repetition levels say where a
    /// new record starts (0) and where a list continues (1). Both are the same encoding, so one
    /// function serves both.
    /// </para>
    /// <para>
    /// Only RLE runs are emitted, one per stretch of equal levels. Valid, simple, and compact in
    /// practice: real data is long runs of "present".
    /// </para>
    /// </remarks>
    public static byte[] Levels(int[] values, int bitWidth)
    {
        if (values.Length == 0)
        {
            return Array.Empty<byte>();
        }

        int valueBytes = (bitWidth + 7) / 8;
        var result = new MemoryStream();

        int runStart = 0;
        while (runStart < values.Length)
        {
            int value = values[runStart];
            int runEnd = runStart + 1;
            while (runEnd < values.Length && values[runEnd] == value)
            {
                runEnd++;
            }

            byte[] header = Thrift.Varint((long)(runEnd - runStart) << 1);
            result.Write(header, 0, header.Length);
            uint v = (uint)value;
            for (int i = 0; i < valueBytes; i++)
            {
                result.WriteByte((byte)(v & 0xff));
                v >>= 8;
            }

            runStart = runEnd;
        }

        return result.ToArray();
    }

    /// <summary>One RLE run: the same value repeated.</summary>
    private static byte[] RleRun(int value, int count, int bitWidth)
    {
        var result = new MemoryStream();
        byte[] header = Thrift.Varint((long)count << 1);
        result.Write(header, 0, header.Length);
        int byteCount = (bitWidth + 7) / 8;
        uint rest = (uint)value;
        for (int i = 0; i < byteCount; i++)
        {
            result.WriteByte((byte)(rest & 0xff));
            rest >>= 8;
        }

        return result.ToArray();
    }

    /// <summary>One bit-packed run covering every value, zero-padded to a multiple of eight.</summary>
    private static byte[] BitPacked(int[] values, int bitWidth)
    {
        int groups = (values.Length + 7) / 8;
        var result = new MemoryStream();
        byte[] header = Thrift.Varint(((long)groups << 1) | 1);
        result.Write(header, 0, header.Length);

        ulong acc = 0;
        int bits = 0;
        int padded = groups * 8;
        for (int i = 0; i < padded; i++)
        {
            ulong value = i < values.Length ? (uint)values[i] : 0;
            acc |= value << bits;
            bits += bitWidth;
            while (bits >= 8)
            {
                result.WriteByte((byte)(acc & 0xff));
                acc >>= 8;
                bits -= 8;
            }
        }

        if (bits > 0)
        {
            result.WriteByte((byte)(acc & 0xff));
        }

        return result.ToArray();
    }
}
