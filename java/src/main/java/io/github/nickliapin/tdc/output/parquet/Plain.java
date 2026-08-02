package io.github.nickliapin.tdc.output.parquet;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * PLAIN encoding — the simplest Parquet value layout: values back to back, little-endian, with no
 * dictionary and no compression of their own.
 *
 * <p>Correct and portable, which is what a first version should be. Denser encodings can be added
 * later without changing anything a reader accepts.
 */
public final class Plain {

  private Plain() {}

  public static byte[] int32(List<Integer> values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.size() * 4).order(ByteOrder.LITTLE_ENDIAN);
    for (int value : values) {
      buffer.putInt(value);
    }
    return buffer.array();
  }

  public static byte[] int64(List<Long> values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.size() * 8).order(ByteOrder.LITTLE_ENDIAN);
    for (long value : values) {
      buffer.putLong(value);
    }
    return buffer.array();
  }

  public static byte[] doubles(List<Double> values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.size() * 8).order(ByteOrder.LITTLE_ENDIAN);
    for (double value : values) {
      buffer.putDouble(value);
    }
    return buffer.array();
  }

  public static byte[] floats(List<Double> values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.size() * 4).order(ByteOrder.LITTLE_ENDIAN);
    for (double value : values) {
      buffer.putFloat((float) value);
    }
    return buffer.array();
  }

  /** Each value is a four-byte little-endian length followed by its bytes. */
  public static byte[] byteArray(List<String> values) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (String value : values) {
      byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
      out.write(bytes.length & 0xff);
      out.write((bytes.length >>> 8) & 0xff);
      out.write((bytes.length >>> 16) & 0xff);
      out.write((bytes.length >>> 24) & 0xff);
      out.write(bytes, 0, bytes.length);
    }
    return out.toByteArray();
  }

  /** Fixed-width values — a sixteen-byte UUID, say — carry no length prefix. */
  public static byte[] fixed(List<byte[]> values) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] value : values) {
      out.write(value, 0, value.length);
    }
    return out.toByteArray();
  }

  /** Booleans are bit-packed, least significant bit first. */
  public static byte[] booleans(List<Boolean> values) {
    byte[] out = new byte[(values.size() + 7) / 8];
    for (int i = 0; i < values.size(); i++) {
      if (values.get(i)) {
        out[i >> 3] |= (byte) (1 << (i & 7));
      }
    }
    return out;
  }

  public static byte[] float16(List<Double> values) {
    ByteBuffer buffer = ByteBuffer.allocate(values.size() * 2).order(ByteOrder.LITTLE_ENDIAN);
    for (double value : values) {
      buffer.putShort((short) halfBits(value));
    }
    return buffer.array();
  }

  /**
   * IEEE-754 half precision as sixteen bits.
   *
   * <p>Parquet has no physical type for it — a FLOAT16 lives in a two-byte fixed array — so the
   * bits are assembled by hand. Rounding is half-to-even, matching every other implementation: a
   * different rule would put different bytes in the file for the same input, which is exactly
   * what a cross-language guarantee forbids.
   */
  public static int halfBits(double value) {
    int x = Float.floatToRawIntBits((float) value);

    int sign = ((x >>> 31) & 1) << 15;
    int exponent = (x >>> 23) & 0xff;
    int mantissa = x & 0x7fffff;

    // Infinity keeps a zero mantissa; a NaN must keep a non-zero one, or it would arrive as
    // infinity on the other side.
    if (exponent == 0xff) {
      return sign | 0x7c00 | (mantissa == 0 ? 0 : 0x0200);
    }

    int unbiased = exponent - 127;
    if (unbiased > 15) {
      return sign | 0x7c00; // beyond half's range
    }

    if (unbiased >= -14) {
      // Normal: drop thirteen of the twenty-three mantissa bits, rounding half to even.
      int keep = mantissa >>> 13;
      if (roundsUp(mantissa & 0x1fff, 0x1000, keep)) {
        keep++;
      }
      int half = unbiased + 15;
      if (keep == 0x400) {
        keep = 0; // the mantissa carried into the exponent
        half++;
      }
      return half >= 0x1f ? sign | 0x7c00 : sign | (half << 10) | keep;
    }

    if (unbiased < -25) {
      return sign; // smaller than any subnormal, so a signed zero
    }

    // Subnormal: restore the implicit leading one, then shift it down to fit.
    int full = mantissa | 0x800000;
    int shift = -unbiased - 1;
    int keep = full >>> shift;
    if (roundsUp(full & ((1 << shift) - 1), 1 << (shift - 1), keep)) {
      keep++;
    }
    return sign | keep;
  }

  /**
   * Round half to even, the IEEE-754 default.
   *
   * <p>The simpler round-half-up is the version most often copied around, and it disagrees on
   * exact ties: 2049 becomes 2050 rather than 2048. Ties are common in generated data, so the
   * wrong rule here would quietly put different bytes in the file than every other Parquet
   * writer produces.
   */
  private static boolean roundsUp(int dropped, int halfPoint, int keep) {
    if (dropped > halfPoint) {
      return true;
    }
    return dropped == halfPoint && (keep & 1) == 1;
  }

  /** Half-precision bits back to a number. */
  public static double halfToDouble(int bits) {
    double sign = (bits & 0x8000) != 0 ? -1 : 1;
    int exponent = (bits >> 10) & 0x1f;
    int mantissa = bits & 0x03ff;
    if (exponent == 0) {
      return sign * Math.pow(2, -14) * (mantissa / 1024.0);
    }
    if (exponent == 0x1f) {
      return mantissa == 0 ? sign * Double.POSITIVE_INFINITY : Double.NaN;
    }
    return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024.0);
  }
}
