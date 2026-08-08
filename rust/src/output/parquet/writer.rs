//! A Parquet file, assembled from typed columns.
//!
//! The layout: the four magic bytes, then a page per column per row group, then
//! the whole metadata footer in Thrift's compact protocol, its length, and the
//! magic again. Rows go out in ROW GROUPS — a batch is built, written and
//! released before the next one starts — so peak memory is one group however
//! many records the file holds.
//!
//! Every choice this writer makes is a function of the data alone. No clock, no
//! library version, no sampling: the same config and seed produce the same bytes
//! here as in every other implementation, which is a promise a Parquet writer can
//! only keep by owning its own encoder.

use super::convert::Value;
use super::statistics::Stats;
use super::thrift::Thrift;
use super::{convert, dictionary, list_levels, plain, rle, schema, snappy, statistics, thrift};
use crate::engine::{invalid, EngineResult};
use crate::output::column_type::{ColumnType, Kind};

/// Fixed so the bytes never depend on a version, a clock, or which language
/// wrote them.
const CREATED_BY: &str = "TDC";

const MAGIC: [u8; 4] = [0x50, 0x41, 0x52, 0x31]; // "PAR1"

/// A column's identity: everything the schema needs, without the data.
#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    pub ty: ColumnType,
}

/// One cell.
///
/// A scalar column holds a converted value; a list column holds the row's raw
/// element texts, because which elements are NULL has to be decided — in the
/// definition levels — before anything is converted.
#[derive(Clone, Debug)]
pub enum Cell {
    Scalar(Option<Value>),
    Elements(Vec<String>),
}

/// What the footer needs to know about one column chunk.
struct ChunkMeta {
    offset: i64,
    data_offset: i64,
    /// `-1` when the chunk has no dictionary page.
    dictionary_offset: i64,
    total_size: i64,
    raw_size: i64,
    codec: i32,
    num_values: i64,
    stats: Stats,
}

impl ChunkMeta {
    fn has_dictionary(&self) -> bool {
        self.dictionary_offset >= 0
    }
}

/// One row group's chunks and how many records they cover.
struct GroupMeta {
    chunks: Vec<ChunkMeta>,
    num_rows: i64,
}

/// The whole file in memory.
///
/// One batch per call to `next`, `None` when there are no more — the seam that
/// keeps peak memory at one row group however long the file is.
pub fn to_bytes(
    columns: &[Column],
    mut next: impl FnMut() -> Option<Vec<Vec<Cell>>>,
) -> EngineResult<Vec<u8>> {
    let mut out = Vec::from(MAGIC);
    let mut offset = MAGIC.len() as i64;
    let mut groups: Vec<GroupMeta> = Vec::new();
    let mut num_rows = 0i64;

    while let Some(batch) = next() {
        let Some(block) = build_block(columns, &batch)? else {
            continue;
        };
        for page in &block.pages {
            out.extend_from_slice(page);
        }
        groups.push(GroupMeta {
            chunks: shift(block.chunks, offset),
            num_rows: block.num_rows,
        });
        offset += block.byte_length;
        num_rows += block.num_rows;
    }

    out.extend_from_slice(&footer(columns, &groups, num_rows)?);
    Ok(out)
}

/// One row group, encoded and ready to be placed anywhere in a file.
///
/// This is the unit that makes parallel writing possible: a group's bytes do not
/// depend on where it sits, because page headers carry their own sizes and the
/// only offsets in the whole format live in the footer. Its chunk offsets are
/// relative to the start of the block, and the caller shifts them once it knows
/// where the block landed.
struct Block {
    pages: Vec<Vec<u8>>,
    chunks: Vec<ChunkMeta>,
    num_rows: i64,
    byte_length: i64,
}

