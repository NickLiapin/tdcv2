/**
 * Level streams — how Parquet says "this value is absent" and "this element
 * continues the previous list".
 *
 * DEFINITION levels say how deep a value actually exists: for a flat column the
 * max is 1 (`1` present, `0` NULL); for a list it also expresses an empty list
 * and a NULL element. REPETITION levels say where a new row starts (`0`) versus
 * where a list continues (`1`). Both are the same RLE encoding, so one function
 * serves both.
 *
 * Encoded with the RLE/bit-packed hybrid. We emit RLE runs only — one run per
 * stretch of equal levels — which is valid and simple. Real data is usually
 * long runs of "present", so this is also compact in practice.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6.
 */

import { encodeVarint } from './thrift.js';

/**
 * RLE-encode a level stream. Returns just the encoded runs — the page assembler
 * prefixes them with their 4-byte length. A bit width of 0 (every level the
 * same and zero) still emits its runs, which readers accept.
 */
export function encodeLevels(levels: readonly number[], bitWidth: number): Uint8Array {
  if (levels.length === 0) return new Uint8Array(0);
  const valueBytes = Math.ceil(bitWidth / 8);
  const out: number[] = [];

  let runStart = 0;
  while (runStart < levels.length) {
    const value = levels[runStart] ?? 0;
    let runEnd = runStart + 1;
    while (runEnd < levels.length && levels[runEnd] === value) runEnd++;
    const runLength = runEnd - runStart;

    // RLE run: varint header with bit 0 clear, then the repeated value.
    for (const b of encodeVarint(runLength << 1)) out.push(b);
    let v = value;
    for (let i = 0; i < valueBytes; i++) {
      out.push(v & 0xff);
      v >>>= 8;
    }
    runStart = runEnd;
  }
  return Uint8Array.from(out);
}
