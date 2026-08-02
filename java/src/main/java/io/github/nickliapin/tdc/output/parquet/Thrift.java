package io.github.nickliapin.tdc.output.parquet;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Thrift's compact protocol, write side only.
 *
 * <p>Parquet keeps its page headers and its entire footer in this encoding, so a file cannot be
 * produced without it. Small and completely specified — and unforgiving: one wrong byte and no
 * reader will open the file, with nothing to say about which byte. That is why it lives on its
 * own and is checked against known bytes.
 */
public final class Thrift {

  /** Compact type ids. A boolean carries its value in the field header rather than after it. */
  public static final int BOOLEAN_TRUE = 1;

  public static final int BOOLEAN_FALSE = 2;
  public static final int BYTE = 3;
  public static final int I16 = 4;
  public static final int I32 = 5;
  public static final int I64 = 6;
  public static final int DOUBLE = 7;
  public static final int BINARY = 8;
  public static final int LIST = 9;
  public static final int SET = 10;
  public static final int MAP = 11;
  public static final int STRUCT = 12;

  private final ByteArrayOutputStream out = new ByteArrayOutputStream();

  /** Field ids are written as a delta from the previous field of the same struct. */
  private int lastFieldId;

  private final Deque<Integer> stack = new ArrayDeque<>();

  public byte[] bytes() {
    return out.toByteArray();
  }

  /** How many bytes so far — what page and footer offsets are filled in from. */
  public int length() {
    return out.size();
  }

  /** Unsigned LEB128: seven bits per byte, the top bit meaning "more follows". */
  public static byte[] varint(long value) {
    if (value < 0) {
      throw new IllegalArgumentException("varint must be non-negative");
    }
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    long v = value;
    do {
      int b = (int) (v & 0x7f);
      v >>>= 7;
      if (v > 0) {
        b |= 0x80;
      }
      buffer.write(b);
    } while (v > 0);
    return buffer.toByteArray();
  }

  /** Fold a signed 32-bit value onto an unsigned one so small magnitudes stay short. */
  public static long zigzag32(int value) {
    return ((long) ((value << 1) ^ (value >> 31))) & 0xFFFFFFFFL;
  }

  public static long zigzag64(long value) {
    return (value << 1) ^ (value >> 63);
  }

  private void raw(int b) {
    out.write(b & 0xff);
  }

  private void rawBytes(byte[] bytes) {
    out.write(bytes, 0, bytes.length);
  }

  public void structBegin() {
    stack.push(lastFieldId);
    lastFieldId = 0;
  }

  public void structEnd() {
    raw(0x00); // struct stop
    lastFieldId = stack.isEmpty() ? 0 : stack.pop();
  }

  /** A field header: the short form when the id delta fits in four bits, the long form otherwise. */
  public void fieldBegin(int id, int type) {
    int delta = id - lastFieldId;
    if (delta > 0 && delta <= 15) {
      raw((delta << 4) | type);
    } else {
      raw(type);
      rawBytes(varint(zigzag32(id)));
    }
    lastFieldId = id;
  }

  /** A boolean has no value bytes: true and false are two different field types. */
  public void bool(int id, boolean value) {
    fieldBegin(id, value ? BOOLEAN_TRUE : BOOLEAN_FALSE);
  }

  /**
   * Thrift's {@code i8} — one raw byte, NOT zigzagged the way i16/i32/i64 are.
   *
   * <p>{@code LogicalType.IntType.bitWidth} is declared i8, and writing it as an i32 would shift
   * every field after it by a byte.
   */
  public void i8(int id, int value) {
    fieldBegin(id, BYTE);
    raw(value);
  }

  public void i32(int id, int value) {
    fieldBegin(id, I32);
    rawBytes(varint(zigzag32(value)));
  }

  public void i64(int id, long value) {
    fieldBegin(id, I64);
    rawBytes(varint(zigzag64(value)));
  }

  public void binary(int id, byte[] value) {
    fieldBegin(id, BINARY);
    rawBytes(varint(value.length));
    rawBytes(value);
  }

  public void string(int id, String value) {
    binary(id, value.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Open a list field. Its elements follow with the {@code list*} writers and carry no field
   * headers of their own; a list of structs uses {@link #structBegin()} and {@link #structEnd()}.
   */
  public void listBegin(int id, int elementType, int size) {
    fieldBegin(id, LIST);
    if (size < 15) {
      raw((size << 4) | elementType);
    } else {
      raw((0x0f << 4) | elementType);
      rawBytes(varint(size));
    }
  }

  public void listI32(int value) {
    rawBytes(varint(zigzag32(value)));
  }

  public void listI64(long value) {
    rawBytes(varint(zigzag64(value)));
  }

  public void listString(String value) {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    rawBytes(varint(bytes.length));
    rawBytes(bytes);
  }
}
