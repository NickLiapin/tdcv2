using System.Text;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// A Parquet file, assembled from typed columns.
/// </summary>
/// <remarks>
/// <para>
/// The layout: the four magic bytes, then a page per column per row group, then the whole metadata
/// footer in Thrift's compact protocol, its length, and the magic again. Rows go out in ROW GROUPS —
/// a batch is built, written and released before the next one starts — so peak memory is one group
/// however many records the file holds.
/// </para>
/// <para>
/// Every choice this writer makes is a function of the data alone. No clock, no library version, no
/// sampling: the same config and seed produce the same bytes here as in every other implementation,
/// which is a promise a Parquet writer can only keep by owning its own encoder.
/// </para>
/// </remarks>
public static class Writer
{
    /// <summary>Fixed so the bytes never depend on a version, a clock, or which language wrote them.</summary>
    private const string CreatedBy = "TDC";

    private static readonly byte[] Magic = { 0x50, 0x41, 0x52, 0x31 }; // "PAR1"

    /// <summary>A column's identity: everything the schema needs, without the data.</summary>
    public sealed record Column(string Name, ColumnType Type);

    /// <summary>
    /// One cell.
    /// </summary>
    /// <remarks>
    /// A scalar column holds a converted value; a list column holds the row's raw element texts,
    /// because which elements are NULL has to be decided — in the definition levels — before anything
    /// is converted.
    /// </remarks>
    public abstract record Cell
    {
        public sealed record Scalar(Convert.Value? Value) : Cell;

        public sealed record Elements(IReadOnlyList<string> Texts) : Cell;
    }

    /// <summary>What the footer needs to know about one column chunk.</summary>
    public sealed record ChunkMeta(
        long Offset, long DataOffset, long DictionaryOffset, long TotalSize, long RawSize,
        int Codec, long NumValues, Statistics.Result Stats)
    {
        internal bool HasDictionary => DictionaryOffset >= 0;
    }

    /// <summary>One row group's chunks and how many records they cover.</summary>
    public sealed record GroupMeta(IReadOnlyList<ChunkMeta> Chunks, int NumRows);

    // ── writing a whole file ─────────────────────────────────────────────────────────────────

    /// <summary>A source of row groups: each call fills one batch, or reports that there are no more.</summary>
    public delegate IReadOnlyList<IReadOnlyList<Cell>>? Batches();

    /// <summary>
    /// Write the whole file to a sink, one row group at a time.
    /// </summary>
    /// <remarks>
    /// Only the small per-group metadata is kept as it goes, because the footer has to be written
    /// last and has to know where every page landed.
    /// </remarks>
    public static void Write(IReadOnlyList<Column> columns, Batches batches, Stream output)
    {
        output.Write(Magic, 0, Magic.Length);
        long offset = Magic.Length;
        var groups = new List<GroupMeta>();
        long numRows = 0;

        while (batches() is { } batch)
        {
            Block? block = BuildBlock(columns, batch);
            if (block is null)
            {
                continue;
            }

            foreach (byte[] page in block.Pages)
            {
                output.Write(page, 0, page.Length);
            }

            groups.Add(new GroupMeta(Shift(block.Chunks, offset), block.NumRows));
            offset += block.ByteLength;
            numRows += block.NumRows;
        }

        byte[] footer = Footer(columns, groups, numRows);
        output.Write(footer, 0, footer.Length);
    }

    /// <summary>The whole file in memory — convenient for a small output, and for tests.</summary>
    public static byte[] ToBytes(IReadOnlyList<Column> columns, Batches batches)
    {
        var output = new MemoryStream();
        Write(columns, batches, output);
        return output.ToArray();
    }

    /// <summary>
    /// One row group, encoded and ready to be placed anywhere in a file.
    /// </summary>
    /// <remarks>
    /// This is the unit that makes parallel writing possible: a group's bytes do not depend on where
    /// it sits, because page headers carry their own sizes and the only offsets in the whole format
    /// live in the footer. Its chunk offsets are relative to the start of the block, and the caller
    /// shifts them once it knows where the block landed.
    /// </remarks>
    private sealed record Block(
        IReadOnlyList<byte[]> Pages, IReadOnlyList<ChunkMeta> Chunks, int NumRows, long ByteLength);

