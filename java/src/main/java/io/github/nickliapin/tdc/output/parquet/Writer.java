package io.github.nickliapin.tdc.output.parquet;

import io.github.nickliapin.tdc.output.ColumnType;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * A Parquet file, assembled from typed columns.
 *
 * <p>The layout: the four magic bytes, then a page per column per row group, then the whole
 * metadata footer in Thrift's compact protocol, its length, and the magic again. Rows go out in
 * ROW GROUPS — a batch is built, written and released before the next one starts — so peak memory
 * is one group however many records the file holds.
 *
 * <p>Every choice this writer makes is a function of the data alone. No clock, no library
 * version, no sampling: the same config and seed produce the same bytes here as in every other
 * implementation, which is a promise a Parquet writer can only keep by owning its own encoder.
 */
public final class Writer {

  /** Fixed so the bytes never depend on a version, a clock, or which language wrote them. */
  private static final String CREATED_BY = "TDC";

  private static final byte[] MAGIC = {0x50, 0x41, 0x52, 0x31}; // "PAR1"

  /** A column's identity: everything the schema needs, without the data. */
  public record Column(String name, ColumnType type) {}

  /**
   * One cell.
   *
   * <p>A scalar column holds a converted value; a list column holds the row's raw element texts,
   * because which elements are NULL has to be decided — in the definition levels — before
   * anything is converted.
   */
  public sealed interface Cell permits Scalar, Elements {}

  public record Scalar(Convert.Value value) implements Cell {}

  public record Elements(List<String> texts) implements Cell {}

  /** What the footer needs to know about one column chunk. */
  public record ChunkMeta(
      long offset,
      long dataOffset,
      long dictionaryOffset,
      long totalSize,
      long rawSize,
      int codec,
      long numValues,
      Statistics.Result statistics) {

    boolean hasDictionary() {
      return dictionaryOffset >= 0;
    }
  }

  /** One row group's chunks and how many records they cover. */
  public record GroupMeta(List<ChunkMeta> chunks, int numRows) {}

  private Writer() {}

  // ── writing a whole file ─────────────────────────────────────────────────────────────────

  /** A source of row groups: each call fills one batch, or reports that there are no more. */
  public interface Batches {
    /** The next batch as {@code batch[columnIndex][row]}, or {@code null} when finished. */
    List<List<Cell>> next();
  }

  /**
   * Write the whole file to a sink, one row group at a time.
   *
   * <p>Only the small per-group metadata is kept as it goes, because the footer has to be written
   * last and has to know where every page landed.
   */
  public static void write(List<Column> columns, Batches batches, java.io.OutputStream out) {
    try {
      out.write(MAGIC);
      long offset = MAGIC.length;
      List<GroupMeta> groups = new ArrayList<>();
      long numRows = 0;

      List<List<Cell>> batch;
      while ((batch = batches.next()) != null) {
        Block block = block(columns, batch);
        if (block == null) {
          continue;
        }
        for (byte[] page : block.pages) {
          out.write(page);
        }
        groups.add(new GroupMeta(shift(block.chunks, offset), block.numRows));
        offset += block.byteLength;
        numRows += block.numRows;
      }

      out.write(footer(columns, groups, numRows));
    } catch (IOException e) {
      throw new UncheckedIOException("cannot write the Parquet file", e);
    }
  }

