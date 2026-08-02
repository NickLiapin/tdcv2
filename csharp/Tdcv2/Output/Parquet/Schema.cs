namespace Tdcv2.Output.Parquet;

/// <summary>
/// Our column types mapped onto Parquet's two layers: a PHYSICAL type that carries the bytes, plus
/// an optional LOGICAL annotation saying how to read them.
/// </summary>
/// <remarks>
/// That split is why extra types are cheap — a date is an int32 wearing a label, and a UUID is
/// sixteen bytes wearing another. Both the modern logical type and the legacy converted type are
/// written, because readers in the wild still consult either one.
/// </remarks>
public static class Schema
{
    /// <summary>parquet.thrift <c>Type</c>.</summary>
    public const int Boolean = 0;

    public const int Int32 = 1;
    public const int Int64 = 2;
    public const int Int96 = 3;
    public const int Float = 4;
    public const int Double = 5;
    public const int ByteArray = 6;
    public const int FixedLenByteArray = 7;

    /// <summary>parquet.thrift <c>FieldRepetitionType</c>.</summary>
    public const int Required = 0;

    public const int Optional = 1;
    public const int Repeated = 2;

    /// <summary>parquet.thrift <c>Encoding</c>.</summary>
    public const int PlainEncoding = 0;

    public const int RleEncoding = 3;

    /// <summary>Dictionary INDICES on a data page; the dictionary page itself is PLAIN.</summary>
    public const int RleDictionary = 8;

    /// <summary>parquet.thrift <c>CompressionCodec</c>.</summary>
    public const int Uncompressed = 0;

    public const int SnappyCodec = 1;

    /// <summary>parquet.thrift <c>PageType</c>.</summary>
    public const int DataPage = 0;

    public const int DictionaryPage = 2;

    /// <summary>parquet.thrift <c>ConvertedType</c> — the legacy annotation.</summary>
    public const int CtUtf8 = 0;

    public const int CtList = 3;
    public const int CtEnum = 4;
    public const int CtDecimal = 5;
    public const int CtDate = 6;
    public const int CtTimestampMillis = 9;
    public const int CtUint8 = 11;
    public const int CtUint16 = 12;
    public const int CtUint32 = 13;
    public const int CtUint64 = 14;
    public const int CtJson = 19;

    /// <summary>Field id of the variant inside parquet.thrift's <c>LogicalType</c> union.</summary>
    public const int LtString = 1;

    /// <summary>
    /// Three in the LogicalType union. ConvertedType.LIST is also three, but the two enums are
    /// unrelated — four here would mean ENUM.
    /// </summary>
    public const int LtList = 3;

    public const int LtEnum = 4;
    public const int LtDecimal = 5;
    public const int LtDate = 6;
    public const int LtTimestamp = 8;
    public const int LtInteger = 10;
    public const int LtJson = 12;
    public const int LtUuid = 14;
    public const int LtFloat16 = 15;

    /// <summary>Nothing here has a sensible zero, so absence is spelled out.</summary>
    public const int None = -1;

    /// <summary>How one declared type becomes bytes on disk, and what tells a reader to trust them.</summary>
    public readonly record struct Mapping(
        int Physical, int TypeLength, int ConvertedType, int LogicalField, int Precision,
        int Scale, int BitWidth, bool Signed);

    /// <summary>Physical type plus annotation for a declared column type.</summary>
    public static Mapping Map(ColumnType type) => type.Kind switch
    {
        ColumnKind.Bool => Simple(Boolean),
        ColumnKind.Int32 => Simple(Int32),
        ColumnKind.Int64 => Simple(Int64),
        // Unsigned integers ride in the same signed physical slot; the annotation is the only thing
        // stopping a reader from calling a large value negative.
        ColumnKind.UInt8 => Unsigned(8, Int32, CtUint8),
        ColumnKind.UInt16 => Unsigned(16, Int32, CtUint16),
        ColumnKind.UInt32 => Unsigned(32, Int32, CtUint32),
        ColumnKind.UInt64 => Unsigned(64, Int64, CtUint64),
        ColumnKind.Float => Simple(Float),
        ColumnKind.Float16 => new Mapping(FixedLenByteArray, 2, None, LtFloat16, 0, 0, 0, true),
        ColumnKind.Double => Simple(Double),
        ColumnKind.Enum => new Mapping(ByteArray, 0, CtEnum, LtEnum, 0, 0, 0, true),
        ColumnKind.String => new Mapping(ByteArray, 0, CtUtf8, LtString, 0, 0, 0, true),
        ColumnKind.Json => new Mapping(ByteArray, 0, CtJson, LtJson, 0, 0, 0, true),
        ColumnKind.Date => new Mapping(Int32, 0, CtDate, LtDate, 0, 0, 0, true),
        ColumnKind.Timestamp =>
            new Mapping(Int64, 0, CtTimestampMillis, LtTimestamp, 0, 0, 0, true),
        ColumnKind.Decimal =>
            new Mapping(Int64, 0, CtDecimal, LtDecimal, type.Precision, type.Scale, 0, true),
        ColumnKind.Uuid => new Mapping(FixedLenByteArray, 16, None, LtUuid, 0, 0, 0, true),
        _ => throw new ArgumentException($"no Parquet mapping for {type.Kind}"),
    };

    private static Mapping Simple(int physical) =>
        new(physical, 0, None, None, 0, 0, 0, true);

    private static Mapping Unsigned(int bitWidth, int physical, int convertedType) =>
        new(physical, 0, convertedType, LtInteger, 0, 0, bitWidth, false);
}
