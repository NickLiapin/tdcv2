/**
 * `uniq="true"` enforcement, and the redraw that rescues an unlucky draw.
 *
 * Split out of `build.ts` when that file hit its line ceiling; the logic here
 * is self-contained apart from one hook. `enforceUniqRedrawing` needs to draw
 * fresh values, which `build.ts` knows how to do and this module must not
 * import back — so the caller passes a `Redraw` closure over its own PRNG,
 * locale and context.
 */

import type { GenSpec, SequenceSpec } from './types.js';
import { arrangeUnique, uniqUpperBound, valueCounts } from './uniq.js';

/** Draw `count` fresh values for one field, from the caller's PRNG stream. */
export type Redraw = (gen: GenSpec, count: number) => string[];

/**
 * Enforce `uniq="true"` on a compound sequence: rearrange the field columns
 * (in field-declaration order) so every row's tuple is unique across the
 * dataset. Column multisets are preserved (percentages untouched). Throws a
 * clear error before any output if the data cannot supply `count` distinct
 * combinations — a fast upper-bound reject first, then the authoritative
 * result of the constructive builder.
 */
function enforceUniq(
  spec: SequenceSpec,
  produced: Map<string, string[]>,
  applicableCount: number,
): void {
  const fields = spec.gens ?? [];
  const columns = fields.map((field) => produced.get(field.name) ?? []);
  const columnCounts = columns.map(valueCounts);

  const upper = uniqUpperBound(columnCounts);
  if (applicableCount > upper) {
    throw new UniqInfeasibleError(`uniq: sequence "${spec.name}" is infeasible`, upper);
  }

  const { columns: arranged, distinct } = arrangeUnique(columns);
  if (distinct < applicableCount) {
    throw new UniqInfeasibleError(`uniq: sequence "${spec.name}" is infeasible`, distinct);
  }

  fields.forEach((field, i) => {
    produced.set(field.name, arranged[i] ?? []);
  });
}

/** Thrown by `enforceUniq` alone, so the retry below can tell it apart. */
class UniqInfeasibleError extends Error {
  constructor(
    message: string,
    readonly achievable: number,
  ) {
    super(message);
    this.name = 'UniqInfeasibleError';
  }
}

/**
 * How many redraws to try before giving up. Each one is a fresh sample from
 * the same PRNG stream, so the whole retry is deterministic; the cap keeps a
 * genuinely impossible config from spinning.
 */
const UNIQ_REDRAW_ATTEMPTS = 8;

/**
 * `uniq="true"`, and a redraw when the FIRST draw happened to be unarrangeable.
 *
 * `enforceUniq` may only rearrange the values already drawn — rearranging is
 * what keeps `percent=` exact. But when nothing pins the proportions, an
 * uneven draw is an accident of sampling, not something to protect, and the
 * old behaviour was to refuse the whole run over it:
 *
 *     4 values × 8 values, count=20   ->  32 combinations exist
 *     drawn: a1×7 a2×6 a3×3 a4×4      ->  "its data supports at most 19"
 *
 * The lists were never the problem. So: draw again and try again.
 *
 * This only runs where the old code THREW, so no config that works today
 * changes by a byte — a successful run consumes exactly the PRNG values it
 * always did. When the columns come from an exact quota (`percent=`, a
 * weighted pack) the redraw returns the same multiset in a different order,
 * which cannot help; that is detected after one attempt and reported as what
 * it is, rather than retried seven more times for nothing.
 */
export function enforceUniqRedrawing(
  spec: SequenceSpec,
  produced: Map<string, string[]>,
  applicableCount: number,
  redraw: Redraw,
): void {
  try {
    enforceUniq(spec, produced, applicableCount);
    return;
  } catch (err) {
    if (!(err instanceof UniqInfeasibleError)) throw err;
  }

  const fields = spec.gens ?? [];
  const signature = (): string =>
    fields
      .map((f) => {
        const counts = valueCounts(produced.get(f.name) ?? []);
        return [...counts.values()].sort((a, b) => a - b).join(',');
      })
      .join('|');

  let best = 0;
  const firstSignature = signature();
  for (let attempt = 0; attempt < UNIQ_REDRAW_ATTEMPTS; attempt++) {
    for (const field of fields) produced.set(field.name, redraw(field.gen, applicableCount));
    // Same value frequencies as before means the draw is quota-fixed: every
    // further attempt would produce this same multiset, so stop now.
    const quotaFixed = attempt === 0 && signature() === firstSignature;
    try {
      enforceUniq(spec, produced, applicableCount);
      return;
    } catch (err) {
      if (!(err instanceof UniqInfeasibleError)) throw err;
      best = Math.max(best, err.achievable);
      if (quotaFixed) throw new Error(uniqQuotaMessage(spec.name, applicableCount, err.achievable));
    }
  }
  throw new Error(uniqRedrawnMessage(spec.name, applicableCount, best));
}

/** The proportions are the user's requirement, so the draw cannot be changed. */
function uniqQuotaMessage(name: string, requested: number, achievable: number): string {
  return (
    `uniq: sequence "${name}" cannot produce ${String(requested)} unique combinations. ` +
    `Its values are drawn to an exact share (percent=, or a weighted pack), so their ` +
    `proportions are fixed by the config, and those proportions allow at most ` +
    `${String(achievable)} distinct rows. Add more values to a field (more distinct ` +
    'names, wider ranges…), relax the share, or lower the count.'
  );
}

/** Nothing pinned the draw, and redrawing still could not reach `requested`. */
function uniqRedrawnMessage(name: string, requested: number, achievable: number): string {
  return (
    `uniq: sequence "${name}" cannot produce ${String(requested)} unique combinations — ` +
    `${String(UNIQ_REDRAW_ATTEMPTS)} independent draws each topped out around ` +
    `${String(achievable)} distinct rows. Its fields do not hold enough distinct values ` +
    'between them. Add more values to a field (more distinct names, wider ranges…) or ' +
    'lower the count.'
  );
}
