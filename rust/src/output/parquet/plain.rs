//! PLAIN encoding — the simplest Parquet value layout: values back to back,
//! little-endian, with no dictionary and no compression of their own.
//!
//! Correct and portable, which is what a first version should be. Denser
//! encodings can be added later without changing anything a reader accepts.

/// Little-endian wherever it runs. Rust's `to_le_bytes` says so outright, which
/// is the whole of the endianness question here.
pub fn int32(values: &[i32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn int64(values: &[i64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn doubles(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn floats(values: &[f64]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|v| (*v as f32).to_le_bytes())
        .collect()
}

/// Each value is a four-byte little-endian length followed by its bytes.
pub fn byte_array(values: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in values {
        let bytes = value.as_bytes();
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// Fixed-width values — a sixteen-byte UUID, say — carry no length prefix.
pub fn fixed(values: &[Vec<u8>]) -> Vec<u8> {
    values.iter().flatten().copied().collect()
}

/// Booleans are bit-packed, least significant bit first.
pub fn booleans(values: &[bool]) -> Vec<u8> {
    let mut out = vec![0u8; values.len().div_ceil(8)];
    for (i, on) in values.iter().enumerate() {
        if *on {
            out[i >> 3] |= 1 << (i & 7);
        }
    }
    out
}

pub fn float16(values: &[f64]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|v| {
            let bits = half_bits(*v);
            [(bits & 0xff) as u8, ((bits >> 8) & 0xff) as u8]
        })
        .collect()
}

/// IEEE-754 half precision as sixteen bits.
///
/// Parquet has no physical type for it — a FLOAT16 lives in a two-byte fixed
/// array — so the bits are assembled by hand. Rounding is half-to-even, matching
/// every other implementation: a different rule would put different bytes in the
/// file for the same input, which is exactly what a cross-language guarantee
/// forbids.
pub fn half_bits(value: f64) -> i32 {
    let x = (value as f32).to_bits() as i32;

    let sign = (((x as u32) >> 31) as i32 & 1) << 15;
    let exponent = ((x as u32) >> 23) as i32 & 0xff;
    let mantissa = x & 0x007f_ffff;

    // Infinity keeps a zero mantissa; a NaN must keep a non-zero one, or it
    // would arrive as infinity on the other side.
    if exponent == 0xff {
        return sign | 0x7c00 | if mantissa == 0 { 0 } else { 0x0200 };
    }

    let unbiased = exponent - 127;
    if unbiased > 15 {
        return sign | 0x7c00; // beyond half's range
    }

    if unbiased >= -14 {
        // Normal: drop thirteen of the twenty-three mantissa bits, rounding half
        // to even.
        let mut keep = ((mantissa as u32) >> 13) as i32;
        if rounds_up(mantissa & 0x1fff, 0x1000, keep) {
            keep += 1;
        }

        let mut half = unbiased + 15;
        if keep == 0x400 {
            keep = 0; // the mantissa carried into the exponent
            half += 1;
        }

        return if half >= 0x1f {
            sign | 0x7c00
        } else {
            sign | (half << 10) | keep
        };
    }

    if unbiased < -25 {
        return sign; // smaller than any subnormal, so a signed zero
    }

    // Subnormal: restore the implicit leading one, then shift it down to fit.
    let full = mantissa | 0x0080_0000;
    let shift = -unbiased - 1;
    let mut keep = ((full as u32) >> shift) as i32;
    if rounds_up(full & ((1 << shift) - 1), 1 << (shift - 1), keep) {
        keep += 1;
    }
    sign | keep
}

/// Round half to even, the IEEE-754 default.
///
/// The simpler round-half-up is the version most often copied around, and it
/// disagrees on exact ties: 2049 becomes 2050 rather than 2048. Ties are common
/// in generated data, so the wrong rule here would quietly put different bytes in
/// the file than every other Parquet writer produces.
fn rounds_up(dropped: i32, half_point: i32, keep: i32) -> bool {
    dropped > half_point || (dropped == half_point && (keep & 1) == 1)
}

/// Half-precision bits back to a number.
pub fn half_to_double(bits: i32) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = (bits >> 10) & 0x1f;
    let mantissa = bits & 0x03ff;
    if exponent == 0 {
        return sign * 2f64.powi(-14) * (f64::from(mantissa) / 1024.0);
    }
    if exponent == 0x1f {
        return if mantissa == 0 {
            sign * f64::INFINITY
        } else {
            f64::NAN
        };
    }
    sign * 2f64.powi(exponent - 15) * (1.0 + f64::from(mantissa) / 1024.0)
}