    private static Block? BuildBlock(
        IReadOnlyList<Column> columns, IReadOnlyList<IReadOnlyList<Cell>> batch)
    {
        int rowsInGroup = batch.Count == 0 ? 0 : batch[0].Count;
        if (rowsInGroup == 0)
        {
            return null;
        }

        var pages = new List<byte[]>();
        var chunks = new List<ChunkMeta>();
        long at = 0;

        for (int i = 0; i < columns.Count; i++)
        {
            Page page = PageBody(columns[i], batch[i]);

            // The codec is declared per column chunk, so the choice is made once for the whole chunk
            // — and only taken when it actually saves bytes. Snappy adds framing, which on an
            // already tiny dictionary page makes the "compressed" form the larger one.
            byte[] squeezedData = Snappy.Compress(page.Body);
            byte[]? squeezedDict =
                page.DictionaryBody is null ? null : Snappy.Compress(page.DictionaryBody);
            int rawTotal = page.Body.Length + (page.DictionaryBody?.Length ?? 0);
            int squeezedTotal = squeezedData.Length + (squeezedDict?.Length ?? 0);
            bool compress = squeezedTotal < rawTotal;

            byte[] dataBody = compress ? squeezedData : page.Body;
            byte[]? dictPayload = compress ? squeezedDict : page.DictionaryBody;
            byte[]? dictPage = page.DictionaryBody is null
                ? null
                : Concat(
                    DictionaryPageHeader(
                        page.DictionaryBody.Length, dictPayload!.Length, page.DictionaryCount),
                    dictPayload);

            byte[] header =
                PageHeader(page.Body.Length, dataBody.Length, page.NumValues, page.Encoding);
            int dictSize = dictPage?.Length ?? 0;
            long written = (long)dictSize + header.Length + dataBody.Length;
            chunks.Add(new ChunkMeta(
                at,
                at + dictSize,
                dictPage is null ? -1 : at,
                written,
                (long)dictSize + header.Length + page.Body.Length,
                compress ? Schema.SnappyCodec : Schema.Uncompressed,
                page.NumValues,
                page.Stats!));

            if (dictPage is not null)
            {
                pages.Add(dictPage);
            }

            pages.Add(header);
            pages.Add(dataBody);
            at += written;
        }

        return new Block(pages, chunks, rowsInGroup, at);
    }

    private static List<ChunkMeta> Shift(IReadOnlyList<ChunkMeta> chunks, long by) =>
        chunks.Select(c => c with
        {
            Offset = c.Offset + by,
            DataOffset = c.DataOffset + by,
            DictionaryOffset = c.HasDictionary ? c.DictionaryOffset + by : -1,
        }).ToList();

    // ── a page ───────────────────────────────────────────────────────────────────────────────

    /// <summary>A page's bytes, plus everything the headers and the footer need to describe it.</summary>
    private sealed class Page
    {
        internal byte[] Body = Array.Empty<byte>();
        internal int NumValues;
        internal Statistics.Result? Stats;
        internal byte[]? DictionaryBody;
        internal int DictionaryCount;
        internal int Encoding;
    }

