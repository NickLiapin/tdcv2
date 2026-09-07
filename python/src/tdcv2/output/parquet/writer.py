"""A Parquet file, assembled from typed columns.

The layout: the four magic bytes, then a page per column per row group, then the whole metadata
footer in Thrift's compact protocol, its length, and the magic again. Rows go out in ROW GROUPS — a
batch is built, written and released before the next one starts — so peak memory is one group
however many records the file holds.

Every choice this writer makes is a function of the data alone. No clock, no library version, no
sampling: the same config and seed produce the same bytes here as in every other implementation,
which is a promise a Parquet writer can only keep by owning its own encoder.
"""

from __future__ import annotations

import struct
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from ..column_type import ColumnType, Kind
from . import (
    convert,
    dictionary,
    list_levels,
    map_levels,
    plain,
    rle,
    schema,
    snappy,
    statistics,
    thrift,
)

# Fixed so the bytes never depend on a version, a clock, or which language wrote them.
CREATED_BY = "TDC"

MAGIC = b"PAR1"

_INT32_KINDS = (Kind.INT32, Kind.DATE, Kind.UINT8, Kind.UINT16, Kind.UINT32)
_INT64_KINDS = (Kind.INT64, Kind.TIMESTAMP, Kind.DECIMAL, Kind.UINT64)
_TEXT_KINDS = (Kind.STRING, Kind.ENUM, Kind.JSON)


@dataclass(frozen=True, slots=True)
class Column:
    """A column's identity: everything the schema needs, without the data."""

    name: str
    type: ColumnType


@dataclass(frozen=True, slots=True)
class Cell:
    """One cell.

    A scalar column holds a converted value; a list column holds the row's raw element TEXTS,
    because which elements are NULL has to be decided — in the definition levels — before anything
    is converted.
    """

    value: convert.Value | None = None
    texts: list[str] | None = None
    pairs: list[map_levels.Entry] | None = None
    """A map column's raw pairs, for the same reason a list keeps raw texts."""


@dataclass(frozen=True, slots=True)
class ChunkMeta:
    """What the footer needs to know about one column chunk."""

    offset: int
    data_offset: int
    dictionary_offset: int
    total_size: int
    raw_size: int
    codec: int
    num_values: int
    stats: statistics.Result
    path: tuple[str, ...] = ()
    """Which LEAF this chunk is, spelled as the reader addresses it.

    A scalar column is one leaf and one chunk; a list is one leaf under a wrapper; a MAP is TWO —
    the key and the value — under one declared name. The footer used to read the physical type and
    the path off the column, which quietly assumed the first of those three.
    """

    physical_type: ColumnType | None = None
    has_levels: bool = False
    """Whether the leaf carries level streams, which decides if RLE is declared."""

    @property
    def has_dictionary(self) -> bool:
        return self.dictionary_offset >= 0


@dataclass(frozen=True, slots=True)
class GroupMeta:
    """One row group's chunks and how many records they cover."""

    chunks: list[ChunkMeta]
    num_rows: int


def write(
    columns: list[Column],
    batches: Iterable[list[list[Cell]]],
    out: Callable[[bytes], None],
) -> None:
    """The whole file to a sink, one row group at a time.

    Only the small per-group metadata is kept as it goes, because the footer has to be written last
    and has to know where every page landed.
    """
    out(MAGIC)
    offset = len(MAGIC)
    groups: list[GroupMeta] = []
    num_rows = 0

    for batch in batches:
        block = _block(columns, batch)
        if block is None:
            continue
        pages, chunks, rows, length = block
        for page in pages:
            out(page)
        groups.append(GroupMeta(_shift(chunks, offset), rows))
        offset += length
        num_rows += rows

    out(footer(columns, groups, num_rows))


def to_bytes(columns: list[Column], batches: Iterable[list[list[Cell]]]) -> bytes:
    """The whole file in memory — convenient for a small output, and for tests."""
    out = bytearray()
    write(columns, batches, out.extend)
    return bytes(out)


