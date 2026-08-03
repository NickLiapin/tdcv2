//! `<gen type="date" .../>` and the `person.b_day` template behind it.
//!
//! A plan is built once from the attributes, then each value is one draw against
//! it. Two kinds: a fixed instant (`today`, `now`, a single date) that takes no
//! draw at all, and a range that takes exactly one.
//!
//! Precision decides what the draw is over — days, seconds or milliseconds — and
//! it is not cosmetic. A range drawn by day and the same range drawn by
//! millisecond both look like dates once formatted, and they disagree.

use std::collections::BTreeMap;

use super::{
    floor_div, format, from_epoch_day, from_epoch_millis, parse, subtract_utc_years, to_epoch_day,
    to_epoch_millis, PlainDateTime,
};
use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;

const DEFAULT_START: &str = "1970-01-01";
const DEFAULT_FORMAT: &str = "L";
const MS_PER_SECOND: i64 = 1000;

/// How finely the range is divided before a value is drawn from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Precision {
    Day,
    Second,
    Millisecond,
}

struct Plan {
    fixed: Option<PlainDateTime>,
    start: PlainDateTime,
    end: PlainDateTime,
    grain: Precision,
    format: String,
    locale: Option<String>,
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    locale: Option<&str>,
    now_millis: i64,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let plan = build_plan(attrs, locale, now_millis)?;
    format::check_format(&plan.format)?;
    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        let value = match plan.fixed {
            Some(fixed) => fixed,
            None => pick(&plan, prng),
        };
        result.push(format::format(
            value,
            Some(&plan.format),
            plan.locale.as_deref(),
        ));
    }
    Ok(result)
}

/// One value for `person.b_day`, which is a date generator wearing a template's
/// name.
pub fn birth_day(
    attrs: &BTreeMap<String, String>,
    locale: Option<&str>,
    now_millis: i64,
    prng: &mut Sfc32,
) -> EngineResult<String> {
    Ok(generate(&birth_attrs(attrs), locale, now_millis, 1, prng)?.remove(0))
}

/// `date.range` — a date generator addressed as a pack path, taking the older
/// `range="1990.01.01 - 2000.12.31"` spelling.
///
/// It is the `date` generator underneath, so the bounds are rewritten into the
/// form that generator reads rather than a second implementation being kept in
/// step with the first.
pub fn legacy_range(
    attrs: &BTreeMap<String, String>,
    locale: Option<&str>,
    now_millis: i64,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let raw = attrs.get("range").map(String::as_str).unwrap_or("");
    let Ok(range) = parse::legacy_range(raw) else {
        return invalid(&format!("date.range: invalid range attribute \"{raw}\""));
    };

    let mut rewritten = BTreeMap::new();
    rewritten.insert("from".to_string(), serialize(range.start.value));
    rewritten.insert("to".to_string(), serialize(range.end.value));
    rewritten.insert(
        "precision".to_string(),
        attrs
            .get("precision")
            .cloned()
            .unwrap_or_else(|| "day".to_string()),
    );
    copy(attrs, &mut rewritten, "format");
    copy(attrs, &mut rewritten, "local");
    generate(&rewritten, locale, now_millis, count, prng)
}

fn serialize(v: PlainDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}",
        v.year, v.month, v.day, v.hour, v.minute, v.second, v.millisecond
    )
}

/// `person.b_day` reaches the date generator with `value="birth"` and an
/// explicit millisecond precision.
///
/// The precision looks redundant next to a birth range measured in years, and it
/// is not: it is what the reference passes, so it is what decides the day.
fn birth_attrs(attrs: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    result.insert("value".to_string(), "birth".to_string());
    result.insert(
        "precision".to_string(),
        attrs
            .get("precision")
            .cloned()
            .unwrap_or_else(|| "millisecond".to_string()),
    );
    for key in ["oldest", "youngest", "format", "local"] {
        copy(attrs, &mut result, key);
    }
    result
}

fn copy(from: &BTreeMap<String, String>, to: &mut BTreeMap<String, String>, key: &str) {
    if let Some(value) = from.get(key) {
        to.insert(key.to_string(), value.clone());
    }
}

