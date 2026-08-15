//! Reads a `percent="..."` mask into one number per value.
//!
//! A mask does not have to be complete. Blank entries share whatever is left of
//! 100 evenly, so `percent="50"` across three values means "50, then split the
//! rest" rather than an error — which is what makes it usable when only one
//! share actually matters to the config.
//!
//! Where the blanks go depends on the mask: a leading comma pins the first entry
//! and pads after it, so `percent="10,,20"` and `percent=",20"` land differently
//! on purpose.

const TOLERANCE: f64 = 0.0001;

/// Which way a percent mask is wrong.
///
/// Three different mistakes, and each gets its own diagnostic code: a mask with
/// the wrong number of entries, one holding something that is not a share, and
/// one whose shares do not add up. They call for three different fixes, and one
/// code for all of them would say only that the mask is wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaskKind {
    Length,
    Number,
    Sum,
}

/// A percent mask that cannot be used, and the reason in a form a caller can
/// branch on.
#[derive(Clone, Debug)]
pub struct MaskError {
    pub message: String,
    pub kind: MaskKind,
}

impl std::fmt::Display for MaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MaskError {}

pub fn expand(mask: &str, value_count: usize) -> Result<Vec<f64>, MaskError> {
    if value_count == 0 {
        return Err(MaskError {
            message: "percent mask requires at least one value".to_string(),
            kind: MaskKind::Length,
        });
    }

    let parts = normalize(mask, value_count)?;

    let mut shares = vec![0f64; parts.len()];
    let mut blanks: Vec<usize> = Vec::new();
    let mut fixed_sum = 0f64;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            blanks.push(i);
            continue;
        }
        match part.parse::<f64>() {
            Ok(n) if n >= 0.0 && n.is_finite() => {
                shares[i] = n;
                fixed_sum += n;
            }
            _ => {
                return Err(MaskError {
                    message: "percent contains a non-numeric or negative value".to_string(),
                    kind: MaskKind::Number,
                })
            }
        }
    }

    if fixed_sum > 100.0 + TOLERANCE {
        return Err(MaskError {
            message: format!("percent values sum to {fixed_sum}, expected <= 100"),
            kind: MaskKind::Sum,
        });
    }

    if blanks.is_empty() {
        if (fixed_sum - 100.0).abs() > TOLERANCE {
            return Err(MaskError {
                message: format!("percent values sum to {fixed_sum}, expected 100"),
                kind: MaskKind::Sum,
            });
        }
        return Ok(shares);
    }

    let remainder = (100.0 - fixed_sum) / blanks.len() as f64;
    for idx in blanks {
        shares[idx] = remainder;
    }
    Ok(shares)
}

/// The positions the mask left for the engine to fill that came out at ZERO —
/// values that are declared and can never be drawn.
///
/// A mask shorter than the list is legal on purpose: what is left over goes to
/// the positions nobody wrote. `value="a,b,c" percent="30,40"` gives `c` the
/// remaining 30, which is the whole point. But when the written shares already
/// total 100 there is nothing left, and `c` silently stops existing — measured
/// over 300 rows: 150 `a`, 150 `b`, no `c`.
///
/// A zero the author WROTE is not reported: `percent="50,0,50"` says "never this
/// one" in as many words. Only an inferred zero is a surprise.
///
/// Call it after `expand` has succeeded — it assumes the parts parse.
pub fn inferred_zeros(mask: &str, value_count: usize) -> Vec<usize> {
    let Ok(parts) = normalize(mask, value_count) else {
        return Vec::new();
    };
    let blanks: Vec<usize> = parts
        .iter()
        .enumerate()
        .filter(|(_, part)| part.is_empty())
        .map(|(i, _)| i)
        .collect();
    if blanks.is_empty() {
        return Vec::new();
    }
    let written: f64 = parts
        .iter()
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<f64>().ok())
        .sum();
    if (100.0 - written) / blanks.len() as f64 > TOLERANCE {
        Vec::new()
    } else {
        blanks
    }
}

fn normalize(mask: &str, value_count: usize) -> Result<Vec<String>, MaskError> {
    let parts: Vec<String> = mask.split(',').map(|s| s.trim().to_string()).collect();
    if parts.len() > value_count {
        return Err(MaskError {
            message: format!(
                "percent has {} entries but value has {value_count}",
                parts.len()
            ),
            kind: MaskKind::Length,
        });
    }

    let missing = value_count - parts.len();
    if missing == 0 {
        return Ok(parts);
    }

    let mut result = Vec::with_capacity(value_count);
    if mask.trim_start().starts_with(',') {
        // A leading comma means the first entry is anchored and the padding
        // follows it.
        result.push(parts[0].clone());
        result.extend(std::iter::repeat(String::new()).take(missing));
        result.extend(parts.into_iter().skip(1));
    } else {
        result.extend(parts);
        result.extend(std::iter::repeat(String::new()).take(missing));
    }
    Ok(result)
}