def _block(columns: list[Column], batch: list[list[Cell]]):
    """One row group, encoded and ready to be placed anywhere in a file.

    This is the unit that makes parallel writing possible: a group's bytes do not depend on where
    it sits, because page headers carry their own sizes and the only offsets in the whole format
    live in the footer. Its chunk offsets are relative to the start of the block, and the caller
    shifts them once it knows where the block landed.
    """
    rows_in_group = len(batch[0]) if batch else 0
    if rows_in_group == 0:
        return None

    pages: list[bytes] = []
    chunks: list[ChunkMeta] = []
    at = 0

    # Leaves, not columns: a map is two of them under one declared name, and each gets its own
    # chunk.
    leaves = [
        page for i, column in enumerate(columns) for page in _column_leaves(column, batch[i])
    ]

    for page in leaves:

        # The codec is declared per column chunk, so the choice is made once for the whole chunk —
        # and only taken when it actually saves bytes. Snappy adds framing, which on an already
        # tiny dictionary page makes the "compressed" form the larger one.
        squeezed_data = snappy.compress(page.body)
        squeezed_dict = (
            None if page.dictionary_body is None else snappy.compress(page.dictionary_body)
        )
        raw_total = len(page.body) + (
            0 if page.dictionary_body is None else len(page.dictionary_body)
        )
        squeezed_total = len(squeezed_data) + (0 if squeezed_dict is None else len(squeezed_dict))
        compress = squeezed_total < raw_total

        data_body = squeezed_data if compress else page.body
        dict_payload = squeezed_dict if compress else page.dictionary_body
        dict_page = (
            None
            if page.dictionary_body is None
            else _dictionary_page_header(
                len(page.dictionary_body), len(dict_payload), page.dictionary_count
            )
            + dict_payload
        )

        header = _page_header(len(page.body), len(data_body), page.num_values, page.encoding)
        dict_size = 0 if dict_page is None else len(dict_page)
        written = dict_size + len(header) + len(data_body)
        chunks.append(
            ChunkMeta(
                at,
                at + dict_size,
                -1 if dict_page is None else at,
                written,
                dict_size + len(header) + len(page.body),
                schema.SNAPPY if compress else schema.UNCOMPRESSED,
                page.num_values,
                page.stats,
                page.path,
                page.physical_type,
                page.has_levels,
            )
        )
        if dict_page is not None:
            pages.append(dict_page)
        pages.append(header)
        pages.append(data_body)
        at += written

    return pages, chunks, rows_in_group, at


def _shift(chunks: list[ChunkMeta], by: int) -> list[ChunkMeta]:
    return [
        ChunkMeta(
            c.offset + by,
            c.data_offset + by,
            c.dictionary_offset + by if c.has_dictionary else -1,
            c.total_size,
            c.raw_size,
            c.codec,
            c.num_values,
            c.stats,
            c.path,
            c.physical_type,
            c.has_levels,
        )
        for c in chunks
    ]


# ── a page ──────────────────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class _Page:
    """A page's bytes, plus everything the headers and the footer need to describe it."""

    body: bytes = b""
    num_values: int = 0
    stats: statistics.Result | None = None
    dictionary_body: bytes | None = None
    dictionary_count: int = 0
    encoding: int = schema.PLAIN
    path: tuple[str, ...] = ()
    physical_type: ColumnType | None = None
    has_levels: bool = False


def _column_leaves(column: Column, cells: list[Cell]) -> list[_Page]:
    """The leaves one declared column becomes.

    One for a scalar or a list, TWO for a map — its key and its value, which are separate columns
    in the file and share only their repetition levels.
    """
    if column.type.is_map:
        return _map_leaves(column, cells)
    page = _page_body(column, cells)
    page.path = (
        (column.name, "list", "element") if column.type.is_list else (column.name,)
    )
    page.physical_type = column.type.element if column.type.is_list else column.type
    page.has_levels = column.type.is_list or column.type.nullable
    return [page]


_KEY_TYPE = ColumnType(Kind.STRING, False)


