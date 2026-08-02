//! `<encode as="...">` — one character to a number.
//!
//! The step every alphanumeric check digit needs: an IBAN turns letters into
//! numbers before it takes its mod 97, a vehicle identification number folds
//! letters into digits before weighting.
//!
//! For `base36`, `ascii` and `unicode` the result is the character's *decimal*
//! value, so `A` under base36 is the string `"10"` and a fold then consumes
//! those digits. For `hex`, `binary` and `octal` it is the code point written in
//! that base.
//!
//! A character means one Unicode code point, never one UTF-16 unit — the rest of
//! the layer iterates strings by code point, and an encoding that disagreed
//! would split an emoji in half.

use super::value::{err, ComputeResult};

pub fn encode_char(ch: &str, as_what: &str) -> ComputeResult<String> {
    match as_what {
        "base36" => Ok(base36_value(ch)?.to_string()),
        "ascii" => ascii_value(ch),
        "unicode" => Ok(code_point_of(ch)?.to_string()),
        "hex" => Ok(to_base(code_point_of(ch)?, 16)),
        "binary" => Ok(to_base(code_point_of(ch)?, 2)),
        "octal" => Ok(to_base(code_point_of(ch)?, 8)),
        other => err(format!(
            "<encode as=\"{other}\">: unknown encoding \
             (base36, ascii, unicode, hex, binary, octal)"
        )),
    }
}

fn ascii_value(ch: &str) -> ComputeResult<String> {
    let cp = code_point_of(ch)?;
    if cp >= 128 {
        return err(format!(
            "<encode as=\"ascii\">: \"{ch}\" is not an ASCII character (code >= 128)"
        ));
    }
    Ok(cp.to_string())
}

pub fn code_point_of(ch: &str) -> ComputeResult<u32> {
    let mut chars = ch.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Ok(c as u32),
        _ => err(format!(
            "<encode>: expected a single character, got \"{ch}\""
        )),
    }
}

/// 0-9 to 0..9, and either case of A-Z to 10..35.
fn base36_value(ch: &str) -> ComputeResult<u32> {
    let cp = code_point_of(ch)?;
    match char::from_u32(cp) {
        Some(c @ '0'..='9') => Ok(c as u32 - '0' as u32),
        Some(c @ 'A'..='Z') => Ok(c as u32 - 'A' as u32 + 10),
        Some(c @ 'a'..='z') => Ok(c as u32 - 'a' as u32 + 10),
        _ => err(format!(
            "<encode as=\"base36\">: \"{ch}\" is not a digit or letter"
        )),
    }
}

/// Lower-case digits, as `Integer.toString(n, radix)` and `n.toString(radix)`
/// both write them.
fn to_base(value: u32, radix: u32) -> String {
    if value == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = value;
    let mut buffer = Vec::new();
    while v > 0 {
        buffer.push(DIGITS[(v % radix) as usize]);
        v /= radix;
    }
    buffer.reverse();
    String::from_utf8(buffer).expect("ASCII digits")
}