fn build_block(columns: &[Column], batch: &[Vec<Cell>]) -> EngineResult<Option<Block>> {
    let rows_in_group = batch.first().map_or(0, Vec::len);
    if rows_in_group == 0 {
        return Ok(None);
    }

    let mut pages: Vec<Vec<u8>> = Vec::new();
    let mut chunks: Vec<ChunkMeta> = Vec::new();
    let mut at = 0i64;

    for (i, column) in columns.iter().enumerate() {
        let page = page_body(column, &batch[i])?;

        // The codec is declared per column chunk, so the choice is made once for
        // the whole chunk — and only taken when it actually saves bytes. Snappy
        // adds framing, which on an already tiny dictionary page makes the
        // "compressed" form the larger one.
        let squeezed_data = snappy::compress(&page.body);
        let squeezed_dict = page.dictionary_body.as_ref().map(|b| snappy::compress(b));
        let raw_total = page.body.len() + page.dictionary_body.as_ref().map_or(0, Vec::len);
        let squeezed_total = squeezed_data.len() + squeezed_dict.as_ref().map_or(0, Vec::len);
        let compress = squeezed_total < raw_total;

        let data_body = if compress {
            squeezed_data
        } else {
            page.body.clone()
        };
        let dict_payload = if compress {
            squeezed_dict
        } else {
            page.dictionary_body.clone()
        };
        let dict_page = page.dictionary_body.as_ref().map(|raw| {
            let mut whole = dictionary_page_header(
                raw.len(),
                dict_payload.as_ref().map_or(0, Vec::len),
                page.dictionary_count,
            );
            whole.extend_from_slice(dict_payload.as_ref().expect("a dictionary was built"));
            whole
        });

        let header = page_header(
            page.body.len(),
            data_body.len(),
            page.num_values,
            page.encoding,
        );
        let dict_size = dict_page.as_ref().map_or(0, Vec::len);
        let written = (dict_size + header.len() + data_body.len()) as i64;
        chunks.push(ChunkMeta {
            offset: at,
            data_offset: at + dict_size as i64,
            dictionary_offset: if dict_page.is_some() { at } else { -1 },
            total_size: written,
            raw_size: (dict_size + header.len() + page.body.len()) as i64,
            codec: if compress {
                schema::SNAPPY_CODEC
            } else {
                schema::UNCOMPRESSED
            },
            num_values: i64::from(page.num_values),
            stats: page.stats,
        });

        if let Some(dict_page) = dict_page {
            pages.push(dict_page);
        }
        pages.push(header);
        pages.push(data_body);
        at += written;
    }

    Ok(Some(Block {
        pages,
        chunks,
        num_rows: rows_in_group as i64,
        byte_length: at,
    }))
}

fn shift(chunks: Vec<ChunkMeta>, by: i64) -> Vec<ChunkMeta> {
    chunks
        .into_iter()
        .map(|c| ChunkMeta {
            offset: c.offset + by,
            data_offset: c.data_offset + by,
            dictionary_offset: if c.has_dictionary() {
                c.dictionary_offset + by
            } else {
                -1
            },
            ..c
        })
        .collect()
}

// ── a page ───────────────────────────────────────────────────────────────────

/// A page's bytes, plus everything the headers and the footer need to describe
/// it.
struct Page {
    body: Vec<u8>,
    num_values: i32,
    stats: Stats,
    dictionary_body: Option<Vec<u8>>,
    dictionary_count: i32,
    encoding: i32,
}

