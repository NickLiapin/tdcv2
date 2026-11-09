/**
 * `uniq="true"` on a `<gen type="http">` sequence: a CHECK of the answers.
 *
 * Everywhere else `uniq` is a property of a draw — take without replacement, or
 * rearrange — and a service's answer is neither: it belongs to the row it was
 * asked for, and the service answers each row once. So the run cannot MAKE the
 * column unique. What it can do is refuse to write a file that claims to be
 * unique and is not: every answer is read once, before the first row goes out,
 * and the first repeat stops the run with the two rows that share it.
 *
 * The hunt is the disk engines' own — an external sort — so it holds a sort
 * buffer, not the column. A blank answer is no value at all (`on_error="empty"`,
 * a `parent=` row the child does not hold, a `missing=` draw) and repeats freely.
 */

import { findDuplicateGroups } from './exact-uniq.js';
import { type SequenceRegistry, type SequenceSpec, sequenceValueAt } from './types.js';

/** The sequences whose `uniq="true"` is a check of a service's answers. */
export function httpUniqSequences(specs: readonly SequenceSpec[]): readonly string[] {
  return specs.filter((s) => s.uniq === true && s.gen?.type === 'http').map((s) => s.name);
}

/** Throw, naming the first repeated answer, unless every non-blank answer of `name` differs. */
export function checkHttpAnswersUnique(
  name: string,
  registry: SequenceRegistry,
  count: number,
): void {
  const sequence = registry[name];
  if (sequence === undefined) return;
  const valueAt = (row: number): string => sequenceValueAt(sequence, row) ?? '';
  function* keyed(): Generator<{ index: number; key: string }> {
    for (let i = 0; i < count; i++) {
      const key = valueAt(i);
      if (key !== '') yield { index: i, key };
    }
  }
  // The groups arrive in key order; the one reported is the first a reader of
  // the file would meet — the lowest row that repeats an answer above it.
  let first: readonly number[] | undefined;
  let repeats = 0;
  for (const group of findDuplicateGroups(keyed())) {
    repeats += group.length - 1;
    if (first === undefined || (group[1] ?? 0) < (first[1] ?? 0)) first = group;
  }
  if (first === undefined) return;
  const [a = 0, b = 0] = first;
  throw new Error(
    `uniq="true" on "${name}": the service answered "${valueAt(a)}" on row ${String(a + 1)} ` +
      `and again on row ${String(b + 1)}` +
      (repeats > 1 ? ` (${String(repeats)} rows repeat an earlier answer)` : '') +
      ' — uniq on an http column checks the answers; it cannot ask the service for others',
  );
}
