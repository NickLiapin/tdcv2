//! Thrift's compact protocol, write side only.
//!
//! Parquet keeps its page headers and its entire footer in this encoding, so a
//! file cannot be produced without it. Small and completely specified — and
//! unforgiving: one wrong byte and no reader will open the file, with nothing to
//! say about which byte. That is why it lives on its own and is checked against
//! known bytes.

/// Compact type ids. A boolean carries its value in the field header rather than
/// after it.
pub const BOOLEAN_TRUE: u8 = 1;
pub const BOOLEAN_FALSE: u8 = 2;
pub const BYTE: u8 = 3;
pub const I16_TYPE: u8 = 4;
pub const I32_TYPE: u8 = 5;
pub const I64_TYPE: u8 = 6;
pub const DOUBLE_TYPE: u8 = 7;
pub const BINARY: u8 = 8;
pub const LIST_TYPE: u8 = 9;
pub const SET_TYPE: u8 = 10;
pub const MAP_TYPE: u8 = 11;
pub const STRUCT_TYPE: u8 = 12;

#[derive(Default)]
pub struct Thrift {
    out: Vec<u8>,
    /// Field ids are written as a delta from the previous field of the same
    /// struct.
    last_field_id: i32,
    stack: Vec<i32>,
}

/// Unsigned LEB128: seven bits per byte, the top bit meaning "more follows".
pub fn varint(value: u64) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut v = value;
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v > 0 {
            b |= 0x80;
        }
        buffer.push(b);
        if v == 0 {
            break;
        }
    }
    buffer
}

/// Fold a signed 32-bit value onto an unsigned one so small magnitudes stay
/// short.
pub fn zigzag32(value: i32) -> u64 {
    u64::from(((value << 1) ^ (value >> 31)) as u32)
}

pub fn zigzag64(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

impl Thrift {
    pub fn new() -> Thrift {
        Thrift::default()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.out
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.out
    }

    /// How many bytes so far — what page and footer offsets are filled in from.
    pub fn len(&self) -> usize {
        self.out.len()
    }

    pub fn is_empty(&self) -> bool {
        self.out.is_empty()
    }

    fn raw(&mut self, b: u8) {
        self.out.push(b);
    }

    pub fn raw_bytes(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
    }

    pub fn struct_begin(&mut self) {
        self.stack.push(self.last_field_id);
        self.last_field_id = 0;
    }

    pub fn struct_end(&mut self) {
        self.raw(0x00); // struct stop
        self.last_field_id = self.stack.pop().unwrap_or(0);
    }

    /// A field header: the short form when the id delta fits in four bits, the
    /// long form otherwise.
    pub fn field_begin(&mut self, id: i32, kind: u8) {
        let delta = id - self.last_field_id;
        if delta > 0 && delta <= 15 {
            self.raw(((delta as u8) << 4) | kind);
        } else {
            self.raw(kind);
            let bytes = varint(zigzag32(id));
            self.raw_bytes(&bytes);
        }
        self.last_field_id = id;
    }

    /// A boolean has no value bytes: true and false are two different field
    /// types.
    pub fn bool(&mut self, id: i32, value: bool) {
        self.field_begin(id, if value { BOOLEAN_TRUE } else { BOOLEAN_FALSE });
    }

    /// Thrift's `i8` — one raw byte, NOT zigzagged the way i16/i32/i64 are.
    ///
    /// `LogicalType.IntType.bitWidth` is declared i8, and writing it as an i32
    /// would shift every field after it by a byte.
    pub fn i8(&mut self, id: i32, value: i32) {
        self.field_begin(id, BYTE);
        self.raw(value as u8);
    }

    pub fn i32(&mut self, id: i32, value: i32) {
        self.field_begin(id, I32_TYPE);
        let bytes = varint(zigzag32(value));
        self.raw_bytes(&bytes);
    }

    pub fn i64(&mut self, id: i32, value: i64) {
        self.field_begin(id, I64_TYPE);
        let bytes = varint(zigzag64(value));
        self.raw_bytes(&bytes);
    }

    pub fn binary_field(&mut self, id: i32, value: &[u8]) {
        self.field_begin(id, BINARY);
        let length = varint(value.len() as u64);
        self.raw_bytes(&length);
        self.raw_bytes(value);
    }

    pub fn string(&mut self, id: i32, value: &str) {
        self.binary_field(id, value.as_bytes());
    }

    /// Open a list field. Its elements follow with the `list_*` writers and carry
    /// no field headers of their own; a list of structs uses
    /// [`Thrift::struct_begin`] and [`Thrift::struct_end`].
    pub fn list_begin(&mut self, id: i32, element_type: u8, size: usize) {
        self.field_begin(id, LIST_TYPE);
        if size < 15 {
            self.raw(((size as u8) << 4) | element_type);
        } else {
            self.raw((0x0f << 4) | element_type);
            let bytes = varint(size as u64);
            self.raw_bytes(&bytes);
        }
    }

    pub fn list_i32(&mut self, value: i32) {
        let bytes = varint(zigzag32(value));
        self.raw_bytes(&bytes);
    }

    pub fn list_i64(&mut self, value: i64) {
        let bytes = varint(zigzag64(value));
        self.raw_bytes(&bytes);
    }

    pub fn list_string(&mut self, value: &str) {
        let bytes = value.as_bytes();
        let length = varint(bytes.len() as u64);
        self.raw_bytes(&length);
        self.raw_bytes(bytes);
    }
}