def _map_leaves(column: Column, cells: list[Cell]) -> list[_Page]:
    """A map's two leaves.

    The KEY stream is required text; the VALUE stream carries the column's declared type and may be
    optional. Both hold one level slot per pair, and one for a row whose map is empty.
    """
    value_type = column.type.element
    assert value_type is not None
    rows = [cell.pairs or [] for cell in cells]
    levels = map_levels.build(rows, value_type.nullable)

    key_values = [convert.value(text, _KEY_TYPE) for text in levels.keys]
    key_values = [v for v in key_values if v is not None]
    key_bytes, key_dict, key_dict_count, key_encoding = _value_section(_KEY_TYPE, key_values)
    key_page = _Page(
        body=(
            _level_block(levels.rep_levels, 1)
            + _level_block(levels.key_def_levels, map_levels.KEY_MAX_DEF)
            + key_bytes
        ),
        num_values=len(levels.rep_levels),
        # The same rule a list follows: a "null" is any level slot that did not reach the leaf.
        # For the key leaf that is exactly the rows whose map is empty — a key itself is never
        # absent.
        stats=statistics.compute(
            _KEY_TYPE, key_values, len(levels.rep_levels) - len(key_values)
        ),
        dictionary_body=key_dict,
        dictionary_count=key_dict_count,
        encoding=key_encoding,
        path=(column.name, "key_value", "key"),
        physical_type=_KEY_TYPE,
        has_levels=True,
    )

    present = []
    for text in levels.present:
        value = convert.value(text, value_type)
        if value is not None:
            present.append(value)
    value_bytes, value_dict, value_dict_count, value_encoding = _value_section(
        value_type, present
    )
    value_page = _Page(
        body=(
            _level_block(levels.rep_levels, 1)
            + _level_block(levels.value_def_levels, levels.max_value_def)
            + value_bytes
        ),
        num_values=len(levels.rep_levels),
        stats=statistics.compute(
            value_type, present, len(levels.rep_levels) - len(present)
        ),
        dictionary_body=value_dict,
        dictionary_count=value_dict_count,
        encoding=value_encoding,
        path=(column.name, "key_value", "value"),
        physical_type=value_type,
        has_levels=True,
    )
    return [key_page, value_page]


def _page_body(column: Column, cells: list[Cell]) -> _Page:
    """The page body and the number of LEVEL SLOTS it describes.

    A scalar column is the values, preceded by definition levels when it is nullable — one slot per
    row. A list column is repetition levels, then definition levels, then the values — repetition
    first, as the format mandates — and its slot count is the number of elements, an empty list
    still costing one.
    """
    page = _Page()

    if not column.type.is_list:
        present = [cell.value for cell in cells if cell.value is not None]
        values, dict_body, dict_count, encoding = _value_section(column.type, present)
        page.num_values = len(cells)
        page.stats = statistics.compute(column.type, present, len(cells) - len(present))
        page.encoding = encoding
        page.dictionary_body = dict_body
        page.dictionary_count = dict_count

        if not column.type.nullable:
            page.body = values
            return page
        definition = [0 if cell.value is None else 1 for cell in cells]
        page.body = _level_block(definition, 1) + values
        return page

    element = column.type.element
    assert element is not None
    rows = [cell.texts or [] for cell in cells]
    levels = list_levels.build(rows, element.nullable)

    present = []
    for text in levels.present:
        value = convert.value(text, element)
        if value is not None:
            present.append(value)
    values, dict_body, dict_count, encoding = _value_section(element, present)

    page.body = (
        _level_block(levels.rep_levels, levels.max_rep)
        + _level_block(levels.def_levels, levels.max_def)
        + values
    )
    page.num_values = len(levels.rep_levels)
    # For a list, a "null" is any level slot that did not reach the leaf — an absent element, or an
    # empty list.
    page.stats = statistics.compute(element, present, len(levels.rep_levels) - len(present))
    page.encoding = encoding
    page.dictionary_body = dict_body
    page.dictionary_count = dict_count
    return page


def _value_section(type_: ColumnType, present: list[convert.Value]):
    """A chunk's values: PLAIN, or a dictionary page plus RLE-packed indices when it pays."""
    built = dictionary.build(type_, present)
    if built is None:
        return _encode_values(type_, present), None, 0, schema.PLAIN
    return (
        rle.dictionary_indices(built.indices, rle.dictionary_bit_width(len(built.values))),
        _encode_values(type_, built.values),
        len(built.values),
        schema.RLE_DICTIONARY,
    )


def _encode_values(type_: ColumnType, present: list[convert.Value]) -> bytes:
    kind = type_.kind
    if kind is Kind.BOOL:
        return plain.booleans([bool(v.number) for v in present])
    if kind in _INT32_KINDS:
        return plain.int32([int(v.number) for v in present])
    if kind in _INT64_KINDS:
        return plain.int64([int(v.number) for v in present])
    if kind is Kind.FLOAT:
        return plain.floats([v.number for v in present])
    if kind is Kind.FLOAT16:
        return plain.float16([v.number for v in present])
    if kind is Kind.DOUBLE:
        return plain.doubles([v.number for v in present])
    if kind in _TEXT_KINDS:
        return plain.byte_array([v.text for v in present])
    if kind is Kind.UUID:
        return plain.fixed([v.raw for v in present])
    raise ValueError(f"cannot encode {type_}")


