//! Rendered text into a typed value.
//!
//! The engine produces strings; a typed container needs real values. Anything
//! that cannot be represented exactly is an error here — never a silent
//! rounding, never a truncation. A synthetic dataset that quietly loses digits is
//! worse than one that refuses to be written, because the first kind is
//! discovered much later and by someone who trusted it.

use super::plain;
use crate::date;
use crate::output::column_type::{ColumnType, Kind};

/// A value ready for PLAIN encoding. `None` means the column is NULL on this
/// row.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Bool(bool),
    Int(i32),
    Long(i64),
    Double(f64),
    Text(String),
    Bytes(Vec<u8>),
}

/// A cell that cannot be represented. The writer wraps it in the column name and
/// the row number, so the complaint names the cell rather than the file.
#[derive(Clone, Debug)]
pub struct ConvertError(pub String);

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(what: impl Into<String>) -> Result<T, ConvertError> {
    Err(ConvertError(what.into()))
}

/// Convert one rendered cell.
pub fn of(raw: &str, ty: &ColumnType) -> Result<Option<Value>, ConvertError> {
    if raw.is_empty() {
        return if ty.nullable {
            Ok(None)
        } else {
            fail("empty value in a required column (add |null to allow NULL)")
        };
    }

    let text = raw.trim();
    let value = match ty.kind {
        Kind::Bool => match text.to_lowercase().as_str() {
            "true" | "1" => Value::Bool(true),
            "false" | "0" => Value::Bool(false),
            _ => {
                return fail(format!(
                    "\"{raw}\" is not a boolean (expected true/false or 1/0)"
                ))
            }
        },
        Kind::Int32 => {
            let v = parse_integer(text, "int32")?;
            if v < i128::from(i32::MIN) || v > i128::from(i32::MAX) {
                return fail(format!("\"{raw}\" is out of range for int32"));
            }
            Value::Int(v as i32)
        }
        Kind::Int64 => {
            let v = parse_integer(text, "int64")?;
            if v < i128::from(i64::MIN) || v > i128::from(i64::MAX) {
                return fail(format!("\"{raw}\" is out of range for int64"));
            }
            Value::Long(v as i64)
        }
        Kind::UInt8 => Value::Int(unsigned(text, raw, 8)? as i32),
        Kind::UInt16 => Value::Int(unsigned(text, raw, 16)? as i32),
        // Stored in a signed 32-bit slot: a value above 2^31-1 wraps to negative
        // bits, which is exactly what the unsigned annotation tells a reader to
        // undo.
        Kind::UInt32 => Value::Int(unsigned(text, raw, 32)? as u32 as i32),
        Kind::UInt64 => Value::Long(unsigned(text, raw, 64)? as u64 as i64),
        Kind::Float => {
            let v = number(text, raw)?;
            // Rounded to what four bytes can actually hold, so the value in
            // memory is the value on disk — otherwise the column statistics
            // would describe numbers the file does not have.
            let rounded = v as f32;
            if !rounded.is_finite() {
                return fail(format!("\"{raw}\" is out of range for float"));
            }
            Value::Double(f64::from(rounded))
        }
        Kind::Float16 => {
            let rounded = plain::half_to_double(plain::half_bits(number(text, raw)?));
            if !rounded.is_finite() {
                return fail(format!("\"{raw}\" is out of range for float16"));
            }
            Value::Double(rounded)
        }
        Kind::Double => Value::Double(number(text, raw)?),
        Kind::Date => Value::Int(days(text)?),
        Kind::Timestamp => Value::Long(millis(text, raw)?),
        Kind::Decimal => Value::Long(decimal(text, ty.precision, ty.scale)?),
        Kind::Uuid => Value::Bytes(uuid(text)?),
        // Passed through untouched, surrounding spaces included.
        Kind::String | Kind::Enum | Kind::Json => Value::Text(raw.to_string()),
        Kind::List => return fail("cannot convert to a list"),
    };
    Ok(Some(value))
}