    /// <summary>
    /// The page body and the number of LEVEL SLOTS it describes.
    /// </summary>
    /// <remarks>
    /// A scalar column is the values, preceded by definition levels when it is nullable — one slot
    /// per row. A list column is repetition levels, then definition levels, then the values —
    /// repetition first, as the format mandates — and its slot count is the number of elements, an
    /// empty list still costing one.
    /// </remarks>
    private static Page PageBody(Column column, IReadOnlyList<Cell> cells)
    {
        var page = new Page();

        if (!column.Type.IsList)
        {
            var present = new List<Convert.Value?>();
            foreach (Cell cell in cells)
            {
                if (((Cell.Scalar)cell).Value is { } value)
                {
                    present.Add(value);
                }
            }

            ValueSection section = BuildValueSection(column.Type, present);
            page.NumValues = cells.Count;
            page.Stats = Statistics.Compute(column.Type, present, cells.Count - present.Count);
            page.Encoding = section.Encoding;
            page.DictionaryBody = section.DictionaryBody;
            page.DictionaryCount = section.DictionaryCount;

            if (!column.Type.Nullable)
            {
                page.Body = section.Values;
                return page;
            }

            var def = new int[cells.Count];
            for (int i = 0; i < cells.Count; i++)
            {
                def[i] = ((Cell.Scalar)cells[i]).Value is null ? 0 : 1;
            }

            page.Body = Concat(LevelBlock(def, 1), section.Values);
            return page;
        }

        ColumnType element = column.Type.Element!;
        var rows = cells.Select(cell => ((Cell.Elements)cell).Texts).ToList();
        ListLevels.Built levels = ListLevels.Build(rows, element.Nullable);

        var elementValues = new List<Convert.Value?>();
        foreach (string text in levels.Present)
        {
            if (Convert.Of(text, element) is { } value)
            {
                elementValues.Add(value);
            }
        }

        ValueSection listSection = BuildValueSection(element, elementValues);

        page.Body = Concat(
            LevelBlock(levels.RepLevels, levels.MaxRep),
            LevelBlock(levels.DefLevels, levels.MaxDef),
            listSection.Values);
        page.NumValues = levels.RepLevels.Length;
        // For a list, a "null" is any level slot that did not reach the leaf — an absent element, or
        // an empty list.
        page.Stats = Statistics.Compute(
            element, elementValues, levels.RepLevels.Length - elementValues.Count);
        page.Encoding = listSection.Encoding;
        page.DictionaryBody = listSection.DictionaryBody;
        page.DictionaryCount = listSection.DictionaryCount;
        return page;
    }

    private sealed class ValueSection
    {
        internal byte[] Values = Array.Empty<byte>();
        internal byte[]? DictionaryBody;
        internal int DictionaryCount;
        internal int Encoding;
    }

    /// <summary>
    /// A chunk's values: PLAIN, or — when the data repeats enough to pay for it — a dictionary page
    /// plus RLE-packed indices into it.
    /// </summary>
    private static ValueSection BuildValueSection(
        ColumnType type, IReadOnlyList<Convert.Value?> present)
    {
        var result = new ValueSection();
        Dictionary.Built? dictionary = Dictionary.Build(type, present);
        if (dictionary is null)
        {
            result.Values = EncodeValues(type, present);
            result.Encoding = Schema.PlainEncoding;
            return result;
        }

        result.DictionaryBody = EncodeValues(type, dictionary.Values);
        result.DictionaryCount = dictionary.Values.Count;
        result.Values = Rle.DictionaryIndices(
            dictionary.Indices, Rle.DictionaryBitWidth(dictionary.Values.Count));
        result.Encoding = Schema.RleDictionary;
        return result;
    }

    private static byte[] EncodeValues(ColumnType type, IReadOnlyList<Convert.Value?> present)
    {
        switch (type.Kind)
        {
            case ColumnKind.Bool:
                return Plain.Booleans(present.Select(v => ((Convert.Value.Bool)v!).V).ToList());
            case ColumnKind.Int32:
            case ColumnKind.Date:
            case ColumnKind.UInt8:
            case ColumnKind.UInt16:
            case ColumnKind.UInt32:
                return Plain.Int32(present.Select(v => ((Convert.Value.Int)v!).V).ToList());
            case ColumnKind.Int64:
            case ColumnKind.Timestamp:
            case ColumnKind.Decimal:
            case ColumnKind.UInt64:
                return Plain.Int64(present.Select(v => ((Convert.Value.Long)v!).V).ToList());
            case ColumnKind.Float:
                return Plain.Floats(Doubles(present));
            case ColumnKind.Float16:
                return Plain.Float16(Doubles(present));
            case ColumnKind.Double:
                return Plain.Doubles(Doubles(present));
            case ColumnKind.String:
            case ColumnKind.Enum:
            case ColumnKind.Json:
                return Plain.ByteArray(present.Select(v => ((Convert.Value.Text)v!).V).ToList());
            case ColumnKind.Uuid:
                return Plain.Fixed(present.Select(v => ((Convert.Value.Bytes)v!).V).ToList());
            default:
                throw new ArgumentException($"cannot encode {type.Kind}");
        }
    }