def _level_block(levels: list[int], max_level: int) -> bytes:
    """A length-prefixed level block, as the page body expects it."""
    encoded = rle.levels(levels, list_levels.bit_width(max_level))
    return struct.pack("<I", len(encoded)) + encoded


# ── headers and footer ──────────────────────────────────────────────────────────────────────


def _page_header(raw_size: int, compressed_size: int, num_values: int, encoding: int) -> bytes:
    w = thrift.Writer()
    w.struct_begin()
    w.i32(1, schema.DATA_PAGE)
    w.i32(2, raw_size)  # uncompressed_page_size
    w.i32(3, compressed_size)  # compressed_page_size
    w.field_begin(5, thrift.STRUCT)  # data_page_header
    w.struct_begin()
    w.i32(1, num_values)
    w.i32(2, encoding)  # PLAIN, or RLE_DICTIONARY when indices follow
    w.i32(3, schema.RLE)  # definition levels
    w.i32(4, schema.RLE)  # repetition levels, unused for a flat column
    w.struct_end()
    w.struct_end()
    return w.bytes()


def _dictionary_page_header(raw_size: int, compressed_size: int, num_values: int) -> bytes:
    """The dictionary page's header.

    Its own encoding is PLAIN — the modern pairing with an RLE_DICTIONARY data page. The legacy
    pairing put PLAIN_DICTIONARY on both, which recent readers still accept but no longer produce.
    """
    w = thrift.Writer()
    w.struct_begin()
    w.i32(1, schema.DICTIONARY_PAGE)
    w.i32(2, raw_size)
    w.i32(3, compressed_size)
    w.field_begin(7, thrift.STRUCT)  # dictionary_page_header
    w.struct_begin()
    w.i32(1, num_values)
    w.i32(2, schema.PLAIN)
    w.struct_end()
    w.struct_end()
    return w.bytes()


def _leaf_count(columns: list[Column]) -> int:
    """How many leaf columns the declared ones expand to: a map is two, the rest one."""
    return sum(2 if column.type.is_map else 1 for column in columns)


def _write_column_orders(w: thrift.Writer, leaves: int) -> None:
    """``column_orders`` — the field that makes the statistics USABLE.

    The spec is explicit: a reader must ignore ``min_value``/``max_value`` unless
    ``FileMetaData.column_orders`` says the sort order is TypeDefinedOrder. Without it the
    bounds are there in the bytes and no conforming reader may act on them, so every row group
    is decoded in full — which is exactly what the statistics exist to avoid. The values were
    correct; nothing was allowed to read them.

    One entry per LEAF column, in schema order — the same order the row groups list their
    chunks in, which is one per column (a list column contributes three schema elements but
    still exactly one leaf).

    ``ColumnOrder`` is a union whose only member, ``TYPE_ORDER``, holds an EMPTY struct, so
    each entry is three bytes: the union's field header, the empty struct's stop byte, and the
    union's own stop byte.
    """
    w.list_begin(7, thrift.STRUCT, leaves)
    for _ in range(leaves):
        w.struct_begin()  # ColumnOrder
        w.field_begin(1, thrift.STRUCT)  # TYPE_ORDER
        w.struct_begin()  # TypeDefinedOrder {}
        w.struct_end()
        w.struct_end()


def footer(columns: list[Column], groups: list[GroupMeta], num_rows: int) -> bytes:
    """The schema, the row-group directory, then the trailing length and magic."""
    w = thrift.Writer()
    w.struct_begin()
    w.i32(1, 1)  # version
    _write_schema(w, columns)
    w.i64(3, num_rows)
    _write_row_groups(w, columns, groups)
    w.string(6, CREATED_BY)
    _write_column_orders(w, _leaf_count(columns))
    w.struct_end()
    body = w.bytes()
    return body + struct.pack("<I", len(body)) + MAGIC