/// `^[+-]?\d+$`, then the digits.
///
/// `i128` rather than a big integer: it holds every value any declared type can,
/// and something longer is out of range for all of them — which is the same
/// answer, reached sooner.
fn parse_integer(text: &str, what: &str) -> Result<i128, ConvertError> {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return fail(format!("\"{text}\" is not an integer ({what})"));
    }
    text.parse::<i128>()
        .map_err(|_| ConvertError(format!("\"{text}\" is out of range for {what}")))
}

/// `^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`, by hand.
///
/// Rust's own parser accepts `inf`, `NaN` and `1_000`; JavaScript's `Number()`
/// does not, and the implementations have to refuse the same strings.
fn number(text: &str, raw: &str) -> Result<f64, ConvertError> {
    if !looks_numeric(text) {
        return fail(format!("\"{raw}\" is not a number"));
    }
    match text.parse::<f64>() {
        Ok(v) if v.is_finite() => Ok(v),
        _ => fail(format!("\"{raw}\" is not a number")),
    }
}

fn looks_numeric(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        None => (body, None),
        Some(at) => (&body[..at], Some(&body[at + 1..])),
    };

    // `\d+\.?\d*` or `\.\d+`
    let digits_ok = match mantissa.split_once('.') {
        None => !mantissa.is_empty() && mantissa.bytes().all(|b| b.is_ascii_digit()),
        Some((whole, fraction)) => {
            let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            if whole.is_empty() {
                !fraction.is_empty() && all_digits(fraction)
            } else {
                all_digits(whole) && all_digits(fraction)
            }
        }
    };
    if !digits_ok {
        return false;
    }

    match exponent {
        None => true,
        Some(exp) => {
            let digits = exp.strip_prefix(['+', '-']).unwrap_or(exp);
            !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

/// An unsigned integer of the given width, with negatives refused outright.
fn unsigned(text: &str, raw: &str, bits: u32) -> Result<i128, ConvertError> {
    let v = parse_integer(text, &format!("uint{bits}"))?;
    if v < 0 {
        return fail(format!("\"{raw}\" is negative, but the column is unsigned"));
    }
    let limit = (1i128 << bits) - 1;
    if v <= limit {
        Ok(v)
    } else {
        fail(format!("\"{raw}\" is out of range for uint{bits}"))
    }
}

/// Days since the epoch — how Parquet stores a date.
fn days(text: &str) -> Result<i32, ConvertError> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| bytes[*i].is_ascii_digit());
    if !shaped {
        return fail(format!("\"{text}\" is not a date (expected YYYY-MM-DD)"));
    }

    let year: i32 = text[0..4].parse().unwrap_or(0);
    let month: i32 = text[5..7].parse().unwrap_or(0);
    let day: i32 = text[8..10].parse().unwrap_or(0);
    if !(1..=12).contains(&month) || day < 1 || day > date::days_in_month(year, month) {
        return fail(format!("\"{text}\" is not a date (no such calendar day)"));
    }
    Ok(date::days_from_civil(year, month, day) as i32)
}

/// ISO-8601 to milliseconds since the epoch. A bare local timestamp is read as
/// UTC, as the reference does.
fn millis(text: &str, raw: &str) -> Result<i64, ConvertError> {
    date::parse::iso_millis(text)
        .ok_or_else(|| ConvertError(format!("\"{raw}\" is not a timestamp (expected ISO-8601)")))
}

/// A decimal as its unscaled integer — refusing anything the declared type
/// cannot hold.
fn decimal(text: &str, precision: i32, scale: i32) -> Result<i64, ConvertError> {
    let (sign, body) = match text.strip_prefix(['+', '-']) {
        Some(rest) => (if text.starts_with('-') { -1i128 } else { 1 }, rest),
        None => (1i128, text),
    };
    let (whole, fraction) = match body.split_once('.') {
        None => (body, ""),
        Some((w, f)) => (w, f),
    };
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || (!fraction.is_empty() && !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return fail(format!("\"{text}\" is not a decimal"));
    }

    if fraction.len() as i32 > scale {
        return fail(format!(
            "\"{text}\" has more decimal places than the declared scale {scale} — refusing to round"
        ));
    }

    let digits = format!(
        "{whole}{fraction}{}",
        "0".repeat((scale as usize) - fraction.len())
    );
    let significant = digits.trim_start_matches('0');
    if significant.len() as i32 > precision {
        return fail(format!(
            "\"{text}\" exceeds the declared precision {precision}"
        ));
    }

    let Ok(unscaled) = digits.parse::<i128>() else {
        return fail(format!("\"{text}\" does not fit a 64-bit decimal"));
    };
    let unscaled = sign * unscaled;
    if unscaled >= i128::from(i64::MIN) && unscaled <= i128::from(i64::MAX) {
        Ok(unscaled as i64)
    } else {
        fail(format!("\"{text}\" does not fit a 64-bit decimal"))
    }
}

