/**
 * PLAIN encoding — the simplest Parquet value layout: values written back to
 * back, little-endian, with no compression or dictionary. Correct and portable;
 * denser encodings can be added later without changing what readers accept.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6.
 */

export function plainInt32(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setInt32(i * 4, v, true);
  });
  return out;
}

export function plainInt64(values: readonly bigint[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setBigInt64(i * 8, v, true);
  });
  return out;
}

export function plainDouble(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setFloat64(i * 8, v, true);
  });
  return out;
}

/** Each value is a 4-byte little-endian byte length followed by its bytes. */
export function plainByteArray(values: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = values.map((v) => encoder.encode(v));
  const total = encoded.reduce((sum, b) => sum + 4 + b.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const bytes of encoded) {
    view.setUint32(at, bytes.length, true);
    out.set(bytes, at + 4);
    at += 4 + bytes.length;
  }
  return out;
}

/** Fixed-width values (e.g. a 16-byte UUID) carry no length prefix. */
export function plainFixed(values: readonly Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const bytes of values) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** Booleans are bit-packed, least-significant bit first. */
export function plainBoolean(values: readonly boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 8));
  values.forEach((v, i) => {
    if (v) out[i >> 3] = (out[i >> 3] ?? 0) | (1 << (i & 7));
  });
  return out;
}

/** PLAIN FLOAT: 4-byte little-endian IEEE-754 single precision. */
export function plainFloat(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    view.setFloat32(i * 4, value, true);
  });
  return out;
}

/**
 * IEEE-754 half precision (binary16) as two little-endian bytes.
 *
 * Parquet stores FLOAT16 in a FIXED_LEN_BYTE_ARRAY(2); there is no native
 * physical type for it, so the bits are assembled by hand. Rounding is
 * round-half-to-even, matching what every other implementation does — a
 * different rounding rule would put different bytes in the file for the same
 * input, which is exactly what the cross-language contract forbids.
 */
export function halfBits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const x = view.getUint32(0, true);

  const sign = ((x >>> 31) & 1) << 15;
  const exponent = (x >>> 23) & 0xff;
  const mantissa = x & 0x7fffff;

  // Infinity keeps a zero mantissa; NaN must keep a non-zero one so it stays
  // NaN rather than turning into Infinity.
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x0200);

  const unbiased = exponent - 127;
  if (unbiased > 15) return sign | 0x7c00; // beyond half's range

  if (unbiased >= -14) {
    // Normal: drop 13 of the 23 mantissa bits, rounding half to even.
    let keep = mantissa >>> 13;
    if (roundsUp(mantissa & 0x1fff, 0x1000, keep)) keep++;
    let half = unbiased + 15;
    if (keep === 0x400) {
      keep = 0; // the mantissa carried into the exponent
      half++;
    }
    return half >= 0x1f ? sign | 0x7c00 : sign | (half << 10) | keep;
  }

  if (unbiased < -25) return sign; // smaller than any subnormal → signed zero

  // Subnormal: restore the implicit leading one, then shift it down to fit.
  const full = mantissa | 0x800000;
  const shift = -unbiased - 1;
  let keep = full >>> shift;
  if (roundsUp(full & ((1 << shift) - 1), 1 << (shift - 1), keep)) keep++;
  return sign | keep;
}

/**
 * Round-half-to-even, the IEEE-754 default. A simpler round-half-up is the
 * version most often copied around, and it disagrees on exact ties: 2049 would
 * become 2050 instead of 2048. Ties are common in generated data, and a
 * different rule would put different bytes in the file than every other
 * Parquet writer produces.
 */
function roundsUp(dropped: number, halfPoint: number, keep: number): boolean {
  if (dropped > halfPoint) return true;
  return dropped === halfPoint && (keep & 1) === 1;
}

/** Decode half-precision bits back to a number. */
export function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

export function plainFloat16(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    view.setUint16(i * 2, halfBits(value), true);
  });
  return out;
}