/// The page body and the number of LEVEL SLOTS it describes.
///
/// A scalar column is the values, preceded by definition levels when it is
/// nullable — one slot per row. A list column is repetition levels, then
/// definition levels, then the values — repetition first, as the format mandates
/// — and its slot count is the number of elements, an empty list still costing
/// one.
fn page_body(column: &Column, cells: &[Cell]) -> EngineResult<Page> {
    if !column.ty.is_list() {
        let present: Vec<Option<Value>> = cells
            .iter()
            .filter_map(|cell| match cell {
                Cell::Scalar(Some(value)) => Some(Some(value.clone())),
                _ => None,
            })
            .collect();

        let section = build_value_section(&column.ty, &present)?;
        let stats = statistics::compute(&column.ty, &present, (cells.len() - present.len()) as i64);

        let body = if column.ty.nullable {
            let def: Vec<i32> = cells
                .iter()
                .map(|cell| i32::from(!matches!(cell, Cell::Scalar(None))))
                .collect();
            let mut body = level_block(&def, 1);
            body.extend_from_slice(&section.values);
            body
        } else {
            section.values
        };

        return Ok(Page {
            body,
            num_values: cells.len() as i32,
            stats,
            dictionary_body: section.dictionary_body,
            dictionary_count: section.dictionary_count,
            encoding: section.encoding,
        });
    }

    let element = column
        .ty
        .element
        .as_ref()
        .expect("a list carries its element type");
    let rows: Vec<Vec<String>> = cells
        .iter()
        .map(|cell| match cell {
            Cell::Elements(texts) => texts.clone(),
            Cell::Scalar(_) => Vec::new(),
        })
        .collect();
    let levels = list_levels::build(&rows, element.nullable);

    let mut element_values: Vec<Option<Value>> = Vec::new();
    for text in &levels.present {
        if let Some(value) =
            convert::of(text, element).map_err(|e| crate::engine::EngineError::Invalid(e.0))?
        {
            element_values.push(Some(value));
        }
    }

    let section = build_value_section(element, &element_values)?;
    let mut body = level_block(&levels.rep_levels, levels.max_rep);
    body.extend_from_slice(&level_block(&levels.def_levels, levels.max_def));
    body.extend_from_slice(&section.values);

    Ok(Page {
        body,
        num_values: levels.rep_levels.len() as i32,
        // For a list, a "null" is any level slot that did not reach the leaf — an
        // absent element, or an empty list.
        stats: statistics::compute(
            element,
            &element_values,
            (levels.rep_levels.len() - element_values.len()) as i64,
        ),
        dictionary_body: section.dictionary_body,
        dictionary_count: section.dictionary_count,
        encoding: section.encoding,
    })
}

struct ValueSection {
    values: Vec<u8>,
    dictionary_body: Option<Vec<u8>>,
    dictionary_count: i32,
    encoding: i32,
}

/// A chunk's values: PLAIN, or — when the data repeats enough to pay for it — a
/// dictionary page plus RLE-packed indices into it.
fn build_value_section(ty: &ColumnType, present: &[Option<Value>]) -> EngineResult<ValueSection> {
    match dictionary::build(ty, present) {
        None => Ok(ValueSection {
            values: encode_values(ty, present)?,
            dictionary_body: None,
            dictionary_count: 0,
            encoding: schema::PLAIN_ENCODING,
        }),
        Some(built) => Ok(ValueSection {
            values: rle::dictionary_indices(
                &built.indices,
                rle::dictionary_bit_width(built.values.len()),
            ),
            dictionary_body: Some(encode_values(ty, &built.values)?),
            dictionary_count: built.values.len() as i32,
            encoding: schema::RLE_DICTIONARY,
        }),
    }
}

fn encode_values(ty: &ColumnType, present: &[Option<Value>]) -> EngineResult<Vec<u8>> {
    let ints = || -> Vec<i32> {
        present
            .iter()
            .map(|v| match v {
                Some(Value::Int(n)) => *n,
                _ => 0,
            })
            .collect()
    };
    let longs = || -> Vec<i64> {
        present
            .iter()
            .map(|v| match v {
                Some(Value::Long(n)) => *n,
                _ => 0,
            })
            .collect()
    };
    let doubles = || -> Vec<f64> {
        present
            .iter()
            .map(|v| match v {
                Some(Value::Double(n)) => *n,
                _ => 0.0,
            })
            .collect()
    };

    Ok(match ty.kind {
        Kind::Bool => plain::booleans(
            &present
                .iter()
                .map(|v| matches!(v, Some(Value::Bool(true))))
                .collect::<Vec<bool>>(),
        ),
        Kind::Int32 | Kind::Date | Kind::UInt8 | Kind::UInt16 | Kind::UInt32 => {
            plain::int32(&ints())
        }
        Kind::Int64 | Kind::Timestamp | Kind::Decimal | Kind::UInt64 => plain::int64(&longs()),
        Kind::Float => plain::floats(&doubles()),
        Kind::Float16 => plain::float16(&doubles()),
        Kind::Double => plain::doubles(&doubles()),
        Kind::String | Kind::Enum | Kind::Json => plain::byte_array(
            &present
                .iter()
                .map(|v| match v {
                    Some(Value::Text(t)) => t.clone(),
                    _ => String::new(),
                })
                .collect::<Vec<String>>(),
        ),
        Kind::Uuid => plain::fixed(
            &present
                .iter()
                .map(|v| match v {
                    Some(Value::Bytes(b)) => b.clone(),
                    _ => Vec::new(),
                })
                .collect::<Vec<Vec<u8>>>(),
        ),
        Kind::List => return invalid("parquet: cannot encode a list of lists"),
    })
}