fn uuid(text: &str) -> Result<Vec<u8>, ConvertError> {
    let hex: String = text.replace('-', "").to_lowercase();
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fail(format!("\"{text}\" is not a uuid"));
    }
    Ok((0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str, declared: &str) -> Result<Option<Value>, ConvertError> {
        of(
            text,
            &ColumnType::parse_output(declared).expect("a valid type"),
        )
    }

    #[test]
    fn a_value_that_cannot_be_held_exactly_is_refused_rather_than_rounded() {
        // The whole point of the layer. A dataset that quietly loses digits is
        // worse than one that refuses to be written.
        assert!(parse("1.234", "decimal(9,2)").is_err());
        assert!(parse("99999999999", "int32").is_err());
        assert!(parse("-1", "uint8").is_err());
        assert!(parse("256", "uint8").is_err());
        assert!(parse("2026-02-30", "date").is_err());
        assert!(parse("", "int64").is_err(), "empty needs |null");
    }

    #[test]
    fn a_decimal_is_stored_as_its_unscaled_integer() {
        assert_eq!(
            parse("12.34", "decimal(9,2)").unwrap(),
            Some(Value::Long(1234))
        );
        assert_eq!(
            parse("-0.07", "decimal(9,2)").unwrap(),
            Some(Value::Long(-7))
        );
        // Fewer places than the scale is padded, not refused.
        assert_eq!(parse("5", "decimal(9,2)").unwrap(), Some(Value::Long(500)));
    }

    #[test]
    fn a_date_is_days_since_the_epoch() {
        assert_eq!(parse("1970-01-01", "date").unwrap(), Some(Value::Int(0)));
        assert_eq!(
            parse("2000-01-01", "date").unwrap(),
            Some(Value::Int(10_957))
        );
    }

    #[test]
    fn a_timestamp_reads_its_offset() {
        // The same instant three ways: as UTC, as an offset, and bare.
        let utc = parse("2024-01-15T12:00:00Z", "timestamp").unwrap();
        let offset = parse("2024-01-15T14:00:00+02:00", "timestamp").unwrap();
        let bare = parse("2024-01-15T12:00:00", "timestamp").unwrap();
        assert_eq!(utc, offset, "an offset must be applied, not ignored");
        assert_eq!(utc, bare, "a bare timestamp is read as UTC");
        assert_eq!(utc, Some(Value::Long(1_705_320_000_000)));
    }

    #[test]
    fn a_number_is_refused_where_javascript_would_refuse_it() {
        // Rust's own parser takes all of these; `Number()` does not, and the
        // implementations have to agree on what is a number.
        for bad in ["inf", "NaN", "1_000", "0x10", "1,5", "--1", "1e", "."] {
            assert!(parse(bad, "double").is_err(), "{bad:?} should be refused");
        }
        for good in ["1", "-1.5", ".5", "2.", "1e3", "1E-3", "+7"] {
            assert!(parse(good, "double").is_ok(), "{good:?} should be a number");
        }
    }

    #[test]
    fn a_uuid_is_sixteen_bytes_however_it_was_written() {
        let dashed = parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "uuid").unwrap();
        let plain = parse("6BA7B8109DAD11D180B400C04FD430C8", "uuid").unwrap();
        assert_eq!(dashed, plain);
        let Some(Value::Bytes(bytes)) = dashed else {
            panic!("a uuid is bytes")
        };
        assert_eq!(bytes.len(), 16);
        assert_eq!(bytes[0], 0x6b);
    }

    #[test]
    fn null_is_only_possible_where_the_type_allows_it() {
        assert_eq!(parse("", "int64|null").unwrap(), None);
        assert!(parse("", "int64").is_err());
    }
}