fn build_plan(
    attrs: &BTreeMap<String, String>,
    locale: Option<&str>,
    now_millis: i64,
) -> EngineResult<Plan> {
    let format = attrs
        .get("format")
        .cloned()
        .unwrap_or_else(|| DEFAULT_FORMAT.to_string());
    let loc = match attrs.get("local") {
        Some(own) => Some(own.clone()),
        None => locale.map(str::to_string),
    };
    let value = attrs.get("value").map(|v| v.trim());
    let precision = attrs.get("precision").map(String::as_str);

    if value == Some("today") {
        return Ok(fixed(
            from_epoch_millis(now_millis).start_of_day(),
            parse_precision(precision, Precision::Day)?,
            format,
            loc,
        ));
    }

    if value == Some("now") {
        return Ok(fixed(
            from_epoch_millis(now_millis),
            parse_precision(precision, Precision::Millisecond)?,
            format,
            loc,
        ));
    }

    if value == Some("birth") {
        let oldest = age(attrs.get("oldest"), 80, "oldest")?;
        let youngest = age(attrs.get("youngest"), 10, "youngest")?;
        if youngest > oldest {
            return invalid("date generator: youngest must be less than or equal to oldest");
        }
        // The default is by DAY even though `person.b_day` asks for
        // milliseconds: the fallback belongs to `value="birth"` written out in a
        // config, and the template overrides it.
        return range_plan(
            from_epoch_millis(subtract_utc_years(now_millis, oldest)),
            from_epoch_millis(subtract_utc_years(now_millis, youngest)),
            precision,
            Precision::Day,
            format,
            loc,
        );
    }

    let from = attrs.get("from");
    let to = attrs.get("to");
    if from.is_some() || to.is_some() {
        let (Some(from), Some(to)) = (from, to) else {
            return invalid("date generator: \"from\" and \"to\" must be provided together");
        };
        return range_of(
            parse::date_time(from)?,
            parse::date_time(to)?,
            precision,
            format,
            loc,
        );
    }

    if let Some(raw) = attrs.get("range") {
        let parsed = parse::range(raw)?;
        return range_of(parsed.start, parsed.end, precision, format, loc);
    }

    if let Some(value) = value.filter(|v| !v.is_empty()) {
        if value.contains("..") {
            let parsed = parse::range(value)?;
            return range_of(parsed.start, parsed.end, precision, format, loc);
        }
        let one = parse::date_time(value)?;
        return Ok(fixed(
            one.value,
            parse_precision(
                precision,
                if one.has_time {
                    Precision::Millisecond
                } else {
                    Precision::Day
                },
            )?,
            format,
            loc,
        ));
    }

    // Nothing specified at all: the epoch up to right now. The upper bound carries
    // a time, but the fallback precision is still whole days — an unbounded
    // generator answers with a date, not a timestamp at 03:47. Routing this
    // through `range_of` let `has_time` pick Millisecond, and a millisecond draw
    // lands a day away from the reference's day draw often enough to fail.
    range_plan(
        parse::date_time(DEFAULT_START)?.value,
        from_epoch_millis(now_millis),
        precision,
        Precision::Day,
        format,
        loc,
    )
}

fn fixed(value: PlainDateTime, grain: Precision, format: String, locale: Option<String>) -> Plan {
    Plan {
        fixed: Some(value),
        start: PlainDateTime::default(),
        end: PlainDateTime::default(),
        grain,
        format,
        locale,
    }
}

fn range_of(
    start: parse::Parsed,
    end: parse::Parsed,
    precision: Option<&str>,
    format: String,
    locale: Option<String>,
) -> EngineResult<Plan> {
    // When neither bound carried a time, the range is over whole days — which is
    // why `range="2026-01-01..2026-01-31"` yields dates and not timestamps at
    // 03:47.
    let fallback = if start.has_time || end.has_time {
        Precision::Millisecond
    } else {
        Precision::Day
    };
    range_plan(start.value, end.value, precision, fallback, format, locale)
}

fn range_plan(
    start: PlainDateTime,
    end: PlainDateTime,
    precision: Option<&str>,
    fallback: Precision,
    format: String,
    locale: Option<String>,
) -> EngineResult<Plan> {
    Ok(Plan {
        fixed: None,
        start,
        end,
        grain: parse_precision(precision, fallback)?,
        format,
        locale,
    })
}

fn pick(plan: &Plan, prng: &mut Sfc32) -> PlainDateTime {
    if plan.grain == Precision::Day {
        let a = to_epoch_day(plan.start);
        let b = to_epoch_day(plan.end);
        return from_epoch_day(inclusive(prng, a.min(b), a.max(b)));
    }

    let divisor = if plan.grain == Precision::Second {
        MS_PER_SECOND
    } else {
        1
    };
    let lo = floor_div(to_epoch_millis(plan.start), divisor);
    let hi = floor_div(to_epoch_millis(plan.end), divisor);
    from_epoch_millis(inclusive(prng, lo.min(hi), lo.max(hi)) * divisor)
}

/// One draw, inclusive of both ends.
fn inclusive(prng: &mut Sfc32, min: i64, max: i64) -> i64 {
    (prng.next() * (max - min + 1) as f64 + min as f64).floor() as i64
}

pub fn parse_precision(raw: Option<&str>, fallback: Precision) -> EngineResult<Precision> {
    match raw {
        None => Ok(fallback),
        Some("day") => Ok(Precision::Day),
        Some("second") => Ok(Precision::Second),
        Some("millisecond") => Ok(Precision::Millisecond),
        Some(other) => invalid(&format!(
            "date generator: unsupported precision \"{other}\" \
             (supported: day, second, millisecond)"
        )),
    }
}

/// The birth ages, checked without generating anything.
///
/// Whole numbers in a plausible range, and the older bound actually older — a
/// config that has them the wrong way round asks for an empty span and gets no
/// dates at all.
pub fn check_birth_ages(attrs: &BTreeMap<String, String>) -> EngineResult<()> {
    let oldest = age(attrs.get("oldest"), 80, "oldest")?;
    let youngest = age(attrs.get("youngest"), 10, "youngest")?;
    if youngest > oldest {
        return invalid("date generator: youngest must be less than or equal to oldest");
    }
    Ok(())
}

fn age(raw: Option<&String>, fallback: i32, name: &str) -> EngineResult<i32> {
    let Some(raw) = raw else {
        return Ok(fallback);
    };
    match raw.trim().parse::<i32>() {
        Ok(value) if (0..=150).contains(&value) => Ok(value),
        _ => invalid(&format!(
            "date generator: {name} must be an integer from 0 to 150"
        )),
    }
}
