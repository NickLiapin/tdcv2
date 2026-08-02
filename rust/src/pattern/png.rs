//! Reads a curve out of a picture.
//!
//! Somebody sketches the shape they want — in any drawing program, on any
//! background — and points a config at the file. It is the least technical way
//! to say "the data should look like this", which is exactly why it is worth
//! supporting.
//!
//! Decoded here rather than through an image crate because the reading has to be
//! identical everywhere. Decoders differ in how they handle palettes, gamma and
//! 16-bit samples, and a config that produced one curve on one machine and a
//! slightly different one on another would break the promise this whole project
//! is built on.

use super::svg::Envelope;
use crate::archive::inflate::inflate;
use crate::engine::{invalid, EngineResult};

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

pub struct Image {
    pub width: usize,
    pub height: usize,
    /// Every colour type flattened to four bytes a pixel, row by row.
    pub rgba: Vec<u8>,
}

/// Channels per pixel, by PNG colour type.
fn channels(color_type: u8) -> Option<usize> {
    Some(match color_type {
        0 => 1, // grey
        2 => 3, // RGB
        3 => 1, // palette index
        4 => 2, // grey + alpha
        6 => 4, // RGBA
        _ => return None,
    })
}

pub fn is_png(buf: &[u8]) -> bool {
    buf.len() >= SIGNATURE.len() && buf[..SIGNATURE.len()] == SIGNATURE
}

pub fn decode(buf: &[u8]) -> EngineResult<Image> {
    if !is_png(buf) {
        return invalid("pattern: src is not a PNG image");
    }

    let mut width = 0usize;
    let mut height = 0usize;
    let mut bit_depth = 0u8;
    let mut color_type = 0u8;
    let mut interlace = 0u8;
    let mut saw_header = false;
    let mut palette: Vec<u8> = Vec::new();
    let mut transparency: Vec<u8> = Vec::new();
    let mut idat: Vec<u8> = Vec::new();

    let mut pos = SIGNATURE.len();
    while pos + 8 <= buf.len() {
        let len = read_u32(buf, pos) as usize;
        let kind = &buf[pos + 4..pos + 8];
        let start = pos + 8;
        let end = start.saturating_add(len).min(buf.len());
        match kind {
            b"IHDR" => {
                width = read_u32(buf, start) as usize;
                height = read_u32(buf, start + 4) as usize;
                bit_depth = at(buf, start + 8) as u8;
                color_type = at(buf, start + 9) as u8;
                interlace = at(buf, start + 12) as u8;
                saw_header = true;
            }
            b"PLTE" => palette = buf[start.min(end)..end].to_vec(),
            b"tRNS" => transparency = buf[start.min(end)..end].to_vec(),
            b"IDAT" => idat.extend_from_slice(&buf[start.min(end)..end]),
            // Everything else — text, timestamps, colour profiles — says nothing
            // about the shape.
            _ => {}
        }
        if kind == b"IEND" {
            break;
        }
        pos = start + len + 4; // data, then the CRC
    }

    if !saw_header {
        return invalid("pattern: PNG has no IHDR header");
    }
    if interlace != 0 {
        return invalid("pattern: interlaced PNG is unsupported — re-export without interlacing");
    }
    let Some(channels) = channels(color_type) else {
        return invalid(&format!("pattern: unsupported PNG color type {color_type}"));
    };
    let supported_depth = bit_depth == 8 || (bit_depth == 16 && color_type != 3);
    if !supported_depth {
        return invalid(&format!(
            "pattern: unsupported PNG bit depth {bit_depth} — re-export as 8-bit"
        ));
    }

    let bytes_per_sample = if bit_depth == 16 { 2 } else { 1 };
    let bpp = channels * bytes_per_sample;
    let stride = width * bpp;

    let raw = match inflate(zlib_body(&idat), height.saturating_mul(stride + 1)) {
        Ok(raw) => raw,
        Err(_) => return invalid("pattern: PNG image data is corrupt"),
    };
    let pixels = defilter(&raw, height, stride, bpp)?;

    Ok(Image {
        width,
        height,
        rgba: to_rgba(
            &pixels,
            width,
            height,
            color_type,
            bit_depth,
            &palette,
            &transparency,
        ),
    })
}

/// The DEFLATE stream inside PNG's zlib wrapper.
///
/// The inflater here speaks raw DEFLATE, because that is what a zip entry holds;
/// PNG wraps the same stream in two header bytes and a checksum. Those two bytes
/// are dropped when they look like a zlib header, and left alone when they do
/// not — a stream that is already raw then still reads.
fn zlib_body(data: &[u8]) -> &[u8] {
    if data.len() < 2 {
        return data;
    }
    let cmf = data[0];
    let flg = data[1];
    let looks_like_zlib = (cmf & 0x0f) == 8 && (u16::from(cmf) * 256 + u16::from(flg)) % 31 == 0;
    if looks_like_zlib {
        &data[2..]
    } else {
        data
    }
}

fn read_u32(buf: &[u8], at_index: usize) -> u32 {
    (at(buf, at_index) << 24)
        | (at(buf, at_index + 1) << 16)
        | (at(buf, at_index + 2) << 8)
        | at(buf, at_index + 3)
}

fn at(data: &[u8], i: usize) -> u32 {
    data.get(i).copied().map(u32::from).unwrap_or(0)
}

