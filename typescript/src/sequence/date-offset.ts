/**
 * `<gen type="date" of="Admitted" plus="3..10d">` — a date measured from another date.
 *
 * The interval is in almost every real record — admitted and discharged, ordered
 * and shipped, issued and expires, the start and end of a shift — and it could
 * not be said at all. Two independent date columns put the discharge BEFORE the
 * admission on a third of the rows, and the workaround people reach for,
 * non-overlapping windows ("admitted in January, discharged April to June"),
 * throws away exactly what the interval is for: its length, and how that length
 * is distributed. "Most stay a week, a few stay months" had no way to be written.
 *
 * ── Why it is not a generator ─────────────────────────────────────────────────
 *
 * A `Generator` is `(count, prng) => string[]` and sees no other column, by
 * design — that is what makes a column's values a function of the seed and the
 * row index alone. This reads a sibling, so it is built here beside `running`
 * and `stat`, in declaration order, which is also why `of=` must name a column
 * declared ABOVE it.
 *
 * ── What it costs ─────────────────────────────────────────────────────────────
 *
 * Unlike `running` and `stat`, row i's answer needs only row i of the source —
 * nothing accumulates and nothing waits for the last row. It is refused by the
 * streaming builder today all the same, because the streaming path has no way to
 * read a sibling column lazily (the same reason a dynamic template defers), and
 * the router hands the config to the in-memory engine. That is a limit of the
 * plumbing rather than of the idea, and it is the one worth lifting first if
 * these configs turn out to be large.
 */

import { formatDateTime, parseDateTimeStrict } from '../date/index.js';
import type { PlainDateTime } from '../date/index.js';
import { applyOffset, fromEpochMillis, parseOffset } from '../date/calendar.js';
import type { OffsetSpec } from '../date/calendar.js';
import { sequenceInstantAt, sequenceValueAt } from './types.js';
import type { Sequence, SequenceSpec } from './types.js';

/** A source column an offset cannot read. */
export class DateOffsetError extends Error {
  public override readonly name = 'DateOffsetError';
}

/** The column this date is measured from, or `''` when the generator did not say. */
export function offsetOf(spec: SequenceSpec): string {
  return (spec.gen?.attrs['of'] ?? '').trim();
}

/** True when this `<gen type="date">` is an offset rather than a draw. */
export function isDateOffset(spec: SequenceSpec): boolean {
  return spec.gen?.type === 'date' && offsetOf(spec) !== '';
}

/**
 * Publish the offset column.
 *
 * One draw per row, and only when the offset is a RANGE: `plus="7d"` is a fixed
 * distance and consumes no randomness at all, so a config that pins the interval
 * leaves every other column exactly where it was.
 *
 * A row whose source is empty — outside a parent filter, or a source that was
 * itself filtered — stays empty. There is no date to measure from, and inventing
 * one would put a value in a cell the config said should have none.
 */
export function registerDateOffset(
  spec: SequenceSpec,
  registry: Record<string, Sequence>,
  count: number,
  prng: () => number,
  locale: string,
): void {
  const source = registry[offsetOf(spec)];
  if (!source) return; // unknown column — the validator reports it

  const attrs = spec.gen?.attrs ?? {};
  const parsed = parseOffset(attrs['plus']);
  if (!parsed.ok) return; // a bad plus= is a diagnostic, not a crash
  const offset: OffsetSpec = parsed.offset;

  const format = (attrs['format'] ?? '').trim() || 'L';
  const values = new Array<string | undefined>(count);
  for (let i = 0; i < count; i++) {
    const from = sequenceValueAt(source, i);
    if (from === undefined || from.trim() === '') {
      values[i] = undefined;
      continue;
    }
    const start = startOfRow(spec, source, i, from);
    if (!start) {
      values[i] = undefined;
      continue;
    }
    const steps = drawSteps(offset, prng);
    values[i] = formatDateTime(applyOffset(start, offset, steps), format, locale);
  }
  registry[spec.name] = { name: spec.name, values };
}

/**
 * The date row `i` is measured FROM, or `undefined` when the row has none.
 *
 * Three readings, in this order:
 *
 *   1. **The instant the source column kept.** A `<gen type="date">` this engine
 *      built remembers what it generated, so the offset works from the value and
 *      `format=` is free to be anything at all — the cell may read `March 2` or
 *      `02.03.2026` and the arithmetic is the same either way. This is the whole
 *      point of keeping the value beside its rendering.
 *   2. **No instant on a column that carries them.** `missing="0.1"` blanked
 *      that cell: the source column HAS a date for other rows and none for this
 *      one. The offset has nothing to measure and the cell stays empty — the
 *      same answer a parent filter gets, and the reason this is worth
 *      distinguishing from a text it cannot read.
 *   3. **The text, read as ISO.** A date that came from a file, a pack, or a
 *      construct that does not carry an instant has only its spelling left. The
 *      ISO form has one reading in every locale, so it is accepted; anything
 *      else is refused rather than guessed at, because `02/03/2026` is the 2nd
 *      of March in one locale and the 3rd of February in another, and picking
 *      one silently would put a wrong date in a column that looks right.
 */
function startOfRow(
  spec: SequenceSpec,
  source: Sequence,
  i: number,
  from: string,
): PlainDateTime | undefined {
  if (source.instants) {
    const instant = sequenceInstantAt(source, i);
    return instant === undefined ? undefined : fromEpochMillis(instant);
  }
  try {
    return parseDateTimeStrict(from.trim()).value;
  } catch {
    throw new DateOffsetError(
      `date offset ("${spec.name}"): "${from}" in column "${offsetOf(spec)}" is not a date ` +
        'this can measure from. A date TDC generated carries its own value and any format= ' +
        'works; one read from a file or a pack has only its text, and only the ISO form ' +
        '(YYYY-MM-DD) means the same thing in every locale.',
    );
  }
}

/**
 * How many steps this row moves.
 *
 * A fixed offset takes no draw, which is what lets `plus="7d"` be added to a
 * config without shifting any other column. A range takes exactly one, so the
 * cost is the same as any other single-value generator.
 */
function drawSteps(offset: OffsetSpec, prng: () => number): number {
  if (offset.lo === offset.hi) return offset.lo;
  const span = offset.hi - offset.lo + 1;
  return offset.lo + Math.min(span - 1, Math.floor(prng() * span));
}
