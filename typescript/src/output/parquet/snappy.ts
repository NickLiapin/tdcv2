/**
 * Snappy compression, written here rather than taken from a package.
 *
 * Two reasons, and the second is the real one:
 *
 *   1. no runtime dependency — the whole writer exists to avoid one;
 *   2. two different snappy implementations may emit DIFFERENT (both valid)
 *      output for the same input, because the format leaves match-finding to
 *      the encoder. TDC promises that the TypeScript, Python and Java ports
 *      produce byte-identical files; that promise survives only if all three
 *      run the same matcher. Ours does, by construction.
 *
 * Format: a varint holding the uncompressed length, then a stream of elements.
 * Each element is either a LITERAL (bytes copied out verbatim) or a COPY (go
 * back `offset` bytes and take `length` of them). The tag byte's low two bits
 * say which, and copies come in three sizes depending on how far back they
 * reach.
 *
 * The matcher is a plain hash table over four-byte sequences. It is not the
 * strongest possible — Snappy explicitly permits any encoder that decodes back
 * to the input — but it is fast, allocation-light and, above all, exactly
 * reproducible.
 * Spec: docs/specs/2026-07-19-parquet-statistics-and-encodings.md §4
 */

/** Table size. Larger finds more matches and costs more memory; fixed so every port agrees. */
const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;

/** A copy can reach back at most this far. */
const MAX_OFFSET = 1 << 16;

/** One copy element carries at most this many bytes; longer matches emit several. */
const MAX_COPY_LENGTH = 64;

/** Below this a match is not worth a copy element. */
const MIN_MATCH = 4;

function readUint32(input: Uint8Array, at: number): number {
  return (
    ((input[at] ?? 0) |
      ((input[at + 1] ?? 0) << 8) |
      ((input[at + 2] ?? 0) << 16) |
      ((input[at + 3] ?? 0) << 24)) >>>
    0
  );
}

function pushVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

/** Literal run: the tag, an optional extended length, then the bytes themselves. */
function emitLiteral(out: number[], input: Uint8Array, start: number, length: number): void {
  if (length <= 0) return;
  const n = length - 1;
  if (n < 60) {
    out.push(n << 2);
  } else {
    // 60..63 in the tag mean "1 to 4 length bytes follow", little-endian.
    let width = 0;
    let rest = n;
    while (rest > 0) {
      width++;
      rest = Math.floor(rest / 256);
    }
    out.push((59 + width) << 2);
    rest = n;
    for (let i = 0; i < width; i++) {
      out.push(rest & 0xff);
      rest = Math.floor(rest / 256);
    }
  }
  for (let i = 0; i < length; i++) out.push(input[start + i] ?? 0);
}

/**
 * Copy element. The one-byte-offset form is smaller but only reaches 2047 bytes
 * back and carries 4..11 bytes; everything else uses the two-byte form.
 */
function emitCopy(out: number[], offset: number, length: number): void {
  if (length >= MIN_MATCH && length <= 11 && offset < 2048) {
    out.push(0x01 | ((length - MIN_MATCH) << 2) | ((offset >>> 8) << 5));
    out.push(offset & 0xff);
    return;
  }
  out.push(0x02 | ((length - 1) << 2));
  out.push(offset & 0xff);
  out.push((offset >>> 8) & 0xff);
}

/** Compress with Snappy. The result always decodes back to `input` exactly. */
export function snappyCompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  pushVarint(out, input.length);
  const size = input.length;
  if (size === 0) return Uint8Array.from(out);

  const table = new Int32Array(HASH_SIZE).fill(-1);
  let literalStart = 0;
  let at = 0;

  while (at + MIN_MATCH <= size) {
    // Multiply-shift hash — the constant is Snappy's own, kept so the table
    // behaves identically in every port.
    const slot = Math.imul(readUint32(input, at), 0x1e35a7bd) >>> (32 - HASH_BITS);
    const candidate = table[slot] ?? -1;
    table[slot] = at;

    const near = candidate >= 0 && at - candidate < MAX_OFFSET;
    if (!near || readUint32(input, candidate) !== readUint32(input, at)) {
      at++;
      continue;
    }

    emitLiteral(out, input, literalStart, at - literalStart);

    // Extend the match as far as it goes, emitting several copies if needed.
    let matched = MIN_MATCH;
    while (at + matched < size && input[candidate + matched] === input[at + matched]) matched++;
    const offset = at - candidate;
    let remaining = matched;
    while (remaining > 0) {
      const piece = Math.min(remaining, MAX_COPY_LENGTH);
      emitCopy(out, offset, piece);
      remaining -= piece;
    }

    at += matched;
    literalStart = at;
  }

  emitLiteral(out, input, literalStart, size - literalStart);
  return Uint8Array.from(out);
}
