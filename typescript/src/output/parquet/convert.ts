/**
 * Rendered text -> a typed value for the declared column type.
 *
 * The engine produces strings; a typed container needs real values. Everything
 * that cannot be represented exactly is an ERROR, never a silent rounding or a
 * truncation — a synthetic dataset that quietly loses digits is worse than one
 * that refuses to be written.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §5.
 */

import type { ColumnType } from '../column-type.js';

import { halfBits, halfToNumber } from './plain.js';

/** A value ready for PLAIN encoding; `null` means the column is NULL on this row. */
export type TypedValue = null | boolean | number | bigint | string | Uint8Array;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MS_PER_DAY = 86400000;

function toInteger(text: string, what: string): bigint {
  if (!/^[+-]?\d+$/.test(text)) throw new Error(`"${text}" is not an integer (${what})`);
  return BigInt(text);
}

function toDays(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`"${text}" is not a date (expected YYYY-MM-DD)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0..99 onto 1900..1999 — undo that.
  if (year < 100) dt.setUTCFullYear(year);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`"${text}" is not a date (no such calendar day)`);
  }
  return Math.floor(dt.getTime() / MS_PER_DAY);
}

/**
 * An ISO-8601 instant in milliseconds, with NO ZONE MEANING UTC.
 *
 * This used to be `Date.parse`, and ECMAScript says a date-time with no offset
 * is LOCAL time. The column is written `isAdjustedToUTC=true`, so the same
 * config on two machines produced two different instants under one label:
 *
 *     TZ=UTC         2020-06-05 00:00+00:00
 *     TZ=Asia/Tokyo  2020-06-04 15:00+00:00     <- a different DAY
 *
 * and three different files, byte for byte. `toDays` above already builds its
 * value with `Date.UTC` for exactly this reason; the two were inconsistent
 * inside one file.
 *
 * The grammar is deliberately narrower than `Date.parse`, which also accepts
 * things like "May 25, 1996" — an input nobody writes on purpose here, and one
 * whose meaning varies by host.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function toMillis(text: string): number {
  const m = ISO_INSTANT.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a timestamp (expected ISO-8601)`);
  const [, y, mo, d, hh = '0', mi = '0', ss = '0', frac = '', zone] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mi),
    Number(ss),
    Number(frac.padEnd(3, '0')),
  );
  if (!Number.isFinite(ms)) throw new Error(`"${text}" is not a timestamp (expected ISO-8601)`);
  if (zone === undefined || zone === 'Z') return ms;
  const sign = zone.startsWith('-') ? 1 : -1;
  const [zh, zm] = zone.slice(1).replace(':', '').match(/\d{2}/g) ?? ['0', '0'];
  return ms + sign * (Number(zh) * 60 + Number(zm)) * 60_000;
}

function toDecimal(text: string, precision: number, scale: number): bigint {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new Error(`"${text}" is not a decimal`);
  const fraction = m[3] ?? '';
  if (fraction.length > scale) {
    throw new Error(
      `"${text}" has more decimal places than the declared scale ${String(scale)} — refusing to round`,
    );
  }
  const digits = (m[2] ?? '') + fraction.padEnd(scale, '0');
  const significant = digits.replace(/^0+/, '');
  if (significant.length > precision) {
    throw new Error(`"${text}" exceeds the declared precision ${String(precision)}`);
  }
  const unscaled = BigInt(digits) * (m[1] === '-' ? -1n : 1n);
  if (unscaled < INT64_MIN || unscaled > INT64_MAX) {
    throw new Error(`"${text}" does not fit a 64-bit decimal`);
  }
  return unscaled;
}

function toUuidBytes(text: string): Uint8Array {
  const hex = text.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`"${text}" is not a uuid`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Parse an unsigned integer of `bits` width, refusing negatives outright. */
function toUnsigned(text: string, raw: string, bits: bigint): bigint {
  const v = toInteger(text, `uint${String(bits)}`);
  if (v < 0n) throw new Error(`"${raw}" is negative, but the column is unsigned`);
  const limit = (1n << bits) - 1n;
  if (v > limit) throw new Error(`"${raw}" is out of range for uint${String(bits)}`);
  return v;
}

/**
 * Convert one rendered cell. Throws a message describing the value and the
 * expectation; the writer adds the column name and row index around it.
 */
export function convertValue(raw: string, type: ColumnType): TypedValue {
  if (raw === '') {
    if (type.nullable) return null;
    throw new Error('empty value in a required column (add |null to allow NULL)');
  }
  const text = raw.trim();

  switch (type.kind) {
    case 'bool': {
      const v = text.toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      throw new Error(`"${raw}" is not a boolean (expected true/false or 1/0)`);
    }
    case 'int32': {
      const v = toInteger(text, 'int32');
      if (v < BigInt(INT32_MIN) || v > BigInt(INT32_MAX)) {
        throw new Error(`"${raw}" is out of range for int32`);
      }
      return Number(v);
    }
    case 'int64': {
      const v = toInteger(text, 'int64');
      if (v < INT64_MIN || v > INT64_MAX) throw new Error(`"${raw}" is out of range for int64`);
      return v;
    }
    case 'uint8':
      return Number(toUnsigned(text, raw, 8n));
    case 'uint16':
      return Number(toUnsigned(text, raw, 16n));
    case 'uint32':
      // Stored in a signed INT32 slot: values above 2^31-1 wrap to negative
      // bits, which is exactly what the UINT_32 annotation tells readers to
      // undo. Number() would keep them positive and write the wrong bytes.
      return Number(BigInt.asIntN(32, toUnsigned(text, raw, 32n)));
    case 'uint64':
      return BigInt.asIntN(64, toUnsigned(text, raw, 64n));
    case 'float': {
      const v = Number(text);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      // Round to what a 4-byte float can actually hold, so the value in memory
      // is the value on disk — otherwise the column statistics would describe
      // numbers the file does not contain.
      const rounded = Math.fround(v);
      if (!Number.isFinite(rounded)) throw new Error(`"${raw}" is out of range for float`);
      return rounded;
    }
    case 'float16': {
      const v = Number(text);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      const rounded = halfToNumber(halfBits(v));
      if (!Number.isFinite(rounded)) throw new Error(`"${raw}" is out of range for float16`);
      return rounded;
    }
    case 'double': {
      const v = Number(text);
      if (!Number.isFinite(v)) throw new Error(`"${raw}" is not a number`);
      return v;
    }
    case 'date':
      return toDays(text);
    case 'timestamp':
      return BigInt(toMillis(text));
    case 'decimal':
      return toDecimal(text, type.precision ?? 18, type.scale ?? 0);
    case 'uuid':
      return toUuidBytes(text);
    case 'string':
    case 'enum':
    case 'json':
      return raw; // pass through untouched, including surrounding spaces
  }
}
