//! What a backslash means once the classes (`\d`, `\w`, `\s`, …) are out of the way.
//!
//! Shared by `regex` and `advanced_regex` — the port of the reference's `regex-escape.ts`.
//! Until it, every other escape fell to one final arm that returned the escaped character,
//! so `\x41` printed `x41` and `\bINV-\d{6}\b` printed `bINV-123456b` after a clean check.
//!
//!   `\xHH`, `\uHHHH`      the character with that code
//!   `\b \B \A \Z \z \G`   refused: a generated value has nothing around it to assert
//!   any other ASCII letter refused: never the letter itself
//!
//! Punctuation stays the character, as it always was.

/// The literal an escape stands for, or a refusal naming why it cannot be one.
pub fn escaped_literal(ch: char) -> Result<char, String> {
    if matches!(ch, 'b' | 'B' | 'A' | 'Z' | 'z' | 'G') {
        return Err(format!(
            "\"\\{ch}\" is a zero-width assertion, and a generated value has nothing around it \
             to assert — remove it"
        ));
    }
    if ch.is_ascii_alphabetic() {
        return Err(format!(
            "unknown escape \"\\{ch}\" — write the letter without the backslash, or \\xHH or \
             \\uHHHH for a character by its code"
        ));
    }
    Ok(ch)
}

/// How many hex digits `\x` and `\u` take.
pub fn hex_digits(kind: char) -> usize {
    if kind == 'x' {
        2
    } else {
        4
    }
}

/// The character `\xHH` or `\uHHHH` names, given the hex digits that followed it.
pub fn decode_hex(kind: char, hex: &str) -> Result<char, String> {
    let digits = hex_digits(kind);
    if hex.len() != digits || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        let example = if kind == 'x' { "\\x41" } else { "\\u0410" };
        return Err(format!(
            "\"\\{kind}\" needs exactly {digits} hex digits, as in {example}"
        ));
    }
    let code = u32::from_str_radix(hex, 16).unwrap_or(0);
    if (0xD800..=0xDFFF).contains(&code) {
        return Err(format!(
            "\"\\u{hex}\" is half of a surrogate pair — write the character itself"
        ));
    }
    char::from_u32(code).ok_or_else(|| format!("\"\\{kind}{hex}\" is not a character"))
}