    private static List<double> Doubles(IReadOnlyList<Convert.Value?> present) =>
        present.Select(v => ((Convert.Value.Double)v!).V).ToList();

    /// <summary>A length-prefixed level block, as the page body expects it.</summary>
    private static byte[] LevelBlock(int[] levels, int maxLevel)
    {
        byte[] rle = Rle.Levels(levels, ListLevels.BitWidth(maxLevel));
        var result = new byte[4 + rle.Length];
        result[0] = (byte)(rle.Length & 0xff);
        result[1] = (byte)((rle.Length >> 8) & 0xff);
        result[2] = (byte)((rle.Length >> 16) & 0xff);
        result[3] = (byte)((rle.Length >> 24) & 0xff);
        Array.Copy(rle, 0, result, 4, rle.Length);
        return result;
    }

    // ── headers and footer ───────────────────────────────────────────────────────────────────

    private static byte[] PageHeader(int rawSize, int compressedSize, int numValues, int encoding)
    {
        var w = new Thrift();
        w.StructBegin();
        w.I32(1, Schema.DataPage);
        w.I32(2, rawSize); // uncompressed_page_size
        w.I32(3, compressedSize); // compressed_page_size
        w.FieldBegin(5, Thrift.StructType); // data_page_header
        w.StructBegin();
        w.I32(1, numValues);
        w.I32(2, encoding); // PLAIN, or RLE_DICTIONARY when indices follow
        w.I32(3, Schema.RleEncoding); // definition levels
        w.I32(4, Schema.RleEncoding); // repetition levels, unused for a flat column
        w.StructEnd();
        w.StructEnd();
        return w.Bytes();
    }

    /// <summary>
    /// The dictionary page's header. Its own encoding is PLAIN — the modern pairing with an
    /// RLE_DICTIONARY data page. The legacy pairing put PLAIN_DICTIONARY on both, which recent
    /// readers still accept but no longer produce.
    /// </summary>
    private static byte[] DictionaryPageHeader(int rawSize, int compressedSize, int numValues)
    {
        var w = new Thrift();
        w.StructBegin();
        w.I32(1, Schema.DictionaryPage);
        w.I32(2, rawSize);
        w.I32(3, compressedSize);
        w.FieldBegin(7, Thrift.StructType); // dictionary_page_header
        w.StructBegin();
        w.I32(1, numValues);
        w.I32(2, Schema.PlainEncoding);
        w.StructEnd();
        w.StructEnd();
        return w.Bytes();
    }

    /// <summary><c>column_orders</c> — the field that makes the statistics USABLE.</summary>
    /// <remarks>
    /// The spec is explicit: a reader must ignore <c>min_value</c>/<c>max_value</c> unless
    /// <c>FileMetaData.column_orders</c> says the sort order is TypeDefinedOrder. Without it the
    /// bounds are there in the bytes and no conforming reader may act on them, so every row
    /// group is decoded in full — which is exactly what the statistics exist to avoid. The
    /// values were correct; nothing was allowed to read them.
    /// <para>
    /// One entry per LEAF column, in schema order — the same order the row groups list their
    /// chunks in, which is one per column (a list column contributes three schema elements but
    /// still exactly one leaf). <c>ColumnOrder</c> is a union whose only member,
    /// <c>TYPE_ORDER</c>, holds an EMPTY struct, so each entry is three bytes.
    /// </para>
    /// </remarks>
    private static void WriteColumnOrders(Thrift w, int leaves)
    {
        w.ListBegin(7, Thrift.StructType, leaves);
        for (int i = 0; i < leaves; i++)
        {
            w.StructBegin(); // ColumnOrder
            w.FieldBegin(1, Thrift.StructType); // TYPE_ORDER
            w.StructBegin(); // TypeDefinedOrder {}
            w.StructEnd();
            w.StructEnd();
        }
    }

