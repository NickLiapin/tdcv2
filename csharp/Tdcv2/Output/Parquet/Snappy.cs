namespace Tdcv2.Output.Parquet;

/// <summary>
/// Snappy compression, written here rather than taken from a library.
/// </summary>
/// <remarks>
/// <para>
/// Two reasons, and the second is the real one. First, no runtime dependency — the whole writer
/// exists to avoid one. Second, two different Snappy implementations may emit different, both valid,
/// output for the same input, because the format leaves match-finding entirely to the encoder. This
/// project promises that its implementations produce byte-identical files, and that promise survives
/// only if all of them run the same matcher. This one does, by construction.
/// </para>
/// <para>
/// The format: a varint holding the uncompressed length, then a stream of elements. An element is
/// either a literal (bytes copied out as they are) or a copy (go back this far and take this many).
/// The tag byte's low two bits say which, and copies come in sizes depending on how far back they
/// reach.
/// </para>
/// <para>
/// The matcher is a plain hash table over four-byte sequences. Not the strongest possible — Snappy
/// permits any encoder whose output decodes back to the input — but fast, allocation-light and,
/// above all, exactly reproducible.
/// </para>
/// </remarks>
public static class Snappy
{
    /// <summary>Table size: larger finds more matches and costs more memory. Fixed so every port agrees.</summary>
    private const int HashBits = 14;

    private const int HashSize = 1 << HashBits;

    /// <summary>A copy can reach back at most this far.</summary>
    private const int MaxOffset = 1 << 16;

    /// <summary>One copy element carries at most this many bytes; a longer match emits several.</summary>
    private const int MaxCopyLength = 64;

    /// <summary>Below this, a match is not worth a copy element.</summary>
    private const int MinMatch = 4;

    /// <summary>Compress. The result always decodes back to the input exactly.</summary>
    public static byte[] Compress(byte[] input)
    {
        var result = new MemoryStream();
        Varint(result, input.Length);
        int size = input.Length;
        if (size == 0)
        {
            return result.ToArray();
        }

        var table = new int[HashSize];
        Array.Fill(table, -1);
        int literalStart = 0;
        int at = 0;

        while (at + MinMatch <= size)
        {
            // Multiply-shift hash; the constant is Snappy's own, kept so the table behaves the same
            // way in every implementation. Unchecked because the multiply is meant to overflow.
            int slot;
            unchecked
            {
                slot = (int)((uint)(ReadUint32(input, at) * 0x1e35a7bd) >> (32 - HashBits));
            }

            int candidate = table[slot];
            table[slot] = at;

            bool near = candidate >= 0 && at - candidate < MaxOffset;
            if (!near || ReadUint32(input, candidate) != ReadUint32(input, at))
            {
                at++;
                continue;
            }

            Literal(result, input, literalStart, at - literalStart);

            // Extend the match as far as it goes, emitting several copies when it is long.
            int matched = MinMatch;
            while (at + matched < size && input[candidate + matched] == input[at + matched])
            {
                matched++;
            }

            int offset = at - candidate;
            int remaining = matched;
            while (remaining > 0)
            {
                int piece = Math.Min(remaining, MaxCopyLength);
                Copy(result, offset, piece);
                remaining -= piece;
            }

            at += matched;
            literalStart = at;
        }

        Literal(result, input, literalStart, size - literalStart);
        return result.ToArray();
    }

    private static int ReadUint32(byte[] input, int at)
    {
        int b0 = at < input.Length ? input[at] : 0;
        int b1 = at + 1 < input.Length ? input[at + 1] : 0;
        int b2 = at + 2 < input.Length ? input[at + 2] : 0;
        int b3 = at + 3 < input.Length ? input[at + 3] : 0;
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }

    private static void Varint(MemoryStream output, int value)
    {
        uint rest = (uint)value;
        while (rest >= 0x80)
        {
            output.WriteByte((byte)((rest & 0x7f) | 0x80));
            rest >>= 7;
        }

        output.WriteByte((byte)rest);
    }

    /// <summary>A literal run: the tag, an optional extended length, then the bytes.</summary>
    private static void Literal(MemoryStream output, byte[] input, int start, int length)
    {
        if (length <= 0)
        {
            return;
        }

        int n = length - 1;
        if (n < 60)
        {
            output.WriteByte((byte)(n << 2));
        }
        else
        {
            // 60..63 in the tag mean "one to four length bytes follow", little-endian.
            int width = 0;
            uint rest = (uint)n;
            while (rest > 0)
            {
                width++;
                rest >>= 8;
            }

            output.WriteByte((byte)((59 + width) << 2));
            rest = (uint)n;
            for (int i = 0; i < width; i++)
            {
                output.WriteByte((byte)(rest & 0xff));
                rest >>= 8;
            }
        }

        output.Write(input, start, length);
    }

    /// <summary>
    /// A copy element.
    /// </summary>
    /// <remarks>
    /// The one-byte-offset form is smaller but reaches only 2047 bytes back and carries four to
    /// eleven bytes; everything else uses the two-byte form.
    /// </remarks>
    private static void Copy(MemoryStream output, int offset, int length)
    {
        if (length is >= MinMatch and <= 11 && offset < 2048)
        {
            output.WriteByte(
                (byte)(0x01 | ((length - MinMatch) << 2) | ((offset >> 8) << 5)));
            output.WriteByte((byte)(offset & 0xff));
            return;
        }

        output.WriteByte((byte)(0x02 | ((length - 1) << 2)));
        output.WriteByte((byte)(offset & 0xff));
        output.WriteByte((byte)((offset >> 8) & 0xff));
    }
}
