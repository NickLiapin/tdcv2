//! The RLE / bit-packed hybrid, which dictionary indices and level streams both
//! ride on.
//!
//! Two shapes share one stream, told apart by the low bit of a varint header. An
//! RLE run is `varint(count << 1)` followed by the repeated value; a bit-packed
//! run is `varint((groups << 1) | 1)` followed by groups of eight values packed
//! at the given bit width, least significant bit first.
//!
//! Which shape is used matters more than it sounds. A categorical column —
//! "Moscow", "Paris", "Berlin" — is shuffled across rows, so consecutive repeats
//! are rare and an RLE-only encoder spends about two bytes per value, barely
//! better than the text it replaced. Bit-packing spends bits: two per value for
//! three categories, a sixteen-fold difference on the same data. So packing is
//! the default and RLE is kept for the genuinely constant case.

use super::thrift;

/// Bits needed to address `count` distinct entries; one for a single entry.
pub fn dictionary_bit_width(count: usize) -> u32 {
    if count <= 1 {
        return u32::from(count == 1);
    }
    let mut bits = 0u32;
    while (1usize << bits) < count {
        bits += 1;
    }
    bits
}

/// Dictionary indices for a data page.
///
/// The result begins with one byte holding the bit width. That byte belongs to
/// the page body rather than to the hybrid stream, and a reader expects it in
/// exactly that place.
pub fn dictionary_indices(indices: &[i32], bit_width: u32) -> Vec<u8> {
    let mut out = vec![bit_width as u8];
    if indices.is_empty() {
        return out;
    }
    let first = indices[0];
    // A column holding one value all the way down collapses to a few bytes;
    // anything else packs, because shuffled categories have no runs worth
    // exploiting.
    let body = if indices.iter().all(|i| *i == first) {
        rle_run(first, indices.len(), bit_width)
    } else {
        bit_packed(indices, bit_width)
    };
    out.extend_from_slice(&body);
    out
}

/// A level stream, RLE-encoded.
///
/// Definition levels say how deep a value actually exists — for a flat column, 1
/// present and 0 for NULL; for a list, also an empty list and a null element.
/// Repetition levels say where a new record starts (0) and where a list
/// continues (1). Both are the same encoding, so one function serves both.
///
/// Only RLE runs are emitted, one per stretch of equal levels. Valid, simple,
/// and compact in practice: real data is long runs of "present".
pub fn levels(values: &[i32], bit_width: u32) -> Vec<u8> {
    if values.is_empty() {
        return Vec::new();
    }
    let value_bytes = bit_width.div_ceil(8) as usize;
    let mut out = Vec::new();

    let mut run_start = 0usize;
    while run_start < values.len() {
        let value = values[run_start];
        let mut run_end = run_start + 1;
        while run_end < values.len() && values[run_end] == value {
            run_end += 1;
        }

        out.extend_from_slice(&thrift::varint(((run_end - run_start) as u64) << 1));
        let mut v = value as u32;
        for _ in 0..value_bytes {
            out.push((v & 0xff) as u8);
            v >>= 8;
        }
        run_start = run_end;
    }
    out
}

/// One RLE run: the same value repeated.
fn rle_run(value: i32, count: usize, bit_width: u32) -> Vec<u8> {
    let mut out = thrift::varint((count as u64) << 1);
    let byte_count = bit_width.div_ceil(8) as usize;
    let mut rest = value as u32;
    for _ in 0..byte_count {
        out.push((rest & 0xff) as u8);
        rest >>= 8;
    }
    out
}

/// One bit-packed run covering every value, zero-padded to a multiple of eight.
fn bit_packed(values: &[i32], bit_width: u32) -> Vec<u8> {
    let groups = values.len().div_ceil(8);
    let mut out = thrift::varint(((groups as u64) << 1) | 1);

    let mut acc: u64 = 0;
    let mut bits = 0u32;
    let padded = groups * 8;
    for i in 0..padded {
        let value = u64::from(values.get(i).copied().unwrap_or(0) as u32);
        acc |= value << bits;
        bits += bit_width;
        while bits >= 8 {
            out.push((acc & 0xff) as u8);
            acc >>= 8;
            bits -= 8;
        }
    }
    if bits > 0 {
        out.push((acc & 0xff) as u8);
    }
    out
}
