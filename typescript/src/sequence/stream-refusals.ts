/**
 * What the streaming builder refuses, and why — decided while the column is
 * built, never when a row is read.
 *
 * Every refusal here names a construct whose answer is a property of the WHOLE
 * column: a running total is the sum of the rows before it, a statistic needs
 * the rows after it as well, a date measured from a sibling needs a column the
 * lazy path cannot reach, a pack generator with a share apportions its quota
 * over the run.
 *
 * The timing is the load-bearing part. `buildExactDiskRegistry` wraps the
 * registry BUILD in a try/catch and falls back to the in-memory engine — that
 * fallback is what makes engine 3 "exact and bounded, or in memory when it
 * cannot be both". A refusal raised lazily, at the row that reads the value,
 * arrives long after that catch has returned, so it reaches the caller as an
 * error instead of a fallback. That is exactly what happened to the whole-column
 * pack check while it lived deep inside `buildGenValues`: 37 refusals fell back
 * correctly and that one escaped.
 *
 * Collected in one file because they are one idea, and because `stream-build.ts`
 * has a line ceiling that this group kept pushing it through.
 */

import { StreamUnsupportedError } from './stream-errors.js';
import type { SequenceSpec } from './types.js';

/**
 * Refuse `spec` if the streaming path cannot answer it a row at a time.
 *
 * Returns normally when it can. Ordered so the message a user sees names the
 * most specific reason: a `<gen type="date" of=…>` is a date before it is
 * anything else, and a pack generator is refused for its quota rather than for
 * being a template.
 */
export function refuseIfWholeColumn(spec: SequenceSpec): void {
  const gen = spec.gen;
  if (gen === undefined) return;

  // A running total is the one construct that genuinely cannot be answered from
  // a row index: row 900,000,000 IS the sum of everything before it. That is not
  // a gap in the streaming builder, it is what "running" means.
  if (gen.type === 'running') {
    throw new StreamUnsupportedError(
      `a running total ("${spec.name}") is the accumulation of every row before it, ` +
        'so it cannot be computed one row at a time; the in-memory engine handles it ' +
        '(run without a forced streaming engine)',
    );
  }

  // A statistic over the whole run is the stronger form of the same thing: it is
  // not knowable from the rows SO FAR either, because the rows after this one
  // are part of the answer.
  if (gen.type === 'stat') {
    throw new StreamUnsupportedError(
      `a statistic ("${spec.name}") is computed over every row of the run, including the ` +
        'ones after this one, so it cannot be computed one row at a time; the in-memory ' +
        'engine handles it (run without a forced streaming engine)',
    );
  }

  // A date measured from another date needs only the SAME row of its source, so
  // unlike a running total it is not the idea that resists streaming — the
  // streaming path simply has no way to read a sibling column lazily, which is
  // why a dynamic template defers too. Refused by name until it has one.
  if (gen.type === 'date' && (gen.attrs['of'] ?? '').trim() !== '') {
    throw new StreamUnsupportedError(
      `a date measured from another column ("${spec.name}") reads that column as the row is ` +
        'built, and the streaming path has no way to do that yet; the in-memory engine ' +
        'handles it (run without a forced streaming engine)',
    );
  }

  /*
   * A pack whose body apportions a share over the whole column used to be
   * refused here, for a real reason: computed a row at a time it handed every
   * row to the largest share — six rows of `hu.person.male.fullName` came out as
   * six copies of "Nagy László".
   *
   * The refusal is gone because the cause is. The body is now built by this same
   * lazy builder at the COLUMN's count, so the share is planned over the column
   * and each row is mapped into it, exactly as a top-level `percent=` sequence
   * has always been. A body carrying its own `<valid>` is the one shape still
   * left to the in-memory engine; `wholeColumnPackBody` hands back nothing for
   * it, and the per-row backstop in `build.ts` refuses it there.
   */

  // A network call is not a draw: it is neither reproducible from a row index
  // nor answerable synchronously, which is what a lazy per-row resolver needs.
  // Refused here rather than left to fall through, because the fall-through
  // reached the in-memory engine's synchronous guard and told a CLI user to
  // "use the CLI".
  if (gen.type === 'http') {
    throw new StreamUnsupportedError(
      `<gen type="http"> ("${spec.name}") is a network call, so it is neither ` +
        'reproducible nor answerable one row at a time; the in-memory engine handles it ' +
        '(run without a forced streaming engine)',
    );
  }
}
