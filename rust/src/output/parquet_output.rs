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

/// What this writer needs from a run: how many rows, which names exist on a
/// given row, and one value at a time — OWNED.
///
/// [`RowSource`] cannot serve here, and that is the whole point of this trait
/// existing: it hands out `&str` borrowed from the run, so anything that
/// implements it has to HOLD the run first. A Parquet export therefore used to
/// materialise every column — and the text output it never wrote — before it
/// encoded a single row group. The engine answers all three questions without
/// holding anything.
pub trait Cells {
    /// The number of records.
    fn count(&self) -> usize;

    /// Whether this row has a column by that name. Per ROW, not per run: a
    /// column filtered out by its parent is absent on some rows and present on
    /// others, and `has` is what decides whether a template writes a blank.
    fn has(&self, name: &str, row: usize) -> bool;

    /// The value, or `None` when the column does not apply to that row.
    fn value(&self, name: &str, row: usize) -> Option<String>;
}

/// A run already in memory, seen through that window.
struct SourceCells<'a>(&'a dyn RowSource);

impl Cells for SourceCells<'_> {
    fn count(&self) -> usize {
        self.0.count()
    }

    fn has(&self, name: &str, row: usize) -> bool {
        self.0.value(name, row).is_some() || self.0.sequence_names().iter().any(|n| n == name)
    }

    fn value(&self, name: &str, row: usize) -> Option<String> {
        self.0.value(name, row).map(str::to_string)
    }
}

/// The streaming engine, asked one cell at a time.
///
/// A column here can fail where a materialised one cannot — the run was never
/// walked, so a bad expression is met for the first time mid-encode. The
/// [`Cells`] methods have nowhere to put an error, so the first one is set
/// aside and raised by [`to_bytes_from_engine`] the moment the writer returns.
pub struct EngineCells<'a> {
    engine: &'a crate::engine::stream::StreamEngine<'a>,
    failure: std::cell::RefCell<Option<EngineError>>,
}

impl<'a> EngineCells<'a> {
    fn new(engine: &'a crate::engine::stream::StreamEngine<'a>) -> Self {
        Self {
            engine,
            failure: std::cell::RefCell::new(None),
        }
    }

    fn note(&self, error: EngineError) {
        let mut held = self.failure.borrow_mut();
        if held.is_none() {
            *held = Some(error);
        }
    }
}

impl Cells for EngineCells<'_> {
    fn count(&self) -> usize {
        self.engine.row_count()
    }

    fn has(&self, name: &str, row: usize) -> bool {
        match self.engine.cell(name, row) {
            Ok(found) => found.is_some() || self.engine.names().iter().any(|n| n == name),
            Err(e) => {
                self.note(e);
                false
            }
        }
    }

    fn value(&self, name: &str, row: usize) -> Option<String> {
        match self.engine.cell(name, row) {
            Ok(found) => found,
            Err(e) => {
                self.note(e);
                None
            }
        }
    }
}

/// Everything decided before a single row is rendered.
struct Plan {
    declared: Vec<Declared>,
    columns: Vec<Column>,
    types: Vec<ColumnType>,
    separators: Vec<Option<String>>,
}

/// The whole file in memory, from a run that is already there.
pub fn to_bytes(config: &Config, rows: &dyn RowSource) -> EngineResult<Vec<u8>> {
    to_bytes_watched(config, rows, None)
}

/// The same, reporting the rows it has laid down as it goes.
pub fn to_bytes_watched(
    config: &Config,
    rows: &dyn RowSource,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<Vec<u8>> {
    let mut buffer: Vec<u8> = Vec::new();
    encode(config, &SourceCells(rows), on_progress, &mut |bytes| {
        buffer.extend_from_slice(bytes);
    })?;
    Ok(buffer)
}

/// A run that is already in memory, written a page at a time.
///
/// The run itself is held either way — the caller has one — but the encoded file
/// need not be, and this is what keeps a `.parquet` target from costing its own
/// size in memory on top.
pub fn write_watched(
    config: &Config,
    rows: &dyn RowSource,
    on_progress: crate::engine::Watch<'_>,
    out: &mut dyn FnMut(&[u8]),
) -> EngineResult<()> {
    encode(config, &SourceCells(rows), on_progress, out)
}

/// The file, taken straight off the engine and written a page at a time.
///
/// Nothing whole is ever held: the run is not materialised — values are asked
/// for as each row group is laid down — and the encoded pages go to `out` and
/// are dropped. What is kept is the row-group index the footer is made of, which
/// is a few numbers per group.
pub fn write_from_engine(
    config: &Config,
    engine: &crate::engine::stream::StreamEngine<'_>,
    on_progress: crate::engine::Watch<'_>,
    out: &mut dyn FnMut(&[u8]),
) -> EngineResult<()> {
    let cells = EngineCells::new(engine);
    let written = encode(config, &cells, on_progress, out);
    // A cell that failed mid-encode beats whatever the writer made of the gap.
    if let Some(error) = cells.failure.into_inner() {
        return Err(error);
    }
    written
}

fn encode(
    config: &Config,
    rows: &dyn Cells,
    on_progress: crate::engine::Watch<'_>,
    out: &mut dyn FnMut(&[u8]),
) -> EngineResult<()> {
    let plan = build_plan(config)?;
    let count = rows.count();
    let mut start = 0usize;
    /*
     * The first failing cell, kept aside.
     *
     * The writer's callback can only say "no more batches", not "this one was
     * impossible", so a failure used to be swallowed here and the whole run
     * CONVERTED A SECOND TIME afterwards purely to find out what it had been.
     * Every Parquet file in this implementation was therefore built twice —
     * which the progress channel made visible the day it was added: the percent
     * climbed to 86 and then started again at 8. Holding the error costs one
     * `RefCell` and the second pass goes away.
     */
    let failure: std::cell::RefCell<Option<EngineError>> = std::cell::RefCell::new(None);

    let written = writer::write_to(
        &plan.columns,
        || {
        if start >= count || failure.borrow().is_some() {
            return None;
        }
        // Once per row group, which is fifty thousand rows: coarser than the
        // text path's half-percent, and it has to be — a row group is the unit
        // this writer works in, and there is no moment inside one where a
        // partial group means anything.
        if let Some(report) = on_progress {
            report("render", start, count);
        }
        let end = (start + ROW_GROUP_ROWS).min(count);
        let batch = build_batch(&plan, config, rows, start, end);
        start = end;
            match batch {
                Ok(batch) => Some(batch),
                Err(e) => {
                    *failure.borrow_mut() = Some(e);
                    None
                }
            }
        },
        out,
    );
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    written
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
    rows: &dyn Cells,
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
    rows: &dyn Cells,
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

struct RowLookup<'a> {
    rows: &'a dyn Cells,
    row: usize,
}

impl Lookup for RowLookup<'_> {
    fn has(&self, name: &str) -> bool {
        self.rows.has(name, self.row)
    }

    fn value(&self, name: &str) -> String {
        self.rows.value(name, self.row).unwrap_or_default()
    }
}

/// A literal split, not a regular expression — the separator is a piece of data.
fn split(text: &str, separator: &str) -> Vec<String> {
    if separator.is_empty() {
        return vec![text.to_string()];
    }
    text.split(separator).map(str::to_string).collect()
}