    /// <summary>The footer: schema, row-group directory, then the trailing length and magic.</summary>
    public static byte[] Footer(
        IReadOnlyList<Column> columns, IReadOnlyList<GroupMeta> groups, long numRows)
    {
        var w = new Thrift();
        w.StructBegin();
        w.I32(1, 1); // version
        WriteSchema(w, columns);
        w.I64(3, numRows);
        WriteRowGroups(w, columns, groups);
        w.String(6, CreatedBy);
        WriteColumnOrders(w, columns.Count);
        w.StructEnd();
        byte[] bytes = w.Bytes();

        var length = new byte[4];
        length[0] = (byte)(bytes.Length & 0xff);
        length[1] = (byte)((bytes.Length >> 8) & 0xff);
        length[2] = (byte)((bytes.Length >> 16) & 0xff);
        length[3] = (byte)((bytes.Length >> 24) & 0xff);
        return Concat(bytes, length, Magic);
    }

    /// <summary>The LogicalType union — exactly one variant field is set.</summary>
    private static void WriteLogicalType(Thrift w, Schema.Mapping map)
    {
        if (map.LogicalField == Schema.None)
        {
            return;
        }

        w.FieldBegin(10, Thrift.StructType);
        w.StructBegin();
        w.FieldBegin(map.LogicalField, Thrift.StructType);
        w.StructBegin();
        if (map.LogicalField == Schema.LtDecimal)
        {
            w.I32(1, map.Scale);
            w.I32(2, map.Precision);
        }
        else if (map.LogicalField == Schema.LtInteger)
        {
            w.I8(1, map.BitWidth);
            w.Bool(2, map.Signed);
        }
        else if (map.LogicalField == Schema.LtTimestamp)
        {
            w.Bool(1, true); // isAdjustedToUTC
            w.FieldBegin(2, Thrift.StructType); // TimeUnit union
            w.StructBegin();
            w.FieldBegin(1, Thrift.StructType); // MILLIS
            w.StructBegin();
            w.StructEnd();
            w.StructEnd();
        }

        w.StructEnd();
        w.StructEnd();
    }

    private static void WriteSchema(Thrift w, IReadOnlyList<Column> columns)
    {
        // The root plus every SchemaElement — a list contributes three, not one.
        int elements = columns.Sum(column => column.Type.IsList ? 3 : 1);
        w.ListBegin(2, Thrift.StructType, elements + 1);

        // The root element: a name and the child count, nothing else.
        w.StructBegin();
        w.String(4, "schema");
        w.I32(5, columns.Count);
        w.StructEnd();

        foreach (Column column in columns)
        {
            if (column.Type.IsList)
            {
                WriteListSchema(w, column.Name, column.Type.Element!);
                continue;
            }

            Schema.Mapping map = Schema.Map(column.Type);
            w.StructBegin();
            w.I32(1, map.Physical);
            if (map.TypeLength > 0)
            {
                w.I32(2, map.TypeLength);
            }

            w.I32(3, column.Type.Nullable ? Schema.Optional : Schema.Required);
            w.String(4, column.Name);
            if (map.ConvertedType != Schema.None)
            {
                w.I32(6, map.ConvertedType);
            }

            if (map.LogicalField == Schema.LtDecimal)
            {
                w.I32(7, map.Scale);
                w.I32(8, map.Precision);
            }

            WriteLogicalType(w, map);
            w.StructEnd();
        }
    }

    /// <summary>
    /// The three-element LIST wrapper.
    /// </summary>
    /// <remarks>
    /// The names <c>list</c> and <c>element</c> are fixed by the format rather than chosen here;
    /// readers match on the annotated shape.
    /// </remarks>
    private static void WriteListSchema(Thrift w, string name, ColumnType element)
    {
        w.StructBegin();
        w.I32(3, Schema.Required);
        w.String(4, name);
        w.I32(5, 1); // num_children
        w.I32(6, Schema.CtList);
        w.FieldBegin(10, Thrift.StructType); // logicalType
        w.StructBegin();
        w.FieldBegin(Schema.LtList, Thrift.StructType);
        w.StructBegin();
        w.StructEnd();
        w.StructEnd();
        w.StructEnd();

        w.StructBegin();
        w.I32(3, Schema.Repeated);
        w.String(4, "list");
        w.I32(5, 1); // num_children
        w.StructEnd();

        Schema.Mapping map = Schema.Map(element);
        w.StructBegin();
        w.I32(1, map.Physical);
        if (map.TypeLength > 0)
        {
            w.I32(2, map.TypeLength);
        }

        w.I32(3, element.Nullable ? Schema.Optional : Schema.Required);
        w.String(4, "element");
        if (map.ConvertedType != Schema.None)
        {
            w.I32(6, map.ConvertedType);
        }

        if (map.LogicalField == Schema.LtDecimal)
        {
            w.I32(7, map.Scale);
            w.I32(8, map.Precision);
        }

        WriteLogicalType(w, map);
        w.StructEnd();
    }

