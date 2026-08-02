using System.Text;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// Thrift's compact protocol, write side only.
/// </summary>
/// <remarks>
/// Parquet keeps its page headers and its entire footer in this encoding, so a file cannot be
/// produced without it. Small and completely specified — and unforgiving: one wrong byte and no
/// reader will open the file, with nothing to say about which byte. That is why it lives on its own
/// and is checked against known bytes.
/// </remarks>
public sealed class Thrift
{
    /// <summary>Compact type ids. A boolean carries its value in the field header rather than after it.</summary>
    public const int BooleanTrue = 1;

    public const int BooleanFalse = 2;
    public const int Byte = 3;
    public const int I16Type = 4;
    public const int I32Type = 5;
    public const int I64Type = 6;
    public const int DoubleType = 7;
    public const int Binary = 8;
    public const int ListType = 9;
    public const int SetType = 10;
    public const int MapType = 11;
    public const int StructType = 12;

    private readonly MemoryStream _out = new();

    /// <summary>Field ids are written as a delta from the previous field of the same struct.</summary>
    private int _lastFieldId;

    private readonly Stack<int> _stack = new();

    public byte[] Bytes() => _out.ToArray();

    /// <summary>How many bytes so far — what page and footer offsets are filled in from.</summary>
    public int Length => (int)_out.Length;

    /// <summary>Unsigned LEB128: seven bits per byte, the top bit meaning "more follows".</summary>
    public static byte[] Varint(long value)
    {
        if (value < 0)
        {
            throw new ArgumentException("varint must be non-negative");
        }

        var buffer = new List<byte>();
        ulong v = (ulong)value;
        do
        {
            int b = (int)(v & 0x7f);
            v >>= 7;
            if (v > 0)
            {
                b |= 0x80;
            }

            buffer.Add((byte)b);
        }
        while (v > 0);

        return buffer.ToArray();
    }

    /// <summary>Fold a signed 32-bit value onto an unsigned one so small magnitudes stay short.</summary>
    public static long Zigzag32(int value) => (long)(uint)((value << 1) ^ (value >> 31));

    public static long Zigzag64(long value) => (value << 1) ^ (value >> 63);

    private void Raw(int b) => _out.WriteByte((byte)(b & 0xff));

    private void RawBytes(byte[] bytes) => _out.Write(bytes, 0, bytes.Length);

    public void StructBegin()
    {
        _stack.Push(_lastFieldId);
        _lastFieldId = 0;
    }

    public void StructEnd()
    {
        Raw(0x00); // struct stop
        _lastFieldId = _stack.Count == 0 ? 0 : _stack.Pop();
    }

    /// <summary>A field header: the short form when the id delta fits in four bits, the long form otherwise.</summary>
    public void FieldBegin(int id, int type)
    {
        int delta = id - _lastFieldId;
        if (delta > 0 && delta <= 15)
        {
            Raw((delta << 4) | type);
        }
        else
        {
            Raw(type);
            RawBytes(Varint(Zigzag32(id)));
        }

        _lastFieldId = id;
    }

    /// <summary>A boolean has no value bytes: true and false are two different field types.</summary>
    public void Bool(int id, bool value) =>
        FieldBegin(id, value ? BooleanTrue : BooleanFalse);

    /// <summary>
    /// Thrift's <c>i8</c> — one raw byte, NOT zigzagged the way i16/i32/i64 are.
    /// </summary>
    /// <remarks>
    /// <c>LogicalType.IntType.bitWidth</c> is declared i8, and writing it as an i32 would shift every
    /// field after it by a byte.
    /// </remarks>
    public void I8(int id, int value)
    {
        FieldBegin(id, Byte);
        Raw(value);
    }

    public void I32(int id, int value)
    {
        FieldBegin(id, I32Type);
        RawBytes(Varint(Zigzag32(value)));
    }

    public void I64(int id, long value)
    {
        FieldBegin(id, I64Type);
        RawBytes(Varint(Zigzag64(value)));
    }

    public void BinaryField(int id, byte[] value)
    {
        FieldBegin(id, Binary);
        RawBytes(Varint(value.Length));
        RawBytes(value);
    }

    public void String(int id, string value) =>
        BinaryField(id, Encoding.UTF8.GetBytes(value));

    /// <summary>
    /// Open a list field. Its elements follow with the <c>List*</c> writers and carry no field
    /// headers of their own; a list of structs uses <see cref="StructBegin"/> and
    /// <see cref="StructEnd"/>.
    /// </summary>
    public void ListBegin(int id, int elementType, int size)
    {
        FieldBegin(id, ListType);
        if (size < 15)
        {
            Raw((size << 4) | elementType);
        }
        else
        {
            Raw((0x0f << 4) | elementType);
            RawBytes(Varint(size));
        }
    }

    public void ListI32(int value) => RawBytes(Varint(Zigzag32(value)));

    public void ListI64(long value) => RawBytes(Varint(Zigzag64(value)));

    public void ListString(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        RawBytes(Varint(bytes.Length));
        RawBytes(bytes);
    }
}
