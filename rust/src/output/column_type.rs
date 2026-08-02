//! The declared type of an output column: `type="int64"`, `type="double|null"`,
//! `type="decimal(18,2)|null"` on a named `<data>`.
//!
//! Every text output is a string, which means whoever reads the file has to
//! guess all over again which column is a number and which only looks like one —
//! and guesses wrong, turning `007` into `7`. A declared type says it once, in
//! the config, where the person who knows the answer is already writing.
//!
//! Only parsing lives here. What a type becomes on disk belongs to the writer,
//! so a second format could reuse this without inheriting Parquet's opinions.

/// Everything a column may be declared as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Int32,
    Int64,
    // Unsigned integers store the same bytes and are annotated so a reader knows
    // the top bit is magnitude rather than sign.
    UInt8,
    UInt16,
    UInt32,
    UInt64,
    Float,
    Float16,
    Double,
    String,
    Enum,
    Date,
    Timestamp,
    Decimal,
    Uuid,
    Json,
    /// A list of the element type — `type="[]int64"`.
    List,
}

/// The widest decimal an int64 can hold; 10^19 overflows a signed 64-bit
/// integer.
const MAX_DECIMAL_PRECISION: i32 = 18;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnType {
    pub kind: Kind,
    /// `|null` — the column may hold a real NULL rather than an empty string.
    pub nullable: bool,
    /// decimal only: total digits.
    pub precision: i32,
    /// decimal only: digits after the point.
    pub scale: i32,
    /// A list's element type, or `None` when this is not a list.
    pub element: Option<Box<ColumnType>>,
}

/// A type declaration that cannot be read, said the way the person who wrote it
/// would want to hear it.
#[derive(Clone, Debug)]
pub struct TypeError(pub String);

impl std::fmt::Display for TypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(what: impl Into<String>) -> Result<T, TypeError> {
    Err(TypeError(what.into()))
}

impl ColumnType {
    pub fn is_list(&self) -> bool {
        self.kind == Kind::List
    }

    /// Parse a `type="…"` that may be a list.
    ///
    /// In `[]int64|null` the `|null` binds to the ELEMENT — read left to right,
    /// "a list of (int64 or nothing)". That is what `missing=` on a repeating
    /// generator needs: it blanks individual elements, never the list itself.
    /// There is no nullable list, because an empty cell is an empty list and
    /// there is no way to say "no list at all".
    pub fn parse_output(raw: &str) -> Result<ColumnType, TypeError> {
        let text = raw.trim();
        let Some(inner) = text.strip_prefix("[]") else {
            return ColumnType::parse(text);
        };

        let inner = inner.trim();
        if inner.is_empty() {
            return fail("list type needs an element type, e.g. []int64");
        }
        if inner.starts_with("[]") {
            return fail(format!("nested lists are not supported, got \"{text}\""));
        }

        Ok(ColumnType {
            kind: Kind::List,
            nullable: false,
            precision: 0,
            scale: 0,
            element: Some(Box::new(ColumnType::parse(inner)?)),
        })
    }

    /// Parse a scalar `type="…"`.
    pub fn parse(raw: &str) -> Result<ColumnType, TypeError> {
        let mut segments = raw.split('|');
        let head = segments.next().unwrap_or("").trim();
        if head.is_empty() {
            return fail("column type must not be empty");
        }

        let mut nullable = false;
        for segment in segments {
            if segment.trim().to_lowercase() == "null" {
                nullable = true;
            } else {
                return fail(format!(
                    "unknown type modifier \"{}\" (only \"null\" is supported)",
                    segment.trim()
                ));
            }
        }

        let (name, parameters) = split_head(head)?;
        let kind = kind_of(name);
        let Some(kind) = kind.filter(|k| *k != Kind::List) else {
            return fail(format!("unknown column type \"{head}\""));
        };

        if kind != Kind::Decimal {
            if parameters.is_some() {
                return fail(format!("only decimal takes parameters, got \"{head}\""));
            }
            return Ok(ColumnType {
                kind,
                nullable,
                precision: 0,
                scale: 0,
                element: None,
            });
        }

        let Some(parameters) = parameters else {
            return fail("decimal requires (precision,scale), e.g. decimal(18,2)");
        };
        let parts: Vec<&str> = parameters.split(',').collect();
        if parts.len() != 2 {
            return fail(format!(
                "decimal requires (precision,scale), got \"{head}\""
            ));
        }

        let precision = parts[0].trim().parse::<i32>().unwrap_or(i32::MIN);
        let scale = parts[1].trim().parse::<i32>().unwrap_or(i32::MIN);
        if !(1..=MAX_DECIMAL_PRECISION).contains(&precision) {
            return fail(format!(
                "decimal precision must be an integer 1..{MAX_DECIMAL_PRECISION}, got \"{}\"",
                parts[0].trim()
            ));
        }
        if scale < 0 || scale > precision {
            return fail(format!(
                "decimal scale must be an integer 0..precision ({precision}), got \"{}\"",
                parts[1].trim()
            ));
        }

        Ok(ColumnType {
            kind: Kind::Decimal,
            nullable,
            precision,
            scale,
            element: None,
        })
    }
}

/// `name` and an optional `(parameters)`, or a refusal.
///
/// The reference uses `^([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?$`; this reads the
/// same shape by hand, because the crate has no regex engine for matching and
/// one rule is not worth building it.
fn split_head(head: &str) -> Result<(&str, Option<&str>), TypeError> {
    let (name, parameters) = match head.find('(') {
        None => (head, None),
        Some(open) => {
            if !head.ends_with(')') {
                return fail(format!("unknown column type \"{head}\""));
            }
            let inner = &head[open + 1..head.len() - 1];
            if inner.contains(')') {
                return fail(format!("unknown column type \"{head}\""));
            }
            (head[..open].trim_end(), Some(inner))
        }
    };
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return fail(format!("unknown column type \"{head}\""));
    }
    Ok((name, parameters))
}

fn kind_of(name: &str) -> Option<Kind> {
    Some(match name.to_lowercase().as_str() {
        "bool" => Kind::Bool,
        "int32" => Kind::Int32,
        "int64" => Kind::Int64,
        "uint8" => Kind::UInt8,
        "uint16" => Kind::UInt16,
        "uint32" => Kind::UInt32,
        "uint64" => Kind::UInt64,
        "float" => Kind::Float,
        "float16" => Kind::Float16,
        "double" => Kind::Double,
        "string" => Kind::String,
        "enum" => Kind::Enum,
        "date" => Kind::Date,
        "timestamp" => Kind::Timestamp,
        "decimal" => Kind::Decimal,
        "uuid" => Kind::Uuid,
        "json" => Kind::Json,
        "list" => Kind::List,
        _ => return None,
    })
}