def _write_logical_type(w: thrift.Writer, mapping: schema.Mapping) -> None:
    """The LogicalType union — exactly one variant field is set."""
    if mapping.logical_field == schema.NONE:
        return
    w.field_begin(10, thrift.STRUCT)
    w.struct_begin()
    w.field_begin(mapping.logical_field, thrift.STRUCT)
    w.struct_begin()
    if mapping.logical_field == schema.LT_DECIMAL:
        w.i32(1, mapping.scale)
        w.i32(2, mapping.precision)
    elif mapping.logical_field == schema.LT_INTEGER:
        w.i8(1, mapping.bit_width)
        w.bool(2, mapping.signed)
    elif mapping.logical_field == schema.LT_TIMESTAMP:
        w.bool(1, True)  # isAdjustedToUTC
        w.field_begin(2, thrift.STRUCT)  # TimeUnit union
        w.struct_begin()
        w.field_begin(1, thrift.STRUCT)  # MILLIS
        w.struct_begin()
        w.struct_end()
        w.struct_end()
    w.struct_end()
    w.struct_end()


def _write_schema(w: thrift.Writer, columns: list[Column]) -> None:
    # The root plus every SchemaElement — a list contributes three, not one.
    elements = sum(
        3 if column.type.is_list else 4 if column.type.is_map else 1 for column in columns
    )
    w.list_begin(2, thrift.STRUCT, elements + 1)

    # The root element: a name and the child count, nothing else.
    w.struct_begin()
    w.string(4, "schema")
    w.i32(5, len(columns))
    w.struct_end()

    for column in columns:
        if column.type.is_map:
            _write_map_schema(w, column.name, column.type.element)
            continue
        if column.type.is_list:
            _write_list_schema(w, column.name, column.type.element)
            continue
        mapping = schema.map_type(column.type)
        w.struct_begin()
        w.i32(1, mapping.physical)
        if mapping.type_length > 0:
            w.i32(2, mapping.type_length)
        w.i32(3, schema.OPTIONAL if column.type.nullable else schema.REQUIRED)
        w.string(4, column.name)
        if mapping.converted_type != schema.NONE:
            w.i32(6, mapping.converted_type)
        if mapping.logical_field == schema.LT_DECIMAL:
            w.i32(7, mapping.scale)
            w.i32(8, mapping.precision)
        _write_logical_type(w, mapping)
        w.struct_end()


def _write_list_schema(w: thrift.Writer, name: str, element: ColumnType) -> None:
    """The three-element LIST wrapper.

    The names ``list`` and ``element`` are fixed by the format rather than chosen here; readers
    match on the annotated shape.
    """
    w.struct_begin()
    w.i32(3, schema.REQUIRED)
    w.string(4, name)
    w.i32(5, 1)  # num_children
    w.i32(6, schema.CT_LIST)
    w.field_begin(10, thrift.STRUCT)  # logicalType
    w.struct_begin()
    w.field_begin(schema.LT_LIST, thrift.STRUCT)
    w.struct_begin()
    w.struct_end()
    w.struct_end()
    w.struct_end()

    w.struct_begin()
    w.i32(3, schema.REPEATED)
    w.string(4, "list")
    w.i32(5, 1)  # num_children
    w.struct_end()

    mapping = schema.map_type(element)
    w.struct_begin()
    w.i32(1, mapping.physical)
    if mapping.type_length > 0:
        w.i32(2, mapping.type_length)
    w.i32(3, schema.OPTIONAL if element.nullable else schema.REQUIRED)
    w.string(4, "element")
    if mapping.converted_type != schema.NONE:
        w.i32(6, mapping.converted_type)
    if mapping.logical_field == schema.LT_DECIMAL:
        w.i32(7, mapping.scale)
        w.i32(8, mapping.precision)
    _write_logical_type(w, mapping)
    w.struct_end()