/// Undo the per-scanline filter each row declares.
///
/// PNG picks whichever of five predictors compresses that row best, so every row
/// has to be reconstructed against the one above it and the pixel to its left.
fn defilter(raw: &[u8], height: usize, stride: usize, bpp: usize) -> EngineResult<Vec<u8>> {
    let mut out = vec![0u8; height * stride];
    let mut raw_pos = 0usize;
    for y in 0..height {
        let filter = raw.get(raw_pos).copied().unwrap_or(0);
        raw_pos += 1;
        let row = y * stride;
        let prev = row.wrapping_sub(stride);
        for x in 0..stride {
            let cur = i32::from(raw.get(raw_pos).copied().unwrap_or(0));
            raw_pos += 1;
            let a = if x >= bpp {
                i32::from(out[row + x - bpp])
            } else {
                0
            };
            let b = if y > 0 { i32::from(out[prev + x]) } else { 0 };
            let c = if y > 0 && x >= bpp {
                i32::from(out[prev + x - bpp])
            } else {
                0
            };
            let recon = match filter {
                0 => cur,
                1 => cur + a,
                2 => cur + b,
                3 => cur + ((a + b) >> 1),
                4 => cur + paeth(a, b, c),
                other => {
                    return invalid(&format!(
                        "pattern: PNG scanline uses unknown filter {other}"
                    ))
                }
            };
            out[row + x] = (recon & 0xff) as u8;
        }
    }
    Ok(out)
}

fn paeth(a: i32, b: i32, c: i32) -> i32 {
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        return a;
    }
    if pb <= pc {
        b
    } else {
        c
    }
}

/// Every colour type, flattened to RGBA. Sixteen-bit samples keep their high
/// byte.
fn to_rgba(
    pixels: &[u8],
    width: usize,
    height: usize,
    color_type: u8,
    bit_depth: u8,
    palette: &[u8],
    transparency: &[u8],
) -> Vec<u8> {
    let mut rgba = vec![0u8; width * height * 4];
    let channels = channels(color_type).unwrap_or(1);
    let step = if bit_depth == 16 { 2 } else { 1 };
    let bpp = channels * step;

    for i in 0..width * height {
        let src = i * bpp;
        let dst = i * 4;
        let (r, g, b, a) = match color_type {
            0 => {
                let v = byte(pixels, src);
                (v, v, v, 255)
            }
            2 => (
                byte(pixels, src),
                byte(pixels, src + step),
                byte(pixels, src + 2 * step),
                255,
            ),
            3 => {
                let idx = byte(pixels, src) as usize;
                let alpha = if idx < transparency.len() {
                    byte(transparency, idx)
                } else {
                    255
                };
                (
                    byte(palette, idx * 3),
                    byte(palette, idx * 3 + 1),
                    byte(palette, idx * 3 + 2),
                    alpha,
                )
            }
            4 => {
                let v = byte(pixels, src);
                (v, v, v, byte(pixels, src + step))
            }
            _ => (
                byte(pixels, src),
                byte(pixels, src + step),
                byte(pixels, src + 2 * step),
                byte(pixels, src + 3 * step),
            ),
        };
        rgba[dst] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = a;
    }
    rgba
}

fn byte(data: &[u8], i: usize) -> u8 {
    data.get(i).copied().unwrap_or(0)
}

/// Perceptual brightness, 0..255 (Rec. 601).
pub fn luminance(r: u8, g: u8, b: u8) -> f64 {
    0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)
}

/// Where the ink is, column by column, as a top and a bottom edge.
///
/// Each column is measured from the top down and from the bottom up to the first
/// ink. Those two readings are the band for that column: where they meet on one
/// pixel the drawing is a single line and the value is exact; where they stand
/// apart the value is random between them. So one picture can be a precise curve
/// in some columns and a widening corridor in others, which is what a hand-drawn
/// sketch naturally is.
pub fn trace(img: &Image, ink_threshold: f64) -> EngineResult<Envelope> {
    let width = img.width;
    let height = img.height;
    let rgba = &img.rgba;
    let cut = ink_threshold * 255.0;

    // A drawing exported on transparency has no background at all, so there every
    // opaque pixel is the line. Only a picture flattened onto an opaque canvas
    // needs "dark means ink".
    //
    // So the test is whether the image has any transparency at all — not whether
    // it is opaque. Getting this backwards turns a thin line into a solid block
    // of ink, and the column then reads as a full-height band instead of a curve.
    let opaque_only = rgba.iter().skip(3).step_by(4).any(|alpha| *alpha < 128);

    let mut top: Vec<[f64; 2]> = Vec::new();
    let mut bottom: Vec<[f64; 2]> = Vec::new();
    for x in 0..width {
        let mut min_row: Option<usize> = None;
        let mut max_row = 0usize;
        for y in 0..height {
            let p = (y * width + x) * 4;
            let ink = if byte(rgba, p + 3) < 128 {
                false
            } else if opaque_only {
                true
            } else {
                luminance(byte(rgba, p), byte(rgba, p + 1), byte(rgba, p + 2)) <= cut
            };
            if ink {
                min_row.get_or_insert(y);
                max_row = y;
            }
        }
        // A gap in the stroke. Left out, and interpolated across by the curve.
        let Some(min_row) = min_row else { continue };

        let x = x as f64;
        let floor = (height - 1) as f64;
        if max_row - min_row <= 1 {
            let mid = floor - (min_row + max_row) as f64 / 2.0;
            top.push([x, mid]);
            bottom.push([x, mid]);
        } else {
            top.push([x, floor - min_row as f64]);
            bottom.push([x, floor - max_row as f64]);
        }
    }
    if top.len() < 2 {
        return invalid("pattern: the image has too little ink to read a curve from");
    }
    Ok(Envelope { top, bottom })
}
