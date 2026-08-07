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
import { applyOffset, parseOffset } from '../date/calendar.js';
import type { OffsetSpec } from '../date/calendar.js';
import { sequenceValueAt } from './types.js';
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
    let start;
    try {
      start = parseDateTimeStrict(from.trim()).value;
    } catch {
      // A column holds the TEXT it was formatted to, and the default format is
      // the locale's short one — `02/03/2026` in en, `03.02.2026` in ru. There
      // is no reading of `02/03/2026` that is right in both, so this refuses
      // instead of guessing, and names the one-attribute fix. Making any format
      // work means carrying the source's own date beside its text, which is the
      // next piece of work rather than a guess made here.
      throw new DateOffsetError(
        `date offset ("${spec.name}"): "${from}" in column "${offsetOf(spec)}" is not a date ` +
          'this can measure from. Give that column format="YYYY-MM-DD" — an offset reads the ' +
          'text the column holds, and only the ISO form has one reading in every locale.',
      );
    }
    const steps = drawSteps(offset, prng);
    values[i] = formatDateTime(applyOffset(start, offset, steps), format, locale);
  }
  registry[spec.name] = { name: spec.name, values };
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
