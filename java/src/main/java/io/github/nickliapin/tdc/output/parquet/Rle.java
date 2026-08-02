package io.github.nickliapin.tdc.output.parquet;

import java.io.ByteArrayOutputStream;

/**
 * The RLE / bit-packed hybrid, which dictionary indices and level streams both ride on.
 *
 * <p>Two shapes share one stream, told apart by the low bit of a varint header. An RLE run is
 * {@code varint(count << 1)} followed by the repeated value; a bit-packed run is
 * {@code varint((groups << 1) | 1)} followed by groups of eight values packed at the given bit
 * width, least significant bit first.
 *
 * <p>Which shape is used matters more than it sounds. A categorical column — "Moscow", "Paris",
 * "Berlin" — is shuffled across rows, so consecutive repeats are rare and an RLE-only encoder
 * spends about two bytes per value, barely better than the text it replaced. Bit-packing spends
 * bits: two per value for three categories, a sixteen-fold difference on the same data. So
 * packing is the default and RLE is kept for the genuinely constant case.
 */
public final class Rle {

  private Rle() {}

  /** Bits needed to address {@code count} distinct entries; one for a single entry. */
  public static int dictionaryBitWidth(int count) {
    if (count <= 1) {
      return count == 0 ? 0 : 1;
    }
    int bits = 0;
    while ((1 << bits) < count) {
      bits++;
    }
    return bits;
  }

  /**
   * Dictionary indices for a data page.
   *
   * <p>The result begins with one byte holding the bit width. That byte belongs to the page body
   * rather than to the hybrid stream, and a reader expects it in exactly that place.
   */
  public static byte[] dictionaryIndices(int[] indices, int bitWidth) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(bitWidth);
    if (indices.length > 0) {
      int first = indices[0];
      boolean constant = true;
      for (int index : indices) {
        if (index != first) {
          constant = false;
          break;
        }
      }
      // A column holding one value all the way down collapses to a few bytes; anything else
      // packs, because shuffled categories have no runs worth exploiting.
      byte[] body = constant ? rleRun(first, indices.length, bitWidth) : bitPacked(indices, bitWidth);
      out.write(body, 0, body.length);
    }
    return out.toByteArray();
  }

  /**
   * A level stream, RLE-encoded.
   *
   * <p>Definition levels say how deep a value actually exists — for a flat column, 1 present and
   * 0 for NULL; for a list, also an empty list and a null element. Repetition levels say where a
   * new record starts (0) and where a list continues (1). Both are the same encoding, so one
   * function serves both.
   *
   * <p>Only RLE runs are emitted, one per stretch of equal levels. Valid, simple, and compact in
   * practice: real data is long runs of "present".
   */
  public static byte[] levels(int[] values, int bitWidth) {
    if (values.length == 0) {
      return new byte[0];
    }
    int valueBytes = (bitWidth + 7) / 8;
    ByteArrayOutputStream out = new ByteArrayOutputStream();

    int runStart = 0;
    while (runStart < values.length) {
      int value = values[runStart];
      int runEnd = runStart + 1;
      while (runEnd < values.length && values[runEnd] == value) {
        runEnd++;
      }
      byte[] header = Thrift.varint((long) (runEnd - runStart) << 1);
      out.write(header, 0, header.length);
      int v = value;
      for (int i = 0; i < valueBytes; i++) {
        out.write(v & 0xff);
        v >>>= 8;
      }
      runStart = runEnd;
    }
    return out.toByteArray();
  }

  /** One RLE run: the same value repeated. */
  private static byte[] rleRun(int value, int count, int bitWidth) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] header = Thrift.varint((long) count << 1);
    out.write(header, 0, header.length);
    int byteCount = (bitWidth + 7) / 8;
    long rest = value & 0xFFFFFFFFL;
    for (int i = 0; i < byteCount; i++) {
      out.write((int) (rest & 0xff));
      rest >>>= 8;
    }
    return out.toByteArray();
  }

  /** One bit-packed run covering every value, zero-padded to a multiple of eight. */
  private static byte[] bitPacked(int[] values, int bitWidth) {
    int groups = (values.length + 7) / 8;
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] header = Thrift.varint(((long) groups << 1) | 1);
    out.write(header, 0, header.length);

    long acc = 0;
    int bits = 0;
    int padded = groups * 8;
    for (int i = 0; i < padded; i++) {
      long value = i < values.length ? values[i] & 0xFFFFFFFFL : 0;
      acc |= value << bits;
      bits += bitWidth;
      while (bits >= 8) {
        out.write((int) (acc & 0xff));
        acc >>>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) {
      out.write((int) (acc & 0xff));
    }
    return out.toByteArray();
  }
}
