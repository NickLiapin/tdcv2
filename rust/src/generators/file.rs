//! `<gen type="file" src="./products.txt"/>` — values from the user's own file.
//!
//! Two shapes. A plain list is one value per line, blanks skipped. With
//! `column=` the file is read as CSV and one column is taken from it — by header
//! name, or by 1-based position when the column is written as a number.
//!
//! This is how a run gets the real thing: the actual product catalogue, the
//! actual list of branch codes. Generated data is only as convincing as the
//! vocabulary it draws from, and no bundled pack knows one particular company's
//! part numbers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::rand;
use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;

/// The prefix that says "look in the configured data folders, not next to the
/// config".
pub const DATA_ALIAS: &str = "@data/";

/// Values and their shares, when `weight="countColumn"` names a second column.
///
/// Without it a list is drawn uniformly, so `Smith` and `Zabrowski` turn up
/// equally often. Real distributions are never flat — the commonest surnames
/// cover a large part of a population and the tail is vanishingly rare — and
/// flattening that is the first thing anyone looking at the data notices.
///
/// The shares are honoured exactly, through the same apportionment `percent=`
/// uses: weights of 20000 and 10000 over 30000 rows give precisely 20000 and
/// 10000, not "about twice as many". A weight is a raw count, not a percentage,
/// because census and registry files publish counts and normalising them by hand
/// is a pointless invitation to arithmetic errors.
#[derive(Clone, Debug)]
pub struct Weighted {
    pub values: Vec<String>,
    pub percents: Vec<f64>,
}

/// A CSV read as whole rows, for `row="key"`.
///
/// Several sequences naming the same key read different columns of the *same*
/// row, so a generated city and its postcode come from one real record rather
/// than from two unrelated ones. Without it, drawing a city and a postcode
/// independently produces pairs that no validator and no human would accept.
#[derive(Clone, Debug)]
pub struct RowSource {
    pub rows: Vec<Vec<String>>,
    pub header: Vec<String>,
    pub column_index: usize,
    /// Two sequences on one key must be reading one file; this identifies which.
    pub source_key: String,
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    base_dir: Option<&str>,
    roots: &[String],
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let values = load(attrs, base_dir, roots)?;
    Ok((0..count).map(|_| rand::pick(prng, &values)).collect())
}

/// `None` when the generator is not weighted, which is the ordinary case.
pub fn load_weighted(
    attrs: &BTreeMap<String, String>,
    base_dir: Option<&str>,
    roots: &[String],
) -> EngineResult<Option<Weighted>> {
    let Some(weight_column) = trim_to_none(attrs.get("weight")) else {
        return Ok(None);
    };
    let Some(column) = trim_to_none(attrs.get("column")) else {
        return invalid(&format!(
            "file generator: weight=\"{weight_column}\" needs a \"column\" to weight"
        ));
    };

    let path = resolve(attrs.get("src").map_or("", |s| s.trim()), base_dir, roots)?;
    let delimiter = parse_delimiter(attrs.get("delimiter").map(String::as_str))?;
    let rows = non_blank_rows(&read(&path)?, delimiter)?;
    if rows.is_empty() {
        return invalid(&format!("file generator: CSV file at \"{path}\" is empty"));
    }

    let value_index = column_index(&rows[0], column)?;
    let weight_index = column_index(&rows[0], weight_column)?;
    if weight_index == value_index {
        return invalid(&format!(
            "file generator: weight column \"{weight_column}\" is the same column as the values"
        ));
    }

    let mut values = Vec::new();
    let mut counts: Vec<f64> = Vec::new();
    let mut total = 0.0;
    for row in rows.iter().skip(1) {
        let value = cell(row, value_index);
        if value.is_empty() {
            continue;
        }
        let weight = parse_weight(&cell(row, weight_index), &value, weight_column)?;
        // A zero weight means never drawn, so carrying it costs memory and buys
        // nothing.
        if weight == 0.0 {
            continue;
        }
        values.push(value);
        counts.push(weight);
        total += weight;
    }

    if values.is_empty() {
        return invalid(&format!(
            "file generator: no values with a positive weight in column \"{weight_column}\""
        ));
    }
    Ok(Some(Weighted {
        values,
        percents: counts.iter().map(|c| c / total * 100.0).collect(),
    }))
}