/// A length-prefixed level block, as the page body expects it.
fn level_block(levels: &[i32], max_level: i32) -> Vec<u8> {
    let encoded = rle::levels(levels, list_levels::bit_width(max_level));
    let mut out = Vec::with_capacity(4 + encoded.len());
    out.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
    out.extend_from_slice(&encoded);
    out
}

// ── headers and footer ───────────────────────────────────────────────────────

fn page_header(raw_size: usize, compressed_size: usize, num_values: i32, encoding: i32) -> Vec<u8> {
    let mut w = Thrift::new();
    w.struct_begin();
    w.i32(1, schema::DATA_PAGE);
    w.i32(2, raw_size as i32); // uncompressed_page_size
    w.i32(3, compressed_size as i32); // compressed_page_size
    w.field_begin(5, thrift::STRUCT_TYPE); // data_page_header
    w.struct_begin();
    w.i32(1, num_values);
    w.i32(2, encoding); // PLAIN, or RLE_DICTIONARY when indices follow
    w.i32(3, schema::RLE_ENCODING); // definition levels
    w.i32(4, schema::RLE_ENCODING); // repetition levels, unused for a flat column
    w.struct_end();
    w.struct_end();
    w.into_bytes()
}

/// The dictionary page's header. Its own encoding is PLAIN — the modern pairing
/// with an RLE_DICTIONARY data page. The legacy pairing put PLAIN_DICTIONARY on
/// both, which recent readers still accept but no longer produce.
fn dictionary_page_header(raw_size: usize, compressed_size: usize, num_values: i32) -> Vec<u8> {
    let mut w = Thrift::new();
    w.struct_begin();
    w.i32(1, schema::DICTIONARY_PAGE);
    w.i32(2, raw_size as i32);
    w.i32(3, compressed_size as i32);
    w.field_begin(7, thrift::STRUCT_TYPE); // dictionary_page_header
    w.struct_begin();
    w.i32(1, num_values);
    w.i32(2, schema::PLAIN_ENCODING);
    w.struct_end();
    w.struct_end();
    w.into_bytes()
}

/// `column_orders` — the field that makes the statistics USABLE.
///
/// The spec is explicit: a reader must ignore `min_value`/`max_value` unless
/// `FileMetaData.column_orders` says the sort order is TypeDefinedOrder.
/// Without it the bounds are there in the bytes and no conforming reader may
/// act on them, so every row group is decoded in full — which is exactly what
/// the statistics exist to avoid. The values were correct; nothing was allowed
/// to read them.
///
/// One entry per LEAF column, in schema order — the same order the row groups
/// list their chunks in, which is one per column (a list column contributes
/// three schema elements but still exactly one leaf).
///
/// `ColumnOrder` is a union whose only member, `TYPE_ORDER`, holds an EMPTY
/// struct, so each entry is three bytes: the union's field header, the empty
/// struct's stop byte, and the union's own stop byte.
fn write_column_orders(w: &mut Thrift, leaves: usize) {
    w.list_begin(7, thrift::STRUCT_TYPE, leaves);
    for _ in 0..leaves {
        w.struct_begin(); // ColumnOrder
        w.field_begin(1, thrift::STRUCT_TYPE); // TYPE_ORDER
        w.struct_begin(); // TypeDefinedOrder {}
        w.struct_end();
        w.struct_end();
    }
}

