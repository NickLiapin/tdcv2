//! A byte count written the way a person would say it: `800 B`, `2.6 KB`,
//! `123 KB`, `20.5 GB`.
//!
//! ## Why this exists
//!
//! Every one of the 294 shipped packs is smaller than a quarter of a megabyte —
//! the largest is 248 KB and 120 are under 10 KB. Printed in megabytes to one
//! decimal, as `pack list` did, the whole catalogue collapsed into three
//! strings: `0.0 MB` for 194 packs, `0.1 MB` for 53, `0.2 MB` for the last 47.
//!
//! A size that cannot tell two packs apart is not a size, it is a decoration;
//! and `0.0` actively misinforms, because it reads as "nothing" when the honest
//! answer is "three kilobytes".
//!
//! The rules are the ones people already read without noticing:
//!
//! - below a kilobyte, whole bytes — `800 B`, never `0.8 KB`
//! - below a hundred of a unit, one decimal — `2.6 KB` distinguishes packs that
//!   `3 KB` does not
//! - at a hundred and above, whole numbers — `123 KB`, because a tenth of a
//!   kilobyte there is noise
//!
//! ## Why the arithmetic looks like this
//!
//! All five implementations must produce the same string for the same number:
//! a shared CLI fixture compares their output byte for byte, so a size that
//! differs in the last digit is a five-way parity failure. Hence integers
//! throughout — no float division, no format-width rounding, and no reliance on
//! how a language happens to round a half.

/// Kilobyte upwards. Terabytes are the end of it; nothing here measures more.
const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];

/// `round(n * 10 / d)`, without ever forming `n * 10`.
///
/// The product overflows an `i64` above about 800 petabytes. Splitting the
/// division is exact for every size any of the five will be handed.
fn tenths(n: i64, d: i64) -> i64 {
    let whole = n / d;
    let rest = n - whole * d;
    whole * 10 + (rest * 10 + d / 2) / d
}

pub fn human_bytes(bytes: i64) -> String {
    if bytes <= 0 {
        return "0 B".to_string();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }

    // Climb to the unit the number reads in, and one further when rounding has
    // pushed it to a whole 1024 of that unit — 1023.6 KB is 1.0 MB, and nobody
    // writes the other one.
    let mut d: i64 = 1024;
    let mut unit = UNITS[0];
    let mut t = tenths(bytes, d);
    for next in UNITS.iter().skip(1) {
        if bytes < d * 1024 && t < 10_235 {
            break;
        }
        d *= 1024;
        unit = next;
        t = tenths(bytes, d);
    }
    if t < 1000 {
        format!("{}.{} {unit}", t / 10, t % 10)
    } else {
        format!("{} {unit}", (t + 5) / 10)
    }
}

#[cfg(test)]
mod tests {
    use super::human_bytes;

    /// The case that started this: below a kilobyte there IS no sensible
    /// fraction, so the unit has to change instead of the precision.
    #[test]
    fn says_bytes_in_bytes() {
        assert_eq!(human_bytes(1), "1 B");
        assert_eq!(human_bytes(800), "800 B");
        assert_eq!(human_bytes(1023), "1023 B");
    }

    #[test]
    fn never_prints_zero_point_zero_for_a_file_that_exists() {
        for n in [1, 9, 99, 512, 1024, 2710, 9999] {
            assert!(!human_bytes(n).starts_with("0.0"), "{n}");
        }
    }

    #[test]
    fn keeps_a_decimal_below_a_hundred() {
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(2710), "2.6 KB"); // the smallest shipped pack
        assert_eq!(human_bytes(10_240), "10.0 KB");
        assert_eq!(human_bytes(99_000), "96.7 KB");
    }

    #[test]
    fn drops_the_decimal_at_a_hundred() {
        assert_eq!(human_bytes(102_400), "100 KB");
        assert_eq!(human_bytes(253_515), "248 KB"); // the largest shipped pack
    }

    #[test]
    fn climbs_a_unit_when_it_should() {
        assert_eq!(human_bytes(1_048_576), "1.0 MB");
        assert_eq!(human_bytes(1_572_864), "1.5 MB");
        assert_eq!(human_bytes(1_073_741_824), "1.0 GB");
        assert_eq!(human_bytes(34_359_738_368), "32.0 GB");
        assert_eq!(human_bytes(1_099_511_627_776), "1.0 TB");
    }

    /// 1023.999 KB rounds to a whole 1024 KB, which nobody writes.
    #[test]
    fn promotes_rather_than_printing_1024_of_a_unit() {
        assert_eq!(human_bytes(1_073_741_823), "1.0 GB");
        assert_eq!(human_bytes(1_048_575), "1.0 MB");
    }

    #[test]
    fn answers_a_nonsense_number_instead_of_panicking() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(-1), "0 B");
    }
}
