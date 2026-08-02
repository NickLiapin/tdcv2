/**
 * `accumulate=` — a running total inside one record's `repeat` list.
 *
 * A cell holding `100,150,150` becomes `100,250,400`. That is the shape most
 * "I need a running total" questions actually have: a receipt's subtotal, the
 * elapsed time of a session, the odometer over the legs of a trip. The
 * accumulation lives inside ONE record, which is why it costs nothing — a
 * record is computed whole anyway, so rows stay independent and streaming,
 * `--jobs` and `getAt` are untouched.
 *
 * The one decision worth defending is the arithmetic. Five implementations have
 * to produce the same bytes, and floating point does not: `0.1 + 0.2` prints
 * differently in JavaScript, Python, Java, C# and Rust. So the sum is done on
 * SCALED INTEGERS. Every element is read as a fixed-point number, the widest
 * fraction in the list sets the scale, and the total is formatted back at that
 * scale by hand. No float ever touches the value, and `19.99 + 0.01` is `20.00`
 * everywhere rather than `20.000000000000004` in one of them.
 *
 * `min` and `max` are different in a useful way: their result IS one of the
 * inputs, so the winning element's own text is returned unchanged. A value that
 * arrived as `007` stays `007`.
 */

/** What a running accumulation can do. Each keeps a value that only ever moves one way. */
export type AccumulateOp = 'sum' | 'min' | 'max';

export const ACCUMULATE_OPS: readonly AccumulateOp[] = ['sum', 'min', 'max'];

export class AccumulateError extends Error {
  public override readonly name = 'AccumulateError';
}

/**
 * Read `accumulate=` where an unknown op simply means "none".
 *
 * The engine path uses this one. By the time a value is drawn the validator has
 * already refused a misspelled op (TDC238), so throwing here would only turn a
 * reported problem into a crash — the same "the validator already said so"
 * contract the rest of the engine runs on.
 */
export function readAccumulate(
  attrs: Record<string, string | undefined>,
): AccumulateOp | undefined {
  const raw = (attrs['accumulate'] ?? '').trim();
  return ACCUMULATE_OPS.includes(raw as AccumulateOp) ? (raw as AccumulateOp) : undefined;
}

/** The same, but strict — the validator's copy, which turns a bad op into a diagnostic. */
export function parseAccumulate(
  attrs: Record<string, string | undefined>,
): AccumulateOp | undefined {
  const raw = (attrs['accumulate'] ?? '').trim();
  if (raw === '') return undefined;
  if (!ACCUMULATE_OPS.includes(raw as AccumulateOp)) {
    throw new AccumulateError(`accumulate="${raw}" is not one of ${ACCUMULATE_OPS.join(', ')}`);
  }
  return raw as AccumulateOp;
}

/** A fixed-point number: `value` scaled by 10^`scale`. */
interface Fixed {
  readonly value: bigint;
  readonly scale: number;
}

/**
 * Parse one element as a fixed-point number.
 *
 * Deliberately strict. A generator that produces words has no running total,
 * and quietly treating `abc` as zero would hand back a column that adds up to
 * something and means nothing.
 */
function parseFixed(text: string): Fixed {
  const trimmed = text.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    throw new AccumulateError(
      `accumulate=: "${text}" is not a number, so there is nothing to accumulate. ` +
        'A running total needs numeric elements — accumulate= belongs on a numeric generator.',
    );
  }
  const dot = trimmed.indexOf('.');
  if (dot < 0) return { value: BigInt(trimmed), scale: 0 };
  const scale = trimmed.length - dot - 1;
  return { value: BigInt(trimmed.slice(0, dot) + trimmed.slice(dot + 1)), scale };
}

/** The same number at a wider scale — how two fractions of different width are compared. */
function rescale(n: Fixed, scale: number): bigint {
  let out = n.value;
  for (let i = n.scale; i < scale; i++) out *= 10n;
  return out;
}

/** Back to text at `scale` decimal places, with no float in the path. */
function formatFixed(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Turn a list into its running accumulation.
 *
 * An EMPTY element stays empty and leaves the accumulator alone. That is what
 * `missing=` produces, and "no reading that day" should not reset a meter or
 * count as a zero-value transaction.
 */
export function accumulateParts(parts: readonly string[], op: AccumulateOp): string[] {
  // One pass to learn the widest fraction, so every element is compared and
  // summed at the same scale. Done first because the scale of the total must
  // not depend on which elements happened to come earlier.
  let scale = 0;
  const numbers: (Fixed | undefined)[] = parts.map((p) => {
    if (p.trim() === '') return undefined;
    const n = parseFixed(p);
    if (n.scale > scale) scale = n.scale;
    return n;
  });

  const out: string[] = [];
  let acc: bigint | undefined;
  let accText: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const n = numbers[i];
    if (n === undefined) {
      out.push(parts[i] ?? '');
      continue;
    }
    const scaled = rescale(n, scale);
    if (acc === undefined) {
      acc = scaled;
      accText = parts[i] ?? '';
    } else if (op === 'sum') {
      acc += scaled;
    } else if (scaled < acc === (op === 'min')) {
      acc = scaled;
      accText = parts[i] ?? '';
    }
    // `min`/`max` return an element that already exists, so its own spelling is
    // kept; `sum` produces a new number and is formatted at the shared scale.
    out.push(op === 'sum' ? formatFixed(acc, scale) : (accText ?? ''));
  }
  return out;
}

/**
 * The same fold, but down a COLUMN instead of across a list.
 *
 * `<gen type="running">` is this: row i's value is the accumulation of every row
 * up to it. Reusing {@link accumulateParts} rather than writing a second fold is
 * deliberate — the arithmetic, the scale rule and the treatment of an empty cell
 * then cannot drift apart between the two features.
 *
 * `base` is prepended and its result dropped, which is exactly "start from an
 * opening balance": it joins the scale pool, so an opening `1000.00` widens the
 * whole column to two decimals the way a reader would expect.
 *
 * `resetAt` splits the column into segments. When it is given, each segment is
 * accumulated on its own — one running balance per account rather than one for
 * the file.
 */
export function accumulateColumn(
  values: readonly (string | undefined)[],
  op: AccumulateOp,
  base: string | undefined,
  resetAt: readonly (string | undefined)[] | undefined,
): (string | undefined)[] {
  const out = new Array<string | undefined>(values.length);
  let start = 0;
  while (start < values.length) {
    let end = start + 1;
    if (resetAt) {
      while (end < values.length && resetAt[end] === resetAt[start]) end++;
    } else {
      end = values.length;
    }
    const segment = values.slice(start, end).map((v) => v ?? '');
    const parts = base === undefined ? segment : [base, ...segment];
    const running = accumulateParts(parts, op);
    const offset = base === undefined ? 0 : 1;
    for (let i = start; i < end; i++) {
      // A row outside a parent filter has no value, and gains none: the
      // accumulator passed over it without counting it.
      out[i] = values[i] === undefined ? undefined : running[i - start + offset];
    }
    start = end;
  }
  return out;
}