pub fn load_rows(
    attrs: &BTreeMap<String, String>,
    base_dir: Option<&str>,
    roots: &[String],
) -> EngineResult<RowSource> {
    let Some(column) = trim_to_none(attrs.get("column")) else {
        return invalid("sequence: row-linked file generator requires a CSV \"column\" attribute");
    };

    let src = attrs.get("src").map_or("", |s| s.trim()).to_string();
    let path = resolve(&src, base_dir, roots)?;
    let delimiter = parse_delimiter(attrs.get("delimiter").map(String::as_str))?;

    let all = non_blank_rows(&read(&path)?, delimiter)?;
    if all.is_empty() {
        return invalid(&format!("file generator: CSV file at \"{src}\" is empty"));
    }

    let index = column_index(&all[0], column)?;
    // A named column implies a header row; a numbered one only skips it when
    // told to, because a file of pure data has no header to skip.
    let skip_header = parse_header_flag(attrs.get("header"))? || !is_numbered(column);
    let rows: Vec<Vec<String>> = if skip_header {
        all[1..].to_vec()
    } else {
        all.clone()
    };

    if rows.is_empty() {
        return invalid(&format!(
            "file generator: CSV file at \"{src}\" has no data rows"
        ));
    }
    if !rows.iter().any(|row| !cell(row, index).is_empty()) {
        return invalid(&format!(
            "file generator: CSV column \"{column}\" at \"{src}\" has no values"
        ));
    }

    // The header is kept: `rows` may have had it stripped, so a second column
    // named later — a weight column — has to be resolved against the original.
    Ok(RowSource {
        header: all[0].clone(),
        rows,
        column_index: index,
        source_key: format!("{path}|{delimiter}|{skip_header}"),
    })
}

/// One row's cell in the linked column, trimmed and never absent.
pub fn cell_at(source: &RowSource, row_index: usize) -> String {
    source
        .rows
        .get(row_index)
        .map(|row| cell(row, source.column_index))
        .unwrap_or_default()
}

/// Row indexes drawn to the exact quota of a weight column — the row-linked
/// counterpart of [`load_weighted`], so every field on the link follows the same
/// weighted rows.
pub fn weighted_rows(
    attrs: &BTreeMap<String, String>,
    source: &RowSource,
) -> EngineResult<Option<Weighted>> {
    let Some(weight_column) = trim_to_none(attrs.get("weight")) else {
        return Ok(None);
    };
    let weight_index = column_index(&source.header, weight_column)?;
    if weight_index == source.column_index {
        return invalid(&format!(
            "file generator: weight column \"{weight_column}\" is the same column as the values"
        ));
    }

    let mut indexes = Vec::new();
    let mut counts: Vec<f64> = Vec::new();
    let mut total = 0.0;
    for (i, row) in source.rows.iter().enumerate() {
        let value = cell_at(source, i);
        if value.is_empty() {
            continue;
        }
        let weight = parse_weight(&cell(row, weight_index), &value, weight_column)?;
        if weight == 0.0 {
            continue;
        }
        indexes.push(i.to_string());
        counts.push(weight);
        total += weight;
    }

    if indexes.is_empty() {
        return invalid(&format!(
            "file generator: weight column \"{weight_column}\" has no rows with a positive weight"
        ));
    }
    Ok(Some(Weighted {
        values: indexes,
        percents: counts.iter().map(|c| c / total * 100.0).collect(),
    }))
}

/// The file's values in file order — what `order="sequential"` reads.
pub fn load(
    attrs: &BTreeMap<String, String>,
    base_dir: Option<&str>,
    roots: &[String],
) -> EngineResult<Vec<String>> {
    let Some(src) = trim_to_none(attrs.get("src")) else {
        return invalid("file generator: \"src\" is required");
    };

    let path = resolve(src, base_dir, roots)?;
    let content = read(&path)?;

    let column = trim_to_none(attrs.get("column"));
    if attrs.contains_key("column") && column.is_none() {
        return invalid("file generator: column must not be empty");
    }

    let values = match column {
        None => list_values(&content),
        Some(column) => csv_column(&content, column, attrs, &path)?,
    };
    if values.is_empty() {
        return invalid(&format!("file generator: list at \"{path}\" is empty"));
    }
    Ok(values)
}