/// The footer: schema, row-group directory, then the trailing length and magic.
fn footer(columns: &[Column], groups: &[GroupMeta], num_rows: i64) -> EngineResult<Vec<u8>> {
    let mut w = Thrift::new();
    w.struct_begin();
    w.i32(1, 1); // version
    write_schema(&mut w, columns)?;
    w.i64(3, num_rows);
    write_row_groups(&mut w, columns, groups)?;
    w.string(6, CREATED_BY);
    write_column_orders(&mut w, columns.len());
    w.struct_end();

    let bytes = w.into_bytes();
    let mut out = bytes.clone();
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&MAGIC);
    Ok(out)
}

/// The LogicalType union — exactly one variant field is set.
fn write_logical_type(w: &mut Thrift, map: &schema::Mapping) {
    if map.logical_field == schema::NONE {
        return;
    }

    w.field_begin(10, thrift::STRUCT_TYPE);
    w.struct_begin();
    w.field_begin(map.logical_field, thrift::STRUCT_TYPE);
    w.struct_begin();
    if map.logical_field == schema::LT_DECIMAL {
        w.i32(1, map.scale);
        w.i32(2, map.precision);
    } else if map.logical_field == schema::LT_INTEGER {
        w.i8(1, map.bit_width);
        w.bool(2, map.signed);
    } else if map.logical_field == schema::LT_TIMESTAMP {
        w.bool(1, true); // isAdjustedToUTC
        w.field_begin(2, thrift::STRUCT_TYPE); // TimeUnit union
        w.struct_begin();
        w.field_begin(1, thrift::STRUCT_TYPE); // MILLIS
        w.struct_begin();
        w.struct_end();
        w.struct_end();
    }
    w.struct_end();
    w.struct_end();
}

fn mapping_of(ty: &ColumnType) -> EngineResult<schema::Mapping> {
    schema::map(ty).ok_or_else(|| {
        crate::engine::EngineError::Invalid(format!("parquet: no mapping for {:?}", ty.kind))
    })
}

fn write_schema(w: &mut Thrift, columns: &[Column]) -> EngineResult<()> {
    // The root plus every SchemaElement — a list contributes three, not one.
    let elements: usize = columns
        .iter()
        .map(|c| if c.ty.is_list() { 3 } else { 1 })
        .sum();
    w.list_begin(2, thrift::STRUCT_TYPE, elements + 1);

    // The root element: a name and the child count, nothing else.
    w.struct_begin();
    w.string(4, "schema");
    w.i32(5, columns.len() as i32);
    w.struct_end();

    for column in columns {
        if let Some(element) = column.ty.element.as_ref().filter(|_| column.ty.is_list()) {
            write_list_schema(w, &column.name, element)?;
            continue;
        }

        let map = mapping_of(&column.ty)?;
        w.struct_begin();
        w.i32(1, map.physical);
        if map.type_length > 0 {
            w.i32(2, map.type_length);
        }
        w.i32(
            3,
            if column.ty.nullable {
                schema::OPTIONAL
            } else {
                schema::REQUIRED
            },
        );
        w.string(4, &column.name);
        if map.converted_type != schema::NONE {
            w.i32(6, map.converted_type);
        }
        if map.logical_field == schema::LT_DECIMAL {
            w.i32(7, map.scale);
            w.i32(8, map.precision);
        }
        write_logical_type(w, &map);
        w.struct_end();
    }
    Ok(())
}

/// The three-element LIST wrapper.
///
/// The names `list` and `element` are fixed by the format rather than chosen
/// here; readers match on the annotated shape.
fn write_list_schema(w: &mut Thrift, name: &str, element: &ColumnType) -> EngineResult<()> {
    w.struct_begin();
    w.i32(3, schema::REQUIRED);
    w.string(4, name);
    w.i32(5, 1); // num_children
    w.i32(6, schema::CT_LIST);
    w.field_begin(10, thrift::STRUCT_TYPE); // logicalType
    w.struct_begin();
    w.field_begin(schema::LT_LIST, thrift::STRUCT_TYPE);
    w.struct_begin();
    w.struct_end();
    w.struct_end();
    w.struct_end();

    w.struct_begin();
    w.i32(3, schema::REPEATED);
    w.string(4, "list");
    w.i32(5, 1); // num_children
    w.struct_end();

    let map = mapping_of(element)?;
    w.struct_begin();
    w.i32(1, map.physical);
    if map.type_length > 0 {
        w.i32(2, map.type_length);
    }
    w.i32(
        3,
        if element.nullable {
            schema::OPTIONAL
        } else {
            schema::REQUIRED
        },
    );
    w.string(4, "element");
    if map.converted_type != schema::NONE {
        w.i32(6, map.converted_type);
    }
    if map.logical_field == schema::LT_DECIMAL {
        w.i32(7, map.scale);
        w.i32(8, map.precision);
    }
    write_logical_type(w, &map);
    w.struct_end();
    Ok(())
}