    /// <summary>
    /// parquet.thrift's <c>Statistics</c>, field 12 of ColumnMetaData.
    /// </summary>
    /// <remarks>
    /// Only the null count and the min/max VALUE fields — never the deprecated min/max, whose
    /// signedness readers historically disagreed about. A bound a reader may misinterpret is as
    /// dangerous as a bound that is simply wrong.
    /// </remarks>
    private static void WriteStatistics(Thrift w, Statistics.Result stats)
    {
        w.FieldBegin(12, Thrift.StructType);
        w.StructBegin();
        w.I64(3, stats.NullCount);
        if (stats.MaxValue is not null)
        {
            w.BinaryField(5, stats.MaxValue);
        }

        if (stats.MinValue is not null)
        {
            w.BinaryField(6, stats.MinValue);
        }

        w.StructEnd();
    }

    private static void WriteRowGroups(
        Thrift w, IReadOnlyList<Column> columns, IReadOnlyList<GroupMeta> groups)
    {
        w.ListBegin(4, Thrift.StructType, groups.Count);
        foreach (GroupMeta group in groups)
        {
            w.StructBegin();
            w.ListBegin(1, Thrift.StructType, columns.Count); // columns
            long totalByteSize = 0;
            for (int i = 0; i < columns.Count; i++)
            {
                Column column = columns[i];
                ChunkMeta chunk = group.Chunks[i];
                totalByteSize += chunk.TotalSize;
                bool listed = column.Type.IsList;
                Schema.Mapping map = Schema.Map(listed ? column.Type.Element! : column.Type);

                w.StructBegin();
                w.I64(2, chunk.Offset); // file_offset — the dictionary page when there is one
                w.FieldBegin(3, Thrift.StructType); // meta_data
                w.StructBegin();
                w.I32(1, map.Physical);
                // PLAIN always appears: it is how the dictionary page itself is written, and how the
                // values are written when there is no dictionary. A list always carries levels, so
                // RLE is always among its encodings too.
                var encodings = new List<int> { Schema.PlainEncoding };
                if (listed || column.Type.Nullable)
                {
                    encodings.Add(Schema.RleEncoding);
                }

                if (chunk.HasDictionary)
                {
                    encodings.Add(Schema.RleDictionary);
                }

                w.ListBegin(2, Thrift.I32Type, encodings.Count);
                foreach (int e in encodings)
                {
                    w.ListI32(e);
                }

                // The chunk addresses the LEAF, so a list's path walks through its wrapper.
                string[] path = listed
                    ? new[] { column.Name, "list", "element" }
                    : new[] { column.Name };
                w.ListBegin(3, Thrift.Binary, path.Length); // path_in_schema
                foreach (string segment in path)
                {
                    w.ListString(segment);
                }

                w.I32(4, chunk.Codec);
                w.I64(5, chunk.NumValues);
                w.I64(6, chunk.RawSize); // total_uncompressed_size
                w.I64(7, chunk.TotalSize); // total_compressed_size
                w.I64(9, chunk.DataOffset); // data_page_offset
                // Field 11 must be written between 9 and 12: the compact protocol encodes field ids
                // as ascending deltas, so writing it out of order would corrupt every field after it.
                if (chunk.HasDictionary)
                {
                    w.I64(11, chunk.DictionaryOffset);
                }

                WriteStatistics(w, chunk.Stats);
                w.StructEnd();
                w.StructEnd();
            }

            w.I64(2, totalByteSize); // total_byte_size
            w.I64(3, group.NumRows);
            w.StructEnd();
        }
    }

    private static byte[] Concat(params byte[][] parts)
    {
        var result = new byte[parts.Sum(p => p.Length)];
        int at = 0;
        foreach (byte[] part in parts)
        {
            Array.Copy(part, 0, result, at, part.Length);
            at += part.Length;
        }

        return result;
    }
}
