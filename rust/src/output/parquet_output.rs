//! A run written as a typed binary file instead of as text.
//!
//! The same preparation as the text renderer — one engine, one registry — so a
//! config exported to Parquet holds exactly the data it would have printed for
//! that seed. Only the serialisation differs: instead of formatting a record,
//! each named `<data>` becomes a typed column.
//!
//! Rows go out in row groups, each built, written and released before the next
//! one starts, so memory stays bounded however large the run is.

use crate::engine::{invalid, EngineError, EngineResult, RowSource};
use crate::format::interpolate::{self, Lookup};
use crate::model::Config;
use crate::output::column_type::ColumnType;
use crate::output::columns::{self, Declared};
use crate::output::parquet::convert;
use crate::output::parquet::writer::{self, Cell, Column};

/// Rows per row group.
///
/// Bounds peak memory and lets a reader skip whole groups. It is also the unit
/// parallel generation would split on, because a group's bytes do not depend on
/// where it sits in the file.
pub const ROW_GROUP_ROWS: usize = 50_000;

/// Everything decided before a single row is rendered.
struct Plan {
    declared: Vec<Declared>,
    columns: Vec<Column>,
    types: Vec<ColumnType>,
    separators: Vec<Option<String>>,
}

/// The whole file in memory.
pub fn to_bytes(config: &Config, rows: &dyn RowSource) -> EngineResult<Vec<u8>> {
    let plan = build_plan(config)?;
    let count = rows.count();
    let mut start = 0usize;

    writer::to_bytes(&plan.columns, || {
        if start >= count {
            return None;
        }
        let end = (start + ROW_GROUP_ROWS).min(count);
        let batch = build_batch(&plan, config, rows, start, end);
        start = end;
        batch.ok()
    })
    // A failing cell has to reach the caller, and the batch closure cannot
    // return one; it is re-derived here so the message is the same either way.
    .and_then(|bytes| {
        check_every_cell(&plan, config, rows)?;
        Ok(bytes)
    })
}

/// The resolved schema, for telling the user which types were chosen.
pub fn schema_of(config: &Config) -> EngineResult<Vec<Column>> {
    Ok(build_plan(config)?.columns)
}

/// An untyped column is text. Never guess from the values — a string never
/// corrupts data.
fn default_type() -> ColumnType {
    ColumnType::parse("string").expect("\"string\" is a type")
}

fn build_plan(config: &Config) -> EngineResult<Plan> {
    let mut declared: Vec<Declared> = Vec::new();
    for line in &config.block {
        for part in &line.parts {
            let Some(name) = part
                .name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
            else {
                continue; // decorative text, not a column
            };
            let ty = match &part.part_type {
                None => None,
                Some(raw) => Some(
                    ColumnType::parse_output(raw)
                        .map_err(|e| EngineError::Invalid(format!("column \"{name}\": {}", e.0)))?,
                ),
            };
            declared.push(Declared {
                name: name.to_string(),
                template: part.text.clone(),
                ty,
            });
        }
    }

    if declared.is_empty() {
        return invalid(
            "Parquet output needs at least one named column — add name=\"…\" to a <data> in the \
             <block>",
        );
    }
    columns::check_unique(&declared).map_err(|e| EngineError::Invalid(e.0))?;

    let mut types = Vec::with_capacity(declared.len());
    let mut separators = Vec::with_capacity(declared.len());
    let mut built = Vec::with_capacity(declared.len());
    for column in &declared {
        let ty = columns::resolve(column, config).unwrap_or_else(default_type);
        // A declared []T needs a separator too; a comma when the column was
        // typed by hand rather than derived from a repeating generator.
        separators.push(if ty.is_list() {
            let inject = config.inject.as_deref().unwrap_or("${{%}}");
            Some(
                columns::sole_reference(&column.template, inject)
                    .and_then(|source| columns::separator_of(&source, config))
                    .unwrap_or_else(|| ",".to_string()),
            )
        } else {
            None
        });
        built.push(Column {
            name: column.name.clone(),
            ty: ty.clone(),
        });
        types.push(ty);
    }

    Ok(Plan {
        declared,
        columns: built,
        types,
        separators,
    })
}

fn build_batch(
    plan: &Plan,
    config: &Config,
    rows: &dyn RowSource,
    start: usize,
    end: usize,
) -> EngineResult<Vec<Vec<Cell>>> {
    let mut batch: Vec<Vec<Cell>> = (0..plan.columns.len())
        .map(|_| Vec::with_capacity(end - start))
        .collect();

    for row in start..end {
        for (i, column) in plan.declared.iter().enumerate() {
            let cell = cell_of(plan, config, rows, column, i, row)?;
            batch[i].push(cell);
        }
    }
    Ok(batch)
}

/// One cell, named by column and row when it cannot be represented.
fn cell_of(
    plan: &Plan,
    config: &Config,
    rows: &dyn RowSource,
    column: &Declared,
    i: usize,
    row: usize,
) -> EngineResult<Cell> {
    let lookup = RowLookup { rows, row };
    let text = interpolate::apply(&column.template, config.inject.as_deref(), &lookup)?;
    let ty = &plan.types[i];
    let named = |e: String| {
        EngineError::Invalid(format!("column \"{}\", row {}: {e}", column.name, row + 1))
    };

    if ty.is_list() {
        // An empty cell is an EMPTY LIST, not a list holding one blank —
        // splitting "" on a comma would otherwise conjure a phantom element.
        let elements = if text.is_empty() {
            Vec::new()
        } else {
            split(&text, plan.separators[i].as_deref().unwrap_or(","))
        };
        return Ok(Cell::Elements(elements));
    }

    convert::of(&text, ty)
        .map(Cell::Scalar)
        .map_err(|e| named(e.0))
}

/// Every cell, converted and thrown away.
///
/// The writer takes a closure that cannot fail, so a bad cell would otherwise
/// vanish into a `None` and truncate the file silently. Cheap enough — the
/// alternative is a fallible closure threaded through the whole writer for a
/// case that only ever happens once.
fn check_every_cell(plan: &Plan, config: &Config, rows: &dyn RowSource) -> EngineResult<()> {
    for row in 0..rows.count() {
        for (i, column) in plan.declared.iter().enumerate() {
            cell_of(plan, config, rows, column, i, row)?;
        }
    }
    Ok(())
}

struct RowLookup<'a> {
    rows: &'a dyn RowSource,
    row: usize,
}

impl Lookup for RowLookup<'_> {
    fn has(&self, name: &str) -> bool {
        self.rows.value(name, self.row).is_some()
            || self.rows.sequence_names().iter().any(|n| n == name)
    }

    fn value(&self, name: &str) -> String {
        self.rows.value(name, self.row).unwrap_or("").to_string()
    }
}

/// A literal split, not a regular expression — the separator is a piece of data.
fn split(text: &str, separator: &str) -> Vec<String> {
    if separator.is_empty() {
        return vec![text.to_string()];
    }
    text.split(separator).map(str::to_string).collect()
}
