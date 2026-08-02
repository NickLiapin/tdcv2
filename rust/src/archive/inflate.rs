//! DEFLATE decompression — RFC 1951, written out.
//!
//! A bundle from the registry is a zip, and its entries are deflated. This is
//! the decompressor, and nothing else: the compressor is a separate problem the
//! Parquet writer will bring, and writing half of a format is better than
//! writing a general one nobody has a use for.
//!
//! Three block types, as the RFC has them: stored (raw bytes), fixed-Huffman
//! (the code lengths are in the spec) and dynamic-Huffman (the code lengths are
//! themselves Huffman-coded, which is the part worth reading twice). Symbols
//! above 256 are back-references into what has already been produced — and the
//! copy may overlap its own source, which is how a run of a thousand identical
//! bytes costs five, so it is written byte at a time rather than as a slice copy.

/// Why a stream could not be decompressed.
#[derive(Clone, Debug)]
pub struct InflateError(pub String);

impl std::fmt::Display for InflateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(what: impl Into<String>) -> Result<T, InflateError> {
    Err(InflateError(what.into()))
}

type Inflated = Result<Vec<u8>, InflateError>;

/// A raw DEFLATE stream, decompressed. `expected` is a size hint only.
pub fn inflate(data: &[u8], expected: usize) -> Inflated {
    let mut bits = BitReader::new(data);
    let mut out: Vec<u8> = Vec::with_capacity(expected);

    loop {
        let last = bits.bits(1)? == 1;
        match bits.bits(2)? {
            0 => stored(&mut bits, &mut out)?,
            1 => {
                let (lit, dist) = fixed_tables();
                block(&mut bits, &mut out, &lit, &dist)?;
            }
            2 => {
                let (lit, dist) = dynamic_tables(&mut bits)?;
                block(&mut bits, &mut out, &lit, &dist)?;
            }
            _ => return fail("deflate: reserved block type"),
        }
        if last {
            return Ok(out);
        }
    }
}

/// A stored block: byte-aligned, its length written twice, once inverted.
fn stored(bits: &mut BitReader, out: &mut Vec<u8>) -> Result<(), InflateError> {
    bits.align();
    let len = bits.bits(16)? as usize;
    let nlen = bits.bits(16)? as usize;
    if len != (!nlen & 0xffff) {
        return fail("deflate: stored block length does not match its complement");
    }
    for _ in 0..len {
        out.push(bits.byte()?);
    }
    Ok(())
}

/// Extra bits and base value for each length symbol, 257..=285.
const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn block(
    bits: &mut BitReader,
    out: &mut Vec<u8>,
    lit: &Huffman,
    dist: &Huffman,
) -> Result<(), InflateError> {
    loop {
        let symbol = lit.decode(bits)?;
        match symbol {
            0..=255 => out.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let at = (symbol - 257) as usize;
                let length =
                    LENGTH_BASE[at] as usize + bits.bits(u32::from(LENGTH_EXTRA[at]))? as usize;

                let code = dist.decode(bits)? as usize;
                if code >= DIST_BASE.len() {
                    return fail(format!("deflate: distance symbol {code} does not exist"));
                }
                let distance =
                    DIST_BASE[code] as usize + bits.bits(u32::from(DIST_EXTRA[code]))? as usize;
                if distance > out.len() {
                    return fail("deflate: a back-reference points before the start of the output");
                }

                // Byte at a time on purpose: the copy may overlap its own
                // source, which is how one byte repeated a thousand times costs
                // five. A slice copy would need the source to be finished first.
                let from = out.len() - distance;
                for i in 0..length {
                    let byte = out[from + i];
                    out.push(byte);
                }
            }
            _ => return fail(format!("deflate: literal symbol {symbol} does not exist")),
        }
    }
}

// ── Huffman ──────────────────────────────────────────────────────────────────

/// A canonical Huffman table, as a code-length list.
///
/// Decoded bit at a time against per-length ranges rather than through a lookup
/// table: a bundle is a few megabytes and unpacked once, so the simpler code
/// that is obviously the RFC's algorithm is worth more than the faster one.
struct Huffman {
    /// How many codes there are of each length, 0..=15.
    counts: [u16; 16],
    /// The symbols, ordered by code length and then by symbol.
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Result<Huffman, InflateError> {
        let mut counts = [0u16; 16];
        for &length in lengths {
            if length as usize >= counts.len() {
                return fail("deflate: a code length above 15");
            }
            counts[length as usize] += 1;
        }
        counts[0] = 0;

        let mut offsets = [0u16; 16];
        for length in 1..16 {
            offsets[length] = offsets[length - 1] + counts[length - 1];
        }

        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &length) in lengths.iter().enumerate() {
            if length != 0 {
                symbols[offsets[length as usize] as usize] = symbol as u16;
                offsets[length as usize] += 1;
            }
        }
        Ok(Huffman { counts, symbols })
    }

    fn decode(&self, bits: &mut BitReader) -> Result<u16, InflateError> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for length in 1..16 {
            code |= bits.bits(1)? as i32;
            let count = i32::from(self.counts[length]);
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        fail("deflate: a code longer than 15 bits")
    }
}