/// Where a `src=` points, in the order the reference implementation looks.
///
/// A plain relative path means the file next to the CONFIG, not next to whatever
/// directory the program happened to be started from — otherwise the same config
/// would work from one shell and fail from another. When it is not there, the
/// configured data folders are tried, so a config can be moved without rewriting
/// every source.
///
/// `@data/x.txt` skips the config's folder entirely and names the data folders
/// outright. That is what makes a config portable between machines whose data
/// lives in different places: the path in the config stays the same and only the
/// configured data folders differ. With no data folder configured at all the
/// alias cannot mean anything, and saying so is better than reporting a missing
/// file.
///
/// `pkg:` is deliberately absent. It resolves through `node_modules`, which
/// exists in one of the five runtimes; an implementation pretending to support
/// it would be guessing.
pub fn resolve(src: &str, base_dir: Option<&str>, roots: &[String]) -> EngineResult<String> {
    let text = src.trim();

    if let Some(rest) = text.strip_prefix("file://") {
        return Ok(rest.to_string());
    }

    if let Some(alias) = text.strip_prefix(DATA_ALIAS) {
        let alias = alias.trim();
        if alias.is_empty() {
            return invalid("file generator: @data source path must not be empty");
        }
        if roots.is_empty() {
            return invalid(
                "file generator: \"@data/...\" needs at least one data folder — pass a data path, \
                 or name one in tdcv2.config.json",
            );
        }
        let attempts: Vec<String> = roots
            .iter()
            .map(|root| normalize(&Path::new(root).join(alias)))
            .collect();
        return Ok(first_readable(&attempts));
    }

    if Path::new(text).is_absolute() {
        return Ok(text.to_string());
    }

    let beside = match base_dir {
        None => text.to_string(),
        Some(dir) => normalize(&Path::new(dir).join(text)),
    };
    if Path::new(&beside).is_file() || roots.is_empty() {
        return Ok(beside);
    }

    let mut attempts = vec![beside];
    attempts.extend(
        roots
            .iter()
            .map(|root| normalize(&Path::new(root).join(text))),
    );
    Ok(first_readable(&attempts))
}

/// Absolute, with `.` and `..` folded away — without touching the filesystem, so
/// a path that does not exist still normalises and the error names something
/// readable.
fn normalize(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };

    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    let mut out = PathBuf::new();
    for part in parts {
        out.push(part);
    }
    out.to_string_lossy().to_string()
}

/// The first candidate that exists, or the first tried so the error names
/// something real.
fn first_readable(attempts: &[String]) -> String {
    attempts
        .iter()
        .find(|p| Path::new(p).is_file())
        .cloned()
        .unwrap_or_else(|| attempts[0].clone())
}

fn read(path: &str) -> EngineResult<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(_) => invalid(&format!("file generator: cannot read \"{path}\"")),
    }
}

