//! The named alphabets a config can ask for by name.
//!
//! Spelled out as explicit code-point ranges rather than looked up through
//! Unicode character properties. Property tables ship with the runtime and
//! change between versions of it, so a config that drew Cyrillic letters could
//! quietly draw a different set of them after an upgrade, and two languages'
//! runtimes would never agree. A range written here means the same thing
//! everywhere, forever.

pub mod char_set;

use std::collections::BTreeMap;
use std::sync::OnceLock;

/// Every code point from `start` to `end`, inclusive.
pub fn between(start: char, end: char) -> Vec<char> {
    assert!(start <= end, "invalid alphabet range");
    (start..=end).collect()
}

fn code_points(value: &str) -> Vec<char> {
    value.chars().collect()
}

/// The registry, keyed by name.
///
/// A `BTreeMap` here would sort the names, and the ORDER of an alphabet is what
/// a draw index means — so the lists themselves are built in order and only the
/// lookup is sorted. Nothing draws from the map.
fn registry() -> &'static BTreeMap<&'static str, Vec<char>> {
    static REGISTRY: OnceLock<BTreeMap<&'static str, Vec<char>>> = OnceLock::new();
    REGISTRY.get_or_init(build)
}

fn build() -> BTreeMap<&'static str, Vec<char>> {
    let latin_lower = between('a', 'z');
    let latin_upper = between('A', 'Z');
    let digits = between('0', '9');

    // Ё sits outside the alphabetical block in Unicode but inside it in the
    // alphabet, so it is spliced back into place rather than appended.
    let mut cyr_lower = between('а', 'е');
    cyr_lower.push('ё');
    cyr_lower.extend(between('ж', 'я'));
    let mut cyr_upper = between('А', 'Е');
    cyr_upper.push('Ё');
    cyr_upper.extend(between('Ж', 'Я'));

    let concat = |a: &[char], b: &[char]| -> Vec<char> {
        let mut out = a.to_vec();
        out.extend_from_slice(b);
        out
    };

    let mut map: BTreeMap<&'static str, Vec<char>> = BTreeMap::new();
    map.insert("latin.letters", concat(&latin_upper, &latin_lower));
    map.insert("latin.lower", latin_lower);
    map.insert("latin.upper", latin_upper);
    map.insert("digits.ascii", digits);
    map.insert("digits.fullwidth", between('０', '９'));
    map.insert("cyrillic.ru.letters", concat(&cyr_upper, &cyr_lower));
    map.insert("cyrillic.ru.lower", cyr_lower);
    map.insert("cyrillic.ru.upper", cyr_upper);
    map.insert(
        "greek.letters",
        code_points("ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω"),
    );
    map.insert("hebrew.letters", between('א', 'ת'));
    map.insert("arabic.letters", between('ء', 'ي'));
    map.insert("kana.hiragana", between('ぁ', 'ゖ'));
    map.insert("kana.katakana", between('ァ', 'ヺ'));
    map.insert("cjk.unified.basic", between('一', '鿿'));
    map.insert("roman.upper", code_points("IVXLCDM"));
    map.insert("roman.lower", code_points("ivxlcdm"));
    map
}

/// `None` when the name is unknown; callers report it with the list of known names.
pub fn chars(name: &str) -> Option<&'static [char]> {
    registry().get(name).map(Vec::as_slice)
}

pub fn names() -> Vec<&'static str> {
    registry().keys().copied().collect()
}
