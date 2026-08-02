/**
 * Value model for the `compute` declarative computation layer.
 *
 * Exactly three value types (spec §5): `int` (signed 64-bit, held as BigInt so
 * the semantics match the future Python/Java ports), `str` (Unicode string), and
 * `list` (ordered sequence of int|str). There is no boolean and no float.
 *
 * Coercion rules (spec §8):
 *   - Arithmetic coerces a *1-character digit* string to int; a multi-character
 *     or non-numeric string in an arithmetic slot is an error (use <to_number>).
 *   - String contexts (<join>, <concat>, <pad>, final output) coerce an int to
 *     its decimal form; a whole list is never a string.
 *
 * All runtime failures throw `ComputeError`; static/structural problems are
 * caught earlier by the validator (`checkCompute`).
 */

export type Value =
  | { readonly t: 'int'; readonly v: bigint }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'list'; readonly v: readonly Value[] };

/** Runtime error raised while evaluating a compute tree. */
export class ComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputeError';
  }
}

// Signed 64-bit bounds. Kept explicit so overflow is a deterministic error in
// every language implementation rather than a silent wrap.
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Wrap a BigInt as an `int` value, guarding the signed 64-bit range. */
export function int(v: bigint): Value {
  return { t: 'int', v: guard64(v) };
}

/** Wrap a string as a `str` value. */
export function str(v: string): Value {
  return { t: 'str', v };
}

/** Wrap an array as a `list` value. */
export function list(v: readonly Value[]): Value {
  return { t: 'list', v };
}

/** Throw if `v` leaves the signed 64-bit range; otherwise return it unchanged. */
export function guard64(v: bigint): bigint {
  if (v < INT64_MIN || v > INT64_MAX) {
    throw new ComputeError(`integer overflow: ${v.toString()} is outside the signed 64-bit range`);
  }
  return v;
}

/**
 * Coerce a value to `bigint` for arithmetic. An int passes through; a
 * *single* digit character coerces; anything else is an error — a multi-digit
 * string must be converted explicitly with <to_number>, which keeps the intent
 * unambiguous.
 */
export function coerceInt(value: Value, context = 'arithmetic'): bigint {
  if (value.t === 'int') return value.v;
  if (value.t === 'str') {
    if (/^[0-9]$/.test(value.v)) return BigInt(value.v);
    const hint = /^-?[0-9]+$/.test(value.v)
      ? ' — wrap it in <to_number> to convert a multi-digit string'
      : '';
    throw new ComputeError(`expected an integer in ${context}, got the string "${value.v}"${hint}`);
  }
  throw new ComputeError(`expected an integer in ${context}, got a list`);
}

/** Coerce an int or str to its string form. A list is never a string. */
export function coerceStr(value: Value): string {
  if (value.t === 'str') return value.v;
  if (value.t === 'int') return value.v.toString();
  throw new ComputeError('cannot use a list where a string is expected');
}

/** Final compute output: an int or str renders to text; a list is an error. */
export function valueToOutput(value: Value): string {
  if (value.t === 'list') {
    throw new ComputeError('compute result must be an int or str, not a list');
  }
  return coerceStr(value);
}

/** Parse a `<to_number>` string: all decimal digits, optional leading `-`. */
export function parseIntStrict(s: string): bigint {
  if (!/^-?[0-9]+$/.test(s)) {
    throw new ComputeError(`<to_number>: "${s}" is not a valid integer`);
  }
  return guard64(BigInt(s));
}

/**
 * Euclidean remainder: always non-negative, in `[0, |b|)`, independent of the
 * host language's native `%` sign convention (spec §7.4).
 */
export function euclideanMod(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new ComputeError('<mod>: the modulus (second child) must not be zero');
  const abs = b < 0n ? -b : b;
  const r = a % abs;
  return r < 0n ? r + abs : r;
}

/** Floor (toward −∞) integer division (spec §7.4). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new ComputeError('<divide>: the divisor (second child) must not be zero');
  let q = a / b;
  if (a % b !== 0n && a < 0n !== b < 0n) q -= 1n;
  return q;
}
