package io.github.nickliapin.tdc.output.parquet;

import java.io.ByteArrayOutputStream;

/**
 * Snappy compression, written here rather than taken from a library.
 *
 * <p>Two reasons, and the second is the real one. First, no runtime dependency — the whole writer
 * exists to avoid one. Second, two different Snappy implementations may emit different, both
 * valid, output for the same input, because the format leaves match-finding entirely to the
 * encoder. This project promises that its implementations produce byte-identical files, and that
 * promise survives only if all of them run the same matcher. This one does, by construction.
 *
 * <p>The format: a varint holding the uncompressed length, then a stream of elements. An element
 * is either a literal (bytes copied out as they are) or a copy (go back this far and take this
 * many). The tag byte's low two bits say which, and copies come in sizes depending on how far
 * back they reach.
 *
 * <p>The matcher is a plain hash table over four-byte sequences. Not the strongest possible —
 * Snappy permits any encoder whose output decodes back to the input — but fast, allocation-light
 * and, above all, exactly reproducible.
 */
public final class Snappy {

  /** Table size: larger finds more matches and costs more memory. Fixed so every port agrees. */
  private static final int HASH_BITS = 14;

  private static final int HASH_SIZE = 1 << HASH_BITS;

  /** A copy can reach back at most this far. */
  private static final int MAX_OFFSET = 1 << 16;

  /** One copy element carries at most this many bytes; a longer match emits several. */
  private static final int MAX_COPY_LENGTH = 64;

  /** Below this, a match is not worth a copy element. */
  private static final int MIN_MATCH = 4;

  private Snappy() {}

  /** Compress. The result always decodes back to the input exactly. */
  public static byte[] compress(byte[] input) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    varint(out, input.length);
    int size = input.length;
    if (size == 0) {
      return out.toByteArray();
    }

    int[] table = new int[HASH_SIZE];
    java.util.Arrays.fill(table, -1);
    int literalStart = 0;
    int at = 0;

    while (at + MIN_MATCH <= size) {
      // Multiply-shift hash; the constant is Snappy's own, kept so the table behaves the same
      // way in every implementation.
      int slot = (readUint32(input, at) * 0x1e35a7bd) >>> (32 - HASH_BITS);
      int candidate = table[slot];
      table[slot] = at;

      boolean near = candidate >= 0 && at - candidate < MAX_OFFSET;
      if (!near || readUint32(input, candidate) != readUint32(input, at)) {
        at++;
        continue;
      }

      literal(out, input, literalStart, at - literalStart);

      // Extend the match as far as it goes, emitting several copies when it is long.
      int matched = MIN_MATCH;
      while (at + matched < size && input[candidate + matched] == input[at + matched]) {
        matched++;
      }
      int offset = at - candidate;
      int remaining = matched;
      while (remaining > 0) {
        int piece = Math.min(remaining, MAX_COPY_LENGTH);
        copy(out, offset, piece);
        remaining -= piece;
      }

      at += matched;
      literalStart = at;
    }

    literal(out, input, literalStart, size - literalStart);
    return out.toByteArray();
  }

  private static int readUint32(byte[] input, int at) {
    int b0 = at < input.length ? input[at] & 0xff : 0;
    int b1 = at + 1 < input.length ? input[at + 1] & 0xff : 0;
    int b2 = at + 2 < input.length ? input[at + 2] & 0xff : 0;
    int b3 = at + 3 < input.length ? input[at + 3] & 0xff : 0;
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }

  private static void varint(ByteArrayOutputStream out, int value) {
    int rest = value;
    while (rest >= 0x80) {
      out.write((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.write(rest);
  }

  /** A literal run: the tag, an optional extended length, then the bytes. */
  private static void literal(ByteArrayOutputStream out, byte[] input, int start, int length) {
    if (length <= 0) {
      return;
    }
    int n = length - 1;
    if (n < 60) {
      out.write(n << 2);
    } else {
      // 60..63 in the tag mean "one to four length bytes follow", little-endian.
      int width = 0;
      int rest = n;
      while (rest > 0) {
        width++;
        rest >>>= 8;
      }
      out.write((59 + width) << 2);
      rest = n;
      for (int i = 0; i < width; i++) {
        out.write(rest & 0xff);
        rest >>>= 8;
      }
    }
    out.write(input, start, length);
  }

  /**
   * A copy element.
   *
   * <p>The one-byte-offset form is smaller but reaches only 2047 bytes back and carries four to
   * eleven bytes; everything else uses the two-byte form.
   */
  private static void copy(ByteArrayOutputStream out, int offset, int length) {
    if (length >= MIN_MATCH && length <= 11 && offset < 2048) {
      out.write(0x01 | ((length - MIN_MATCH) << 2) | ((offset >>> 8) << 5));
      out.write(offset & 0xff);
      return;
    }
    out.write(0x02 | ((length - 1) << 2));
    out.write(offset & 0xff);
    out.write((offset >>> 8) & 0xff);
  }
}
