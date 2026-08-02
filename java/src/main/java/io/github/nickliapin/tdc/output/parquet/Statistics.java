package io.github.nickliapin.tdc.output.parquet;

import io.github.nickliapin.tdc.output.ColumnType;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The min, the max and the NULL count of a column chunk.
 *
 * <p>This is what lets a reader skip a whole row group: asked for {@code price > 500}, it reads
 * the chunk's maximum and moves on without decoding a byte. Cheap to produce — every value is
 * already in hand — and a large win for whoever queries the file.
 *
 * <p>The danger runs the other way from most features: wrong statistics are worse than none. A
 * maximum that is too low makes a reader skip a group that did contain matching rows, and the
 * query returns fewer results with no error and no warning. So the comparisons here follow
 * Parquet's declared sort orders rather than the language's defaults — byte arrays compare as
 * unsigned UTF-8 bytes, NaN never takes part in a bound, and the unsigned kinds are compared
 * unsigned even though they are stored in signed slots.
 *
 * <p>Only {@code min_value}/{@code max_value} are written, never the deprecated {@code min}/{@code
 * max}: the old pair had ambiguous signedness that readers disagreed about, and writing a field
 * readers may misread is the same trap as writing a wrong bound.
 */
public final class Statistics {

  /** PLAIN-encoded bounds; {@code null} when the chunk holds no non-NULL value at all. */
  public record Result(byte[] minValue, byte[] maxValue, int nullCount) {}

  private Statistics() {}

  /**
   * Min, max and NULL count for one column chunk.
   *
   * <p>{@code nullCount} is supplied by the caller because for a list column the NULLs live in
   * the definition levels rather than among the values.
   */
  public static Result compute(ColumnType type, List<Convert.Value> present, int nullCount) {
    Convert.Value min = null;
    Convert.Value max = null;

    for (Convert.Value value : present) {
      if (value == null || unusable(type, value)) {
        continue;
      }
      if (min == null || compare(type, value, min) < 0) {
        min = value;
      }
      if (max == null || compare(type, value, max) > 0) {
        max = value;
      }
    }

    if (min == null) {
      return new Result(null, null, nullCount);
    }
    return new Result(encodeOne(type, min), encodeOne(type, max), nullCount);
  }

  /** Unsigned byte-wise comparison — Parquet's sort order for a byte array. */
  public static int compareBytes(byte[] a, byte[] b) {
    int shared = Math.min(a.length, b.length);
    for (int i = 0; i < shared; i++) {
      int x = a[i] & 0xff;
      int y = b[i] & 0xff;
      if (x != y) {
        return x < y ? -1 : 1;
      }
    }
    return Integer.compare(a.length, b.length);
  }

  /** PLAIN encoding of ONE value, as statistics store it — no length prefix. */
  private static byte[] encodeOne(ColumnType type, Convert.Value value) {
    switch (type.kind()) {
      case BOOL:
        return new byte[] {(byte) (((Convert.BoolValue) value).value() ? 1 : 0)};
      case INT32:
      case DATE:
      case UINT8:
      case UINT16:
      case UINT32:
        return ByteBuffer.allocate(4)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(((Convert.IntValue) value).value())
            .array();
      case FLOAT:
        return ByteBuffer.allocate(4)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putFloat((float) ((Convert.DoubleValue) value).value())
            .array();
      case FLOAT16:
        return ByteBuffer.allocate(2)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putShort((short) Plain.halfBits(((Convert.DoubleValue) value).value()))
            .array();
      case INT64:
      case TIMESTAMP:
      case DECIMAL:
      case UINT64:
        return ByteBuffer.allocate(8)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putLong(((Convert.LongValue) value).value())
            .array();
      case DOUBLE:
        return ByteBuffer.allocate(8)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putDouble(((Convert.DoubleValue) value).value())
            .array();
      case STRING:
      case ENUM:
      case JSON:
        return ((Convert.TextValue) value).value().getBytes(StandardCharsets.UTF_8);
      case UUID:
        return ((Convert.BytesValue) value).value();
      default:
        return new byte[0];
    }
  }

  /** Order two present values of this column type, following Parquet's rules for it. */
  private static int compare(ColumnType type, Convert.Value a, Convert.Value b) {
    switch (type.kind()) {
      case BOOL:
        return Boolean.compare(
            ((Convert.BoolValue) a).value(), ((Convert.BoolValue) b).value());
      case INT32:
      case DATE:
        return Integer.compare(((Convert.IntValue) a).value(), ((Convert.IntValue) b).value());
      case FLOAT:
      case FLOAT16:
      case DOUBLE: {
        double x = ((Convert.DoubleValue) a).value();
        double y = ((Convert.DoubleValue) b).value();
        if (Double.isNaN(x) || Double.isNaN(y)) {
          return 0;
        }
        return Double.compare(x, y);
      }
      case UINT8:
      case UINT16:
        // The small unsigned kinds keep their true value in the signed slot.
        return Integer.compare(((Convert.IntValue) a).value(), ((Convert.IntValue) b).value());
      case UINT32:
        // Stored as wrapped signed bits, so compared unsigned — otherwise a value above 2^31
        // would look smaller than one, and the bound would exclude real rows.
        return Integer.compareUnsigned(
            ((Convert.IntValue) a).value(), ((Convert.IntValue) b).value());
      case UINT64:
        return Long.compareUnsigned(
            ((Convert.LongValue) a).value(), ((Convert.LongValue) b).value());
      case INT64:
      case TIMESTAMP:
      case DECIMAL:
        return Long.compare(((Convert.LongValue) a).value(), ((Convert.LongValue) b).value());
      case STRING:
      case ENUM:
      case JSON:
        return compareBytes(
            ((Convert.TextValue) a).value().getBytes(StandardCharsets.UTF_8),
            ((Convert.TextValue) b).value().getBytes(StandardCharsets.UTF_8));
      case UUID:
        return compareBytes(((Convert.BytesValue) a).value(), ((Convert.BytesValue) b).value());
      default:
        return 0;
    }
  }

  /** A value that cannot take part in a bound. NaN only, for now. */
  private static boolean unusable(ColumnType type, Convert.Value value) {
    boolean floaty =
        type.kind() == ColumnType.Kind.DOUBLE
            || type.kind() == ColumnType.Kind.FLOAT
            || type.kind() == ColumnType.Kind.FLOAT16;
    return floaty && Double.isNaN(((Convert.DoubleValue) value).value());
  }

  /** Unused today, kept because a wider decimal will need it. */
  static BigInteger unscaled(long value) {
    return BigInteger.valueOf(value);
  }
}