/// The fixed tables, spelled out in RFC 1951 section 3.2.6.
fn fixed_tables() -> (Huffman, Huffman) {
    let mut lengths = [0u8; 288];
    for (symbol, length) in lengths.iter_mut().enumerate() {
        *length = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    // Both are built from constant lengths, so neither can fail.
    (
        Huffman::new(&lengths).expect("the fixed literal lengths are valid"),
        Huffman::new(&[5u8; 30]).expect("the fixed distance lengths are valid"),
    )
}

/// The order the code-length code's own lengths are written in.
const LENGTH_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn dynamic_tables(bits: &mut BitReader) -> Result<(Huffman, Huffman), InflateError> {
    let literals = bits.bits(5)? as usize + 257;
    let distances = bits.bits(5)? as usize + 1;
    let code_lengths = bits.bits(4)? as usize + 4;
    if literals > 288 || distances > 32 {
        return fail("deflate: too many codes in a dynamic block");
    }

    // The lengths of the code-length code, in the RFC's own shuffled order — the
    // common ones first, so the rare tail can be left out entirely.
    let mut meta = [0u8; 19];
    for &slot in LENGTH_ORDER.iter().take(code_lengths) {
        meta[slot] = bits.bits(3)? as u8;
    }
    let meta = Huffman::new(&meta)?;

    // And now the real lengths, themselves Huffman-coded, with three repeat
    // symbols: copy the last one, or run zeros.
    let mut lengths = vec![0u8; literals + distances];
    let mut at = 0usize;
    while at < lengths.len() {
        let symbol = meta.decode(bits)?;
        match symbol {
            0..=15 => {
                lengths[at] = symbol as u8;
                at += 1;
            }
            16 => {
                if at == 0 {
                    return fail("deflate: a repeat with nothing to repeat");
                }
                let previous = lengths[at - 1];
                let times = 3 + bits.bits(2)? as usize;
                for _ in 0..times {
                    if at >= lengths.len() {
                        return fail("deflate: a repeat runs past the end of the code lengths");
                    }
                    lengths[at] = previous;
                    at += 1;
                }
            }
            17 | 18 => {
                let times = if symbol == 17 {
                    3 + bits.bits(3)? as usize
                } else {
                    11 + bits.bits(7)? as usize
                };
                if at + times > lengths.len() {
                    return fail("deflate: a zero run goes past the end of the code lengths");
                }
                at += times;
            }
            _ => return fail("deflate: a code-length symbol that does not exist"),
        }
    }

    Ok((
        Huffman::new(&lengths[..literals])?,
        Huffman::new(&lengths[literals..])?,
    ))
}

// ── bits ─────────────────────────────────────────────────────────────────────

/// DEFLATE's bit order: least significant first within a byte, and multi-bit
/// values assembled low bit first — which is the opposite of how the Huffman
/// codes themselves are packed, and the classic place to go wrong.
struct BitReader<'a> {
    data: &'a [u8],
    at: usize,
    /// How many bits of `data[at]` have been consumed.
    used: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> BitReader<'a> {
        BitReader {
            data,
            at: 0,
            used: 0,
        }
    }

    fn bits(&mut self, count: u32) -> Result<u32, InflateError> {
        let mut value = 0u32;
        for i in 0..count {
            let Some(&byte) = self.data.get(self.at) else {
                return fail("deflate: the stream ends mid-symbol");
            };
            let bit = (u32::from(byte) >> self.used) & 1;
            value |= bit << i;
            self.used += 1;
            if self.used == 8 {
                self.used = 0;
                self.at += 1;
            }
        }
        Ok(value)
    }

    /// Drop the rest of the current byte — what a stored block starts with.
    fn align(&mut self) {
        if self.used != 0 {
            self.used = 0;
            self.at += 1;
        }
    }

    fn byte(&mut self) -> Result<u8, InflateError> {
        let Some(&byte) = self.data.get(self.at) else {
            return fail("deflate: the stream ends inside a stored block");
        };
        self.at += 1;
        Ok(byte)
    }
}