/// parquet.thrift's `Statistics`, field 12 of ColumnMetaData.
///
/// Only the null count and the min/max VALUE fields — never the deprecated
/// min/max, whose signedness readers historically disagreed about. A bound a
/// reader may misinterpret is as dangerous as a bound that is simply wrong.
fn write_statistics(w: &mut Thrift, stats: &Stats) {
    w.field_begin(12, thrift::STRUCT_TYPE);
    w.struct_begin();
    w.i64(3, stats.null_count);
    if let Some(max) = &stats.max_value {
        w.binary_field(5, max);
    }
    if let Some(min) = &stats.min_value {
        w.binary_field(6, min);
    }
    w.struct_end();
}

fn write_row_groups(w: &mut Thrift, columns: &[Column], groups: &[GroupMeta]) -> EngineResult<()> {
    w.list_begin(4, thrift::STRUCT_TYPE, groups.len());
    for group in groups {
        w.struct_begin();
        w.list_begin(1, thrift::STRUCT_TYPE, columns.len()); // columns
        let mut total_byte_size = 0i64;

        for (i, column) in columns.iter().enumerate() {
            let chunk = &group.chunks[i];
            total_byte_size += chunk.total_size;
            let listed = column.ty.is_list();
            let leaf = if listed {
                column.ty.element.as_deref().unwrap_or(&column.ty)
            } else {
                &column.ty
            };
            let map = mapping_of(leaf)?;

            w.struct_begin();
            w.i64(2, chunk.offset); // file_offset — the dictionary page when there is one
            w.field_begin(3, thrift::STRUCT_TYPE); // meta_data
            w.struct_begin();
            w.i32(1, map.physical);

            // PLAIN always appears: it is how the dictionary page itself is
            // written, and how the values are written when there is no
            // dictionary. A list always carries levels, so RLE is always among
            // its encodings too.
            let mut encodings = vec![schema::PLAIN_ENCODING];
            if listed || column.ty.nullable {
                encodings.push(schema::RLE_ENCODING);
            }
            if chunk.has_dictionary() {
                encodings.push(schema::RLE_DICTIONARY);
            }
            w.list_begin(2, thrift::I32_TYPE, encodings.len());
            for e in &encodings {
                w.list_i32(*e);
            }

            // The chunk addresses the LEAF, so a list's path walks through its
            // wrapper.
            let path: Vec<&str> = if listed {
                vec![&column.name, "list", "element"]
            } else {
                vec![&column.name]
            };
            w.list_begin(3, thrift::BINARY, path.len()); // path_in_schema
            for segment in &path {
                w.list_string(segment);
            }

            w.i32(4, chunk.codec);
            w.i64(5, chunk.num_values);
            w.i64(6, chunk.raw_size); // total_uncompressed_size
            w.i64(7, chunk.total_size); // total_compressed_size
            w.i64(9, chunk.data_offset); // data_page_offset
                                         // Field 11 must be written between 9 and 12: the compact protocol
                                         // encodes field ids as ascending deltas, so writing it out of order
                                         // would corrupt every field after it.
            if chunk.has_dictionary() {
                w.i64(11, chunk.dictionary_offset);
            }
            write_statistics(w, &chunk.stats);
            w.struct_end();
            w.struct_end();
        }

        w.i64(2, total_byte_size); // total_byte_size
        w.i64(3, group.num_rows);
        w.struct_end();
    }
    Ok(())
}