  /** The whole file in memory — convenient for a small output, and for tests. */
  public static byte[] toBytes(List<Column> columns, Batches batches) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    write(columns, batches, out);
    return out.toByteArray();
  }

  /**
   * One row group, encoded and ready to be placed anywhere in a file.
   *
   * <p>This is the unit that makes parallel writing possible: a group's bytes do not depend on
   * where it sits, because page headers carry their own sizes and the only offsets in the whole
   * format live in the footer. Its chunk offsets are relative to the start of the block, and the
   * caller shifts them once it knows where the block landed.
   */
  private record Block(List<byte[]> pages, List<ChunkMeta> chunks, int numRows, long byteLength) {}

  private static Block block(List<Column> columns, List<List<Cell>> batch) {
    int rowsInGroup = batch.isEmpty() ? 0 : batch.get(0).size();
    if (rowsInGroup == 0) {
      return null;
    }

    List<byte[]> pages = new ArrayList<>();
    List<ChunkMeta> chunks = new ArrayList<>();
    long at = 0;

    for (int i = 0; i < columns.size(); i++) {
      Column column = columns.get(i);
      Page page = pageBody(column, batch.get(i));

      // The codec is declared per column chunk, so the choice is made once for the whole chunk —
      // and only taken when it actually saves bytes. Snappy adds framing, which on an already
      // tiny dictionary page makes the "compressed" form the larger one.
      byte[] squeezedData = Snappy.compress(page.body);
      byte[] squeezedDict = page.dictionaryBody == null ? null : Snappy.compress(page.dictionaryBody);
      int rawTotal = page.body.length + (page.dictionaryBody == null ? 0 : page.dictionaryBody.length);
      int squeezedTotal = squeezedData.length + (squeezedDict == null ? 0 : squeezedDict.length);
      boolean compress = squeezedTotal < rawTotal;

      byte[] dataBody = compress ? squeezedData : page.body;
      byte[] dictPayload = compress ? squeezedDict : page.dictionaryBody;
      byte[] dictPage =
          page.dictionaryBody == null
              ? null
              : concat(
                  dictionaryPageHeader(
                      page.dictionaryBody.length, dictPayload.length, page.dictionaryCount),
                  dictPayload);

      byte[] header = pageHeader(page.body.length, dataBody.length, page.numValues, page.encoding);
      int dictSize = dictPage == null ? 0 : dictPage.length;
      long written = (long) dictSize + header.length + dataBody.length;
      chunks.add(
          new ChunkMeta(
              at,
              at + dictSize,
              dictPage == null ? -1 : at,
              written,
              (long) dictSize + header.length + page.body.length,
              compress ? Schema.SNAPPY : Schema.UNCOMPRESSED,
              page.numValues,
              page.statistics));
      if (dictPage != null) {
        pages.add(dictPage);
      }
      pages.add(header);
      pages.add(dataBody);
      at += written;
    }

    return new Block(pages, chunks, rowsInGroup, at);
  }

  private static List<ChunkMeta> shift(List<ChunkMeta> chunks, long by) {
    List<ChunkMeta> out = new ArrayList<>(chunks.size());
    for (ChunkMeta c : chunks) {
      out.add(
          new ChunkMeta(
              c.offset() + by,
              c.dataOffset() + by,
              c.hasDictionary() ? c.dictionaryOffset() + by : -1,
              c.totalSize(),
              c.rawSize(),
              c.codec(),
              c.numValues(),
              c.statistics()));
    }
    return out;
  }

  // ── a page ───────────────────────────────────────────────────────────────────────────────

  /** A page's bytes, plus everything the headers and the footer need to describe it. */
  private static final class Page {
    byte[] body;
    int numValues;
    Statistics.Result statistics;
    byte[] dictionaryBody;
    int dictionaryCount;
    int encoding;
  }

  /**
   * The page body and the number of LEVEL SLOTS it describes.
   *
   * <p>A scalar column is the values, preceded by definition levels when it is nullable — one
   * slot per row. A list column is repetition levels, then definition levels, then the values —
   * repetition first, as the format mandates — and its slot count is the number of elements, an
   * empty list still costing one.
   */
  private static Page pageBody(Column column, List<Cell> cells) {
    Page page = new Page();

    if (!column.type().isList()) {
      List<Convert.Value> present = new ArrayList<>();
      for (Cell cell : cells) {
        Convert.Value value = ((Scalar) cell).value();
        if (value != null) {
          present.add(value);
        }
      }
      ValueSection section = valueSection(column.type(), present);
      page.numValues = cells.size();
      page.statistics = Statistics.compute(column.type(), present, cells.size() - present.size());
      page.encoding = section.encoding;
      page.dictionaryBody = section.dictionaryBody;
      page.dictionaryCount = section.dictionaryCount;

      if (!column.type().nullable()) {
        page.body = section.values;
        return page;
      }
      int[] def = new int[cells.size()];
      for (int i = 0; i < cells.size(); i++) {
        def[i] = ((Scalar) cells.get(i)).value() == null ? 0 : 1;
      }
      page.body = concat(levelBlock(def, 1), section.values);
      return page;
    }

    ColumnType element = column.type().element();
    List<List<String>> rows = new ArrayList<>(cells.size());
    for (Cell cell : cells) {
      rows.add(((Elements) cell).texts());
    }
    ListLevels.Built levels = ListLevels.build(rows, element.nullable());

    List<Convert.Value> present = new ArrayList<>();
    for (String text : levels.present()) {
      Convert.Value value = Convert.value(text, element);
      if (value != null) {
        present.add(value);
      }
    }
    ValueSection section = valueSection(element, present);

    page.body =
        concat(
            levelBlock(levels.repLevels(), levels.maxRep()),
            levelBlock(levels.defLevels(), levels.maxDef()),
            section.values);
    page.numValues = levels.repLevels().length;
    // For a list, a "null" is any level slot that did not reach the leaf — an absent element, or
    // an empty list.
    page.statistics =
        Statistics.compute(element, present, levels.repLevels().length - present.size());
    page.encoding = section.encoding;
    page.dictionaryBody = section.dictionaryBody;
    page.dictionaryCount = section.dictionaryCount;
    return page;
  }

  private static final class ValueSection {
    byte[] values;
    byte[] dictionaryBody;
    int dictionaryCount;
    int encoding;
  }

  /**
   * A chunk's values: PLAIN, or — when the data repeats enough to pay for it — a dictionary page
   * plus RLE-packed indices into it.
   */
  private static ValueSection valueSection(ColumnType type, List<Convert.Value> present) {
    ValueSection out = new ValueSection();
    Dictionary.Built dictionary = Dictionary.build(type, present);
    if (dictionary == null) {
      out.values = encodeValues(type, present);
      out.encoding = Schema.PLAIN;
      return out;
    }
    out.dictionaryBody = encodeValues(type, dictionary.values());
    out.dictionaryCount = dictionary.values().size();
    out.values =
        Rle.dictionaryIndices(dictionary.indices(), Rle.dictionaryBitWidth(dictionary.values().size()));
    out.encoding = Schema.RLE_DICTIONARY;
    return out;
  }

  private static byte[] encodeValues(ColumnType type, List<Convert.Value> present) {
    switch (type.kind()) {
      case BOOL: {
        List<Boolean> values = new ArrayList<>(present.size());
        for (Convert.Value v : present) {
          values.add(((Convert.BoolValue) v).value());
        }
        return Plain.booleans(values);
      }
      case INT32:
      case DATE:
      case UINT8:
      case UINT16:
      case UINT32: {
        List<Integer> values = new ArrayList<>(present.size());
        for (Convert.Value v : present) {
          values.add(((Convert.IntValue) v).value());
        }
        return Plain.int32(values);
      }
      case INT64:
      case TIMESTAMP:
      case DECIMAL:
      case UINT64: {
        List<Long> values = new ArrayList<>(present.size());
        for (Convert.Value v : present) {
          values.add(((Convert.LongValue) v).value());
        }
        return Plain.int64(values);
      }
      case FLOAT: {
        return Plain.floats(doubles(present));
      }
      case FLOAT16: {
        return Plain.float16(doubles(present));
      }
      case DOUBLE: {
        return Plain.doubles(doubles(present));
      }
      case STRING:
      case ENUM:
      case JSON: {
        List<String> values = new ArrayList<>(present.size());
        for (Convert.Value v : present) {
          values.add(((Convert.TextValue) v).value());
        }
        return Plain.byteArray(values);
      }
      case UUID: {
        List<byte[]> values = new ArrayList<>(present.size());
        for (Convert.Value v : present) {
          values.add(((Convert.BytesValue) v).value());
        }
        return Plain.fixed(values);
      }
      default:
        throw new IllegalArgumentException("cannot encode " + type);
    }
  }

  private static List<Double> doubles(List<Convert.Value> present) {
    List<Double> values = new ArrayList<>(present.size());
    for (Convert.Value v : present) {
      values.add(((Convert.DoubleValue) v).value());
    }
    return values;
  }

  /** A length-prefixed level block, as the page body expects it. */
  private static byte[] levelBlock(int[] levels, int maxLevel) {
    byte[] rle = Rle.levels(levels, ListLevels.bitWidth(maxLevel));
    ByteBuffer buffer = ByteBuffer.allocate(4 + rle.length).order(ByteOrder.LITTLE_ENDIAN);
    buffer.putInt(rle.length);
    buffer.put(rle);
    return buffer.array();
  }

  // ── headers and footer ───────────────────────────────────────────────────────────────────

  private static byte[] pageHeader(int rawSize, int compressedSize, int numValues, int encoding) {
    Thrift w = new Thrift();
    w.structBegin();
    w.i32(1, Schema.DATA_PAGE);
    w.i32(2, rawSize); // uncompressed_page_size
    w.i32(3, compressedSize); // compressed_page_size
    w.fieldBegin(5, Thrift.STRUCT); // data_page_header
    w.structBegin();
    w.i32(1, numValues);
    w.i32(2, encoding); // PLAIN, or RLE_DICTIONARY when indices follow
    w.i32(3, Schema.RLE); // definition levels
    w.i32(4, Schema.RLE); // repetition levels, unused for a flat column
    w.structEnd();
    w.structEnd();
    return w.bytes();
  }

  /**
   * The dictionary page's header. Its own encoding is PLAIN — the modern pairing with an
   * RLE_DICTIONARY data page. The legacy pairing put PLAIN_DICTIONARY on both, which recent
   * readers still accept but no longer produce.
   */
  private static byte[] dictionaryPageHeader(int rawSize, int compressedSize, int numValues) {
    Thrift w = new Thrift();
    w.structBegin();
    w.i32(1, Schema.DICTIONARY_PAGE);
    w.i32(2, rawSize);
    w.i32(3, compressedSize);
    w.fieldBegin(7, Thrift.STRUCT); // dictionary_page_header
    w.structBegin();
    w.i32(1, numValues);
    w.i32(2, Schema.PLAIN);
    w.structEnd();
    w.structEnd();
    return w.bytes();
  }

  /** The footer: schema, row-group directory, then the trailing length and magic. */
  public static byte[] footer(List<Column> columns, List<GroupMeta> groups, long numRows) {
    Thrift w = new Thrift();
    w.structBegin();
    w.i32(1, 1); // version
    writeSchema(w, columns);
    w.i64(3, numRows);
    writeRowGroups(w, columns, groups);
    w.string(6, CREATED_BY);
    w.structEnd();
    byte[] bytes = w.bytes();

    ByteBuffer length = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
    length.putInt(bytes.length);
    return concat(bytes, length.array(), MAGIC);
  }

  /** The LogicalType union — exactly one variant field is set. */
  private static void writeLogicalType(Thrift w, Schema.Mapping map) {
    if (map.logicalField() == Schema.NONE) {
      return;
    }
    w.fieldBegin(10, Thrift.STRUCT);
    w.structBegin();
    w.fieldBegin(map.logicalField(), Thrift.STRUCT);
    w.structBegin();
    if (map.logicalField() == Schema.LT_DECIMAL) {
      w.i32(1, map.scale());
      w.i32(2, map.precision());
    } else if (map.logicalField() == Schema.LT_INTEGER) {
      w.i8(1, map.bitWidth());
      w.bool(2, map.signed());
    } else if (map.logicalField() == Schema.LT_TIMESTAMP) {
      w.bool(1, true); // isAdjustedToUTC
      w.fieldBegin(2, Thrift.STRUCT); // TimeUnit union
      w.structBegin();
      w.fieldBegin(1, Thrift.STRUCT); // MILLIS
      w.structBegin();
      w.structEnd();
      w.structEnd();
    }
    w.structEnd();
    w.structEnd();
  }

  private static void writeSchema(Thrift w, List<Column> columns) {
    // The root plus every SchemaElement — a list contributes three, not one.
    int elements = 0;
    for (Column column : columns) {
      elements += column.type().isList() ? 3 : 1;
    }
    w.listBegin(2, Thrift.STRUCT, elements + 1);

    // The root element: a name and the child count, nothing else.
    w.structBegin();
    w.string(4, "schema");
    w.i32(5, columns.size());
    w.structEnd();

    for (Column column : columns) {
      if (column.type().isList()) {
        writeListSchema(w, column.name(), column.type().element());
        continue;
      }
      Schema.Mapping map = Schema.map(column.type());
      w.structBegin();
      w.i32(1, map.physical());
      if (map.typeLength() > 0) {
        w.i32(2, map.typeLength());
      }
      w.i32(3, column.type().nullable() ? Schema.OPTIONAL : Schema.REQUIRED);
      w.string(4, column.name());
      if (map.convertedType() != Schema.NONE) {
        w.i32(6, map.convertedType());
      }
      if (map.logicalField() == Schema.LT_DECIMAL) {
        w.i32(7, map.scale());
        w.i32(8, map.precision());
      }
      writeLogicalType(w, map);
      w.structEnd();
    }
  }

  /**
   * The three-element LIST wrapper.
   *
   * <p>The names {@code list} and {@code element} are fixed by the format rather than chosen
   * here; readers match on the annotated shape.
   */
  private static void writeListSchema(Thrift w, String name, ColumnType element) {
    w.structBegin();
    w.i32(3, Schema.REQUIRED);
    w.string(4, name);
    w.i32(5, 1); // num_children
    w.i32(6, Schema.CT_LIST);
    w.fieldBegin(10, Thrift.STRUCT); // logicalType
    w.structBegin();
    w.fieldBegin(Schema.LT_LIST, Thrift.STRUCT);
    w.structBegin();
    w.structEnd();
    w.structEnd();
    w.structEnd();

    w.structBegin();
    w.i32(3, Schema.REPEATED);
    w.string(4, "list");
    w.i32(5, 1); // num_children
    w.structEnd();

    Schema.Mapping map = Schema.map(element);
    w.structBegin();
    w.i32(1, map.physical());
    if (map.typeLength() > 0) {
      w.i32(2, map.typeLength());
    }
    w.i32(3, element.nullable() ? Schema.OPTIONAL : Schema.REQUIRED);
    w.string(4, "element");
    if (map.convertedType() != Schema.NONE) {
      w.i32(6, map.convertedType());
    }
    if (map.logicalField() == Schema.LT_DECIMAL) {
      w.i32(7, map.scale());
      w.i32(8, map.precision());
    }
    writeLogicalType(w, map);
    w.structEnd();
  }

  /**
   * parquet.thrift's {@code Statistics}, field 12 of ColumnMetaData.
   *
   * <p>Only the null count and the min/max VALUE fields — never the deprecated min/max, whose
   * signedness readers historically disagreed about. A bound a reader may misinterpret is as
   * dangerous as a bound that is simply wrong.
   */
  private static void writeStatistics(Thrift w, Statistics.Result stats) {
    w.fieldBegin(12, Thrift.STRUCT);
    w.structBegin();
    w.i64(3, stats.nullCount());
    if (stats.maxValue() != null) {
      w.binary(5, stats.maxValue());
    }
    if (stats.minValue() != null) {
      w.binary(6, stats.minValue());
    }
    w.structEnd();
  }

  private static void writeRowGroups(Thrift w, List<Column> columns, List<GroupMeta> groups) {
    w.listBegin(4, Thrift.STRUCT, groups.size());
    for (GroupMeta group : groups) {
      w.structBegin();
      w.listBegin(1, Thrift.STRUCT, columns.size()); // columns
      long totalByteSize = 0;
      for (int i = 0; i < columns.size(); i++) {
        Column column = columns.get(i);
        ChunkMeta chunk = group.chunks().get(i);
        totalByteSize += chunk.totalSize();
        boolean listed = column.type().isList();
        Schema.Mapping map = Schema.map(listed ? column.type().element() : column.type());

        w.structBegin();
        w.i64(2, chunk.offset()); // file_offset — the dictionary page when there is one
        w.fieldBegin(3, Thrift.STRUCT); // meta_data
        w.structBegin();
        w.i32(1, map.physical());
        // PLAIN always appears: it is how the dictionary page itself is written, and how the
        // values are written when there is no dictionary. A list always carries levels, so RLE
        // is always among its encodings too.
        List<Integer> encodings = new ArrayList<>();
        encodings.add(Schema.PLAIN);
        if (listed || column.type().nullable()) {
          encodings.add(Schema.RLE);
        }
        if (chunk.hasDictionary()) {
          encodings.add(Schema.RLE_DICTIONARY);
        }
        w.listBegin(2, Thrift.I32, encodings.size());
        for (int e : encodings) {
          w.listI32(e);
        }
        // The chunk addresses the LEAF, so a list's path walks through its wrapper.
        List<String> path =
            listed ? List.of(column.name(), "list", "element") : List.of(column.name());
        w.listBegin(3, Thrift.BINARY, path.size()); // path_in_schema
        for (String segment : path) {
          w.listString(segment);
        }
        w.i32(4, chunk.codec());
        w.i64(5, chunk.numValues());
        w.i64(6, chunk.rawSize()); // total_uncompressed_size
        w.i64(7, chunk.totalSize()); // total_compressed_size
        w.i64(9, chunk.dataOffset()); // data_page_offset
        // Field 11 must be written between 9 and 12: the compact protocol encodes field ids as
        // ascending deltas, so writing it out of order would corrupt every field after it.
        if (chunk.hasDictionary()) {
          w.i64(11, chunk.dictionaryOffset());
        }
        writeStatistics(w, chunk.statistics());
        w.structEnd();
        w.structEnd();
      }
      w.i64(2, totalByteSize); // total_byte_size
      w.i64(3, group.numRows());
      w.structEnd();
    }
  }

  private static byte[] concat(byte[]... parts) {
    int total = 0;
    for (byte[] part : parts) {
      total += part.length;
    }
    byte[] out = new byte[total];
    int at = 0;
    for (byte[] part : parts) {
      System.arraycopy(part, 0, out, at, part.length);
      at += part.length;
    }
    return out;
  }
}
