//! `<gen type="pattern" src="…">` — a drawing read from a file.
//!
//! Every expectation here was captured from the reference with the same files. A
//! curve read from a picture is where two implementations can most easily agree
//! in shape and differ in numbers, so the numbers are what is compared.

use std::path::Path;

use tdcv2::{Options, Tdc};

const CURVE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <path d="M 0 40 C 25 40 25 10 50 10 S 75 40 100 40" fill="none" stroke="black"/>
</svg>
"#;

const BAND_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <g transform="translate(0,0)">
    <polyline points="0,10 50,5 100,15" fill="none" stroke="black"/>
    <polyline points="0,40 50,30 100,45" fill="none" stroke="black"/>
  </g>
</svg>
"#;

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tdcv2-drawing-{name}"));
    std::fs::create_dir_all(&dir).expect("a scratch folder");
    dir
}

fn read(dir: &Path, file: &str) -> Result<Vec<String>, String> {
    let config = format!(
        "<tdc><env mode=\"memory\" count=\"6\" seed=\"draw\" local=\"en\">\
         <sequence name=\"V\"><gen type=\"pattern\" src=\"{file}\" y_range=\"0..100\" \
         decimals=\"1\"/></sequence>\
         </env><block><line><data>${{{{V}}}}</data></line></block></tdc>"
    );
    Tdc::new(Options {
        config_string: Some(config),
        base_dir: Some(dir.to_string_lossy().to_string()),
        ..Options::default()
    })
    .map(|data| data.text().lines().map(str::to_string).collect())
    .map_err(|e| e.to_string())
}

#[test]
fn an_svg_path_curves_and_all_matches_the_reference() {
    let dir = scratch("curve");
    std::fs::write(dir.join("curve.svg"), CURVE_SVG).expect("the file is written");
    // A cubic and a smooth-curve shorthand, flattened. Dropping either would give
    // a shape that still looks like a curve and is the wrong one.
    assert_eq!(
        read(&dir, "curve.svg").expect("the drawing reads"),
        ["2.1", "33.5", "90.4", "90.4", "33.5", "2.1"]
    );
}

#[test]
fn two_strokes_are_a_band_and_a_transform_is_honoured() {
    let dir = scratch("band");
    std::fs::write(dir.join("band.svg"), BAND_SVG).expect("the file is written");
    assert_eq!(
        read(&dir, "band.svg").expect("the drawing reads"),
        ["76.2", "29.1", "39.0", "84.1", "57.4", "54.0"]
    );
}

#[test]
fn a_png_is_traced_column_by_column_and_matches_the_reference() {
    let dir = scratch("png");
    std::fs::write(dir.join("line.png"), diagonal_png(20, 10)).expect("the file is written");
    // The picture's own height is the value scale, so the diagonal spans the
    // whole range.
    assert_eq!(
        read(&dir, "line.png").expect("the drawing reads"),
        ["100.0", "87.2", "66.0", "45.1", "24.0", "8.1"]
    );
}

#[test]
fn a_drawing_with_nothing_in_it_is_refused_not_silently_flat() {
    let dir = scratch("blank");
    std::fs::write(
        dir.join("blank.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    )
    .expect("the file is written");
    let message = read(&dir, "blank.svg").expect_err("an empty drawing is refused");
    assert!(message.contains("no <path>"), "{message}");
}

#[test]
fn a_file_that_is_not_there_says_so() {
    let dir = scratch("missing");
    let message = read(&dir, "nowhere.svg").expect_err("a missing drawing is refused");
    assert!(message.contains("cannot read"), "{message}");
}

// ── a PNG written by hand, so the test owns every byte of it ──────────────────

/// A black diagonal on white.
///
/// Deflated as a stored block: the crate decompresses and never compresses, and a
/// stored block is a legal DEFLATE stream that any PNG reader accepts. The point
/// of the fixture is the pixels, not how tightly they are packed.
fn diagonal_png(width: usize, height: usize) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0u8); // filter: none
        for x in 0..width {
            let ink = x * (height - 1) / (width - 1) == y;
            let v = if ink { 0u8 } else { 255u8 };
            raw.extend_from_slice(&[v, v, v]);
        }
    }

    let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit, RGB, no interlace
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &zlib_stored(&raw));
    chunk(&mut png, b"IEND", &[]);
    png
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

/// A zlib stream whose only block is stored: header, BFINAL, length twice (once
/// inverted), the bytes, then the checksum.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    out.push(0x01); // final block, stored
    out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    out.extend_from_slice(&(!(data.len() as u16)).to_le_bytes());
    out.extend_from_slice(data);
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}
