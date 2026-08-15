package io.github.nickliapin.tdc.output.parquet;

import io.github.nickliapin.tdc.output.ColumnType;
import java.math.BigInteger;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Rendered text into a typed value.
 *
 * <p>The engine produces strings; a typed container needs real values. Anything that cannot be
 * represented exactly is an error here — never a silent rounding, never a truncation. A synthetic
 * dataset that quietly loses digits is worse than one that refuses to be written, because the
 * first kind is discovered much later and by someone who trusted it.
 */
public final class Convert {

  /** A value ready for PLAIN encoding. {@code null} means the column is NULL on this row. */
  public sealed interface Value
      permits BoolValue, IntValue, LongValue, DoubleValue, TextValue, BytesValue {}

  public record BoolValue(boolean value) implements Value {}

  public record IntValue(int value) implements Value {}

  public record LongValue(long value) implements Value {}

  public record DoubleValue(double value) implements Value {}

  public record TextValue(String value) implements Value {}

  public record BytesValue(byte[] value) implements Value {}

  private static final Pattern INTEGER = Pattern.compile("^[+-]?\\d+$");
  private static final Pattern DATE = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})$");
  private static final Pattern DECIMAL = Pattern.compile("^([+-]?)(\\d+)(?:\\.(\\d*))?$");
  private static final Pattern HEX32 = Pattern.compile("^[0-9a-f]{32}$");

  private Convert() {}

  /**
   * Convert one rendered cell.
   *
   * <p>Throws a message about the value and the expectation; the writer wraps it in the column
   * name and the row number, so the complaint names the cell rather than the file.
   */
  public static Value value(String raw, ColumnType type) {
    if (raw.isEmpty()) {
      if (type.nullable()) {
        return null;
      }
      throw new IllegalArgumentException("empty value in a required column (add |null to allow NULL)");
    }
    String text = raw.trim();

    switch (type.kind()) {
      case BOOL: {
        String v = text.toLowerCase(java.util.Locale.ROOT);
        if ("true".equals(v) || "1".equals(v)) {
          return new BoolValue(true);
        }
        if ("false".equals(v) || "0".equals(v)) {
          return new BoolValue(false);
        }
        throw new IllegalArgumentException(
            "\"" + raw + "\" is not a boolean (expected true/false or 1/0)");
      }
      case INT32: {
        BigInteger v = integer(text, "int32");
        if (v.compareTo(BigInteger.valueOf(Integer.MIN_VALUE)) < 0
            || v.compareTo(BigInteger.valueOf(Integer.MAX_VALUE)) > 0) {
          throw new IllegalArgumentException("\"" + raw + "\" is out of range for int32");
        }
        return new IntValue(v.intValue());
      }
      case INT64: {
        BigInteger v = integer(text, "int64");
        if (v.bitLength() > 63) {
          throw new IllegalArgumentException("\"" + raw + "\" is out of range for int64");
        }
        return new LongValue(v.longValue());
      }
      case UINT8:
        return new IntValue(unsigned(text, raw, 8).intValue());
      case UINT16:
        return new IntValue(unsigned(text, raw, 16).intValue());
      case UINT32:
        // Stored in a signed 32-bit slot: a value above 2^31-1 wraps to negative bits, which is
        // exactly what the unsigned annotation tells a reader to undo.
        return new IntValue(unsigned(text, raw, 32).intValue());
      case UINT64:
        return new LongValue(unsigned(text, raw, 64).longValue());
      case FLOAT: {
        double v = number(text, raw);
        // Rounded to what four bytes can actually hold, so the value in memory is the value on
        // disk — otherwise the column statistics would describe numbers the file does not have.
        float rounded = (float) v;
        if (!Float.isFinite(rounded)) {
          throw new IllegalArgumentException("\"" + raw + "\" is out of range for float");
        }
        return new DoubleValue(rounded);
      }
      case FLOAT16: {
        double v = number(text, raw);
        double rounded = Plain.halfToDouble(Plain.halfBits(v));
        if (!Double.isFinite(rounded)) {
          throw new IllegalArgumentException("\"" + raw + "\" is out of range for float16");
        }
        return new DoubleValue(rounded);
      }
      case DOUBLE:
        return new DoubleValue(number(text, raw));
      case DATE:
        return new IntValue(days(text));
      case TIMESTAMP:
        return new LongValue(millis(text, raw));
      case DECIMAL:
        return new LongValue(decimal(text, type.precision(), type.scale()));
      case UUID:
        return new BytesValue(uuid(text));
      case STRING:
      case ENUM:
      case JSON:
        return new TextValue(raw); // passed through untouched, surrounding spaces included
      default:
        throw new IllegalArgumentException("cannot convert to " + type);
    }
  }

  private static BigInteger integer(String text, String what) {
    if (!INTEGER.matcher(text).matches()) {
      throw new IllegalArgumentException("\"" + text + "\" is not an integer (" + what + ")");
    }
    return new BigInteger(text);
  }

  private static double number(String text, String raw) {
    // Java accepts "1d", "0x1p3" and a leading "+"; JavaScript's Number() does not, and the two
    // implementations have to refuse the same strings.
    if (!text.matches("^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$")) {
      throw new IllegalArgumentException("\"" + raw + "\" is not a number");
    }
    double v = Double.parseDouble(text);
    if (!Double.isFinite(v)) {
      throw new IllegalArgumentException("\"" + raw + "\" is not a number");
    }
    return v;
  }

  /** An unsigned integer of the given width, with negatives refused outright. */
  private static BigInteger unsigned(String text, String raw, int bits) {
    BigInteger v = integer(text, "uint" + bits);
    if (v.signum() < 0) {
      throw new IllegalArgumentException("\"" + raw + "\" is negative, but the column is unsigned");
    }
    BigInteger limit = BigInteger.ONE.shiftLeft(bits).subtract(BigInteger.ONE);
    if (v.compareTo(limit) > 0) {
      throw new IllegalArgumentException("\"" + raw + "\" is out of range for uint" + bits);
    }
    return v;
  }

  /** Days since the epoch — how Parquet stores a date. */
  private static int days(String text) {
    Matcher m = DATE.matcher(text);
    if (!m.matches()) {
      throw new IllegalArgumentException("\"" + text + "\" is not a date (expected YYYY-MM-DD)");
    }
    int year = Integer.parseInt(m.group(1));
    int month = Integer.parseInt(m.group(2));
    int day = Integer.parseInt(m.group(3));
    LocalDate date;
    try {
      date = LocalDate.of(year, month, day);
    } catch (java.time.DateTimeException e) {
      throw new IllegalArgumentException("\"" + text + "\" is not a date (no such calendar day)");
    }
    return (int) date.toEpochDay();
  }

  private static long millis(String text, String raw) {
    try {
      return OffsetDateTime.parse(text).toInstant().toEpochMilli();
    } catch (DateTimeParseException ignored) {
      // Not offset-qualified; a bare local timestamp is read as UTC, as the reference does.
    }
    try {
      return java.time.LocalDateTime.parse(text).toInstant(ZoneOffset.UTC).toEpochMilli();
    } catch (DateTimeParseException ignored) {
      // Fall through to a plain date.
    }
    try {
      return LocalDate.parse(text).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    } catch (DateTimeParseException e) {
      throw new IllegalArgumentException(
          "\"" + raw + "\" is not a timestamp (expected ISO-8601)");
    }
  }

  /** A decimal as its unscaled integer — refusing anything the declared type cannot hold. */
  private static long decimal(String text, int precision, int scale) {
    Matcher m = DECIMAL.matcher(text);
    if (!m.matches()) {
      throw new IllegalArgumentException("\"" + text + "\" is not a decimal");
    }
    String fraction = m.group(3) == null ? "" : m.group(3);
    if (fraction.length() > scale) {
      throw new IllegalArgumentException(
          "\"" + text + "\" has more decimal places than the declared scale " + scale
              + " — refusing to round");
    }
    String digits = m.group(2) + padRight(fraction, scale);
    String significant = digits.replaceFirst("^0+", "");
    if (significant.length() > precision) {
      throw new IllegalArgumentException(
          "\"" + text + "\" exceeds the declared precision " + precision);
    }
    BigInteger unscaled = new BigInteger(digits);
    if ("-".equals(m.group(1))) {
      unscaled = unscaled.negate();
    }
    if (unscaled.bitLength() > 63) {
      throw new IllegalArgumentException("\"" + text + "\" does not fit a 64-bit decimal");
    }
    return unscaled.longValue();
  }

  private static byte[] uuid(String text) {
    String hex = text.replace("-", "").toLowerCase(java.util.Locale.ROOT);
    if (!HEX32.matcher(hex).matches()) {
      throw new IllegalArgumentException("\"" + text + "\" is not a uuid");
    }
    byte[] out = new byte[16];
    for (int i = 0; i < 16; i++) {
      out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  private static String padRight(String text, int width) {
    StringBuilder out = new StringBuilder(text);
    while (out.length() < width) {
      out.append('0');
    }
    return out.toString();
  }
}
