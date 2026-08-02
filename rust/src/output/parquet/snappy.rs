//! Snappy compression, written here rather than taken from a crate.
//!
//! Two reasons, and the second is the real one. First, no dependency — the whole
//! writer exists to avoid one. Second, two different Snappy implementations may
//! emit different, both valid, output for the same input, because the format
//! leaves match-finding entirely to the encoder. This project promises that its
//! implementations produce byte-identical files, and that promise survives only
//! if all of them run the same matcher. This one does, by construction.
//!
//! The format: a varint holding the uncompressed length, then a stream of
//! elements. An element is either a literal (bytes copied out as they are) or a
//! copy (go back this far and take this many). The tag byte's low two bits say
//! which, and copies come in sizes depending on how far back they reach.
//!
//! The matcher is a plain hash table over four-byte sequences. Not the strongest
//! possible — Snappy permits any encoder whose output decodes back to the input —
//! but fast, allocation-light and, above all, exactly reproducible.

/// Table size: larger finds more matches and costs more memory. Fixed so every
/// port agrees.
const HASH_BITS: u32 = 14;
const HASH_SIZE: usize = 1 << HASH_BITS;

/// A copy can reach back at most this far.
const MAX_OFFSET: usize = 1 << 16;

/// One copy element carries at most this many bytes; a longer match emits
/// several.
const MAX_COPY_LENGTH: usize = 64;

/// Below this, a match is not worth a copy element.
const MIN_MATCH: usize = 4;

/// Compress. The result always decodes back to the input exactly.
pub fn compress(input: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 2 + 32);
    varint(&mut out, input.len() as u32);
    let size = input.len();
    if size == 0 {
        return out;
    }

    let mut table = [-1i32; HASH_SIZE];
    let mut literal_start = 0usize;
    let mut at = 0usize;

    while at + MIN_MATCH <= size {
        // Multiply-shift hash; the constant is Snappy's own, kept so the table
        // behaves the same way in every implementation. Wrapping because the
        // multiply is meant to overflow.
        let slot = (read_u32(input, at).wrapping_mul(0x1e35_a7bd) >> (32 - HASH_BITS)) as usize;

        let candidate = table[slot];
        table[slot] = at as i32;

        let near = candidate >= 0 && at - (candidate as usize) < MAX_OFFSET;
        if !near || read_u32(input, candidate as usize) != read_u32(input, at) {
            at += 1;
            continue;
        }
        let candidate = candidate as usize;

        literal(&mut out, input, literal_start, at - literal_start);

        // Extend the match as far as it goes, emitting several copies when it is
        // long.
        let mut matched = MIN_MATCH;
        while at + matched < size && input[candidate + matched] == input[at + matched] {
            matched += 1;
        }

        let offset = at - candidate;
        let mut remaining = matched;
        while remaining > 0 {
            let piece = remaining.min(MAX_COPY_LENGTH);
            copy(&mut out, offset, piece);
            remaining -= piece;
        }

        at += matched;
        literal_start = at;
    }

    literal(&mut out, input, literal_start, size - literal_start);
    out
}

fn read_u32(input: &[u8], at: usize) -> u32 {
    let byte = |i: usize| u32::from(input.get(i).copied().unwrap_or(0));
    byte(at) | (byte(at + 1) << 8) | (byte(at + 2) << 16) | (byte(at + 3) << 24)
}

fn varint(out: &mut Vec<u8>, value: u32) {
    let mut rest = value;
    while rest >= 0x80 {
        out.push(((rest & 0x7f) | 0x80) as u8);
        rest >>= 7;
    }
    out.push(rest as u8);
}

/// A literal run: the tag, an optional extended length, then the bytes.
fn literal(out: &mut Vec<u8>, input: &[u8], start: usize, length: usize) {
    if length == 0 {
        return;
    }
    let n = length - 1;
    if n < 60 {
        out.push((n << 2) as u8);
    } else {
        // 60..63 in the tag mean "one to four length bytes follow",
        // little-endian.
        let mut width = 0u32;
        let mut rest = n as u32;
        while rest > 0 {
            width += 1;
            rest >>= 8;
        }
        out.push(((59 + width) << 2) as u8);
        let mut rest = n as u32;
        for _ in 0..width {
            out.push((rest & 0xff) as u8);
            rest >>= 8;
        }
    }
    out.extend_from_slice(&input[start..start + length]);
}

/// A copy element.
///
/// The one-byte-offset form is smaller but reaches only 2047 bytes back and
/// carries four to eleven bytes; everything else uses the two-byte form.
fn copy(out: &mut Vec<u8>, offset: usize, length: usize) {
    if (MIN_MATCH..=11).contains(&length) && offset < 2048 {
        out.push((0x01 | ((length - MIN_MATCH) << 2) | ((offset >> 8) << 5)) as u8);
        out.push((offset & 0xff) as u8);
        return;
    }
    out.push((0x02 | ((length - 1) << 2)) as u8);
    out.push((offset & 0xff) as u8);
    out.push(((offset >> 8) & 0xff) as u8);
}
