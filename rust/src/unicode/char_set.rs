//! The inline character set behind `<gen type="symbol" value="…">`.
//!
//! Grammar: `[X-Y]` is an inclusive code-point range, every other character
//! stands for itself, and commas and spaces *outside* brackets are ignored so a
//! long set can be written with breathing room. To include a comma or a space,
//! bracket it: `[,]`, `[ ]`. A hyphen at either end of a group is a literal
//! hyphen.
//!
//! It exists so that picking one of a handful of symbols does not require a
//! regular expression. The result keeps first-seen order and drops duplicates —
//! order matters because the set is indexed by a random draw, so two
//! implementations that ordered it differently would produce different
//! characters from the same seed.

use std::collections::BTreeSet;

use crate::engine::{invalid, EngineResult};

pub fn parse(spec: &str) -> EngineResult<Vec<char>> {
    let chars: Vec<char> = spec.chars().collect();
    let mut result: Vec<char> = Vec::new();
    let mut seen: BTreeSet<char> = BTreeSet::new();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '[' {
            let Some(end) = chars[i + 1..]
                .iter()
                .position(|x| *x == ']')
                .map(|p| p + i + 1)
            else {
                return invalid(&format!("character set: unterminated \"[\" in \"{spec}\""));
            };
            expand_group(&chars[i + 1..end], &mut result, &mut seen, spec)?;
            i = end + 1;
            continue;
        }
        if c == ',' || is_separator(c) {
            i += 1;
            continue;
        }
        add(&mut result, &mut seen, c);
        i += 1;
    }

    Ok(result)
}

fn expand_group(
    group: &[char],
    result: &mut Vec<char>,
    seen: &mut BTreeSet<char>,
    spec: &str,
) -> EngineResult<()> {
    let mut j = 0usize;
    while j < group.len() {
        let c = group[j];
        // A range needs all three tokens present, so a leading or trailing "-"
        // stays literal.
        if j + 2 < group.len() && group[j + 1] == '-' {
            let lo = c as u32;
            let hi = group[j + 2] as u32;
            if hi < lo {
                return invalid(&format!(
                    "character set: reversed range \"{c}-{}\" in \"{spec}\"",
                    group[j + 2]
                ));
            }
            for cp in lo..=hi {
                if let Some(ch) = char::from_u32(cp) {
                    add(result, seen, ch);
                }
            }
            j += 3;
            continue;
        }
        add(result, seen, c);
        j += 1;
    }
    Ok(())
}

fn add(result: &mut Vec<char>, seen: &mut BTreeSet<char>, c: char) {
    if seen.insert(c) {
        result.push(c);
    }
}

fn is_separator(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}