def _write_map_schema(w: thrift.Writer, name: str, value: ColumnType) -> None:
    """The four-element MAP wrapper.

    The names ``key_value``, ``key`` and ``value`` are fixed by the Parquet spec, not our choice;
    readers match on the annotated shape and quietly mis-assemble anything else. The key is
    REQUIRED because the format says so: a pair with no key is not a pair, and a reader given an
    optional key has no way to index it.
    """
    w.struct_begin()
    w.i32(3, schema.REQUIRED)
    w.string(4, name)
    w.i32(5, 1)  # num_children
    w.i32(6, schema.CT_MAP)
    w.field_begin(10, thrift.STRUCT)  # logicalType
    w.struct_begin()
    w.field_begin(schema.LT_MAP, thrift.STRUCT)
    w.struct_begin()
    w.struct_end()
    w.struct_end()
    w.struct_end()

    w.struct_begin()
    w.i32(3, schema.REPEATED)
    w.string(4, "key_value")
    w.i32(5, 2)  # num_children — the key and the value
    w.struct_end()

    key_mapping = schema.map_type(_KEY_TYPE)
    w.struct_begin()
    w.i32(1, key_mapping.physical)
    w.i32(3, schema.REQUIRED)
    w.string(4, "key")
    if key_mapping.converted_type != schema.NONE:
        w.i32(6, key_mapping.converted_type)
    _write_logical_type(w, key_mapping)
    w.struct_end()

    mapping = schema.map_type(value)
    w.struct_begin()
    w.i32(1, mapping.physical)
    if mapping.type_length > 0:
        w.i32(2, mapping.type_length)
    w.i32(3, schema.OPTIONAL if value.nullable else schema.REQUIRED)
    w.string(4, "value")
    if mapping.converted_type != schema.NONE:
        w.i32(6, mapping.converted_type)
    if mapping.logical_field == schema.LT_DECIMAL:
        w.i32(7, mapping.scale)
        w.i32(8, mapping.precision)
    _write_logical_type(w, mapping)
    w.struct_end()


def _write_statistics(w: thrift.Writer, stats: statistics.Result) -> None:
    """parquet.thrift's ``Statistics``, field 12 of ColumnMetaData.

    Only the null count and the min/max VALUE fields — never the deprecated min/max, whose
    signedness readers historically disagreed about. A bound a reader may misinterpret is as
    dangerous as a bound that is simply wrong.
    """
    w.field_begin(12, thrift.STRUCT)
    w.struct_begin()
    w.i64(3, stats.null_count)
    if stats.max_value is not None:
        w.binary(5, stats.max_value)
    if stats.min_value is not None:
        w.binary(6, stats.min_value)
    w.struct_end()


def _write_row_groups(w: thrift.Writer, columns: list[Column], groups: list[GroupMeta]) -> None:
    w.list_begin(4, thrift.STRUCT, len(groups))
    for group in groups:
        w.struct_begin()
        w.list_begin(1, thrift.STRUCT, len(group.chunks))  # columns
        total_byte_size = 0
        for chunk in group.chunks:
            total_byte_size += chunk.total_size
            mapping = schema.map_type(chunk.physical_type)

            w.struct_begin()
            w.i64(2, chunk.offset)  # file_offset — the dictionary page when there is one
            w.field_begin(3, thrift.STRUCT)  # meta_data
            w.struct_begin()
            w.i32(1, mapping.physical)
            # PLAIN always appears: it is how the dictionary page itself is written, and how the
            # values are written when there is no dictionary. A list always carries levels, so RLE
            # is always among its encodings too.
            encodings = [schema.PLAIN]
            if chunk.has_levels:
                encodings.append(schema.RLE)
            if chunk.has_dictionary:
                encodings.append(schema.RLE_DICTIONARY)
            w.list_begin(2, thrift.I32, len(encodings))
            for e in encodings:
                w.list_i32(e)
            # The chunk addresses the LEAF, so a list's path walks through its wrapper and a
            # map's names which of its two columns this is.
            w.list_begin(3, thrift.BINARY, len(chunk.path))  # path_in_schema
            for segment in chunk.path:
                w.list_string(segment)
            w.i32(4, chunk.codec)
            w.i64(5, chunk.num_values)
            w.i64(6, chunk.raw_size)  # total_uncompressed_size
            w.i64(7, chunk.total_size)  # total_compressed_size
            w.i64(9, chunk.data_offset)  # data_page_offset
            # Field 11 must be written between 9 and 12: the compact protocol encodes field ids as
            # ascending deltas, so writing it out of order would corrupt every field after it.
            if chunk.has_dictionary:
                w.i64(11, chunk.dictionary_offset)
            _write_statistics(w, chunk.stats)
            w.struct_end()
            w.struct_end()
        w.i64(2, total_byte_size)  # total_byte_size
        w.i64(3, group.num_rows)
        w.struct_end()