fn list_values(content: &str) -> Vec<String> {
    content
        .split('\n')
        .map(|line| line.trim_end_matches('\r').trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn non_blank_rows(content: &str, delimiter: char) -> EngineResult<Vec<Vec<String>>> {
    Ok(parse_rows(content, delimiter)?
        .into_iter()
        .filter(|row| row.iter().any(|c| !c.trim().is_empty()))
        .collect())
}

fn cell(row: &[String], index: usize) -> String {
    row.get(index)
        .map(|c| c.trim().to_string())
        .unwrap_or_default()
}

fn csv_column(
    content: &str,
    column: &str,
    attrs: &BTreeMap<String, String>,
    path: &str,
) -> EngineResult<Vec<String>> {
    let delimiter = parse_delimiter(attrs.get("delimiter").map(String::as_str))?;
    let rows = non_blank_rows(content, delimiter)?;
    if rows.is_empty() {
        return invalid(&format!("file generator: CSV file at \"{path}\" is empty"));
    }

    let index = column_index(&rows[0], column)?;
    // A named column implies a header row; a numbered one only skips it when
    // told to, because a file of pure data has no header to skip.
    let skip_header = parse_header_flag(attrs.get("header"))? || !is_numbered(column);

    let values: Vec<String> = rows
        .iter()
        .skip(usize::from(skip_header))
        .map(|row| cell(row, index))
        .filter(|c| !c.is_empty())
        .collect();

    if values.is_empty() {
        return invalid(&format!(
            "file generator: CSV column \"{column}\" at \"{path}\" has no values"
        ));
    }
    Ok(values)
}

fn column_index(header_row: &[String], column: &str) -> EngineResult<usize> {
    if is_numbered(column) {
        return Ok(column.parse::<usize>().unwrap_or(1) - 1);
    }
    for (i, head) in header_row.iter().enumerate() {
        // Stripping the byte-order mark matters more than the stray spaces:
        // Excel writes one ahead of the first header cell, so without this every
        // "Save as CSV" export would fail to resolve its first column by name and
        // no other.
        if head.replace('\u{feff}', "").trim() == column {
            return Ok(i);
        }
    }
    invalid(&format!(
        "file generator: CSV column \"{column}\" was not found in the header row"
    ))
}

/// `^[1-9][0-9]*$`
fn is_numbered(column: &str) -> bool {
    let bytes = column.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_digit()
        && bytes[0] != b'0'
        && bytes.iter().all(u8::is_ascii_digit)
}

/// RFC 4180: quoted fields, doubled quotes inside them, and either line ending.
pub fn parse_rows(content: &str, delimiter: char) -> EngineResult<Vec<Vec<String>>> {
    let chars: Vec<char> = content.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut quoted_field = false;

    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            i += 1;
            continue;
        }

        if ch == '"' && field.is_empty() && !quoted_field {
            in_quotes = true;
            quoted_field = true;
        } else if ch == delimiter {
            row.push(std::mem::take(&mut field));
            quoted_field = false;
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut field));
            quoted_field = false;
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(ch);
        }
        i += 1;
    }

    if in_quotes {
        return invalid("file generator: unterminated quoted CSV field");
    }
    if !field.is_empty() || !row.is_empty() || !content.ends_with('\n') {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

pub fn parse_delimiter(value: Option<&str>) -> EngineResult<char> {
    let Some(value) = value else {
        return Ok(',');
    };
    // A single character is taken as written, tab included, so that resolving
    // twice is harmless: trimming a real tab would leave nothing and fall back to
    // a comma.
    let mut chars = value.chars();
    if let (Some(only), None) = (chars.next(), chars.next()) {
        return Ok(only);
    }

    let normalized = value.trim();
    if normalized.is_empty() {
        return Ok(',');
    }
    let resolved = match normalized.to_lowercase().as_str() {
        "comma" => ",".to_string(),
        "semicolon" => ";".to_string(),
        "tab" | "\\t" => "\t".to_string(),
        "pipe" => "|".to_string(),
        _ => normalized.to_string(),
    };
    let mut chars = resolved.chars();
    match (chars.next(), chars.next()) {
        (Some(only), None) => Ok(only),
        _ => invalid("file generator: delimiter must be one character"),
    }
}

fn parse_weight(raw: &str, value: &str, weight_column: &str) -> EngineResult<f64> {
    // A blank cell must not slide through as a weight of zero, which would
    // delete the value from the run. A product vanishing from a catalogue
    // because one cell of an export was empty is discovered far too late — and
    // missing data and a deliberate zero are different statements, only one of
    // which is actionable.
    if raw.is_empty() {
        return invalid(&format!(
            "file generator: weight column \"{weight_column}\" is empty for value \"{value}\" — \
             write 0 to exclude it, or fill in the count"
        ));
    }
    match raw.parse::<f64>() {
        Ok(w) if w.is_finite() && w >= 0.0 => Ok(w),
        _ => invalid(&format!(
            "file generator: weight \"{raw}\" for value \"{value}\" is not a non-negative number"
        )),
    }
}

fn parse_header_flag(value: Option<&String>) -> EngineResult<bool> {
    match value.map(|v| v.trim().to_lowercase()) {
        None => Ok(false),
        Some(text) if text == "true" || text == "1" => Ok(true),
        Some(text) if text == "false" || text == "0" => Ok(false),
        _ => invalid("file generator: header must be true or false"),
    }
}

fn trim_to_none(value: Option<&String>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
