/**
 * uniq — make row-tuples unique across a dataset, plus a data-free
 * feasibility predictor.
 *
 * The math is proven and validated in `docs/vision/20-uniq-research.md`; the
 * DSL integration is specified in
 * `docs/superpowers/specs/2026-07-14-uniq-design.md`. This module is the pure
 * engine core — no DSL, no I/O — so it is tested directly against a
 * brute-force oracle.
 *
 * Invariant: every function that rearranges only PERMUTES each column; a
 * column's value-multiset is never changed. So percentages/quotas set by the
 * generators are preserved exactly — uniqueness and exact distribution
 * coexist by construction.
 *
 * Three public pieces:
 *   - `uniqUpperBound` — a proven UPPER bound (Σ min propagation). If the
 *     requested count exceeds it, uniqueness is impossible → safe reject.
 *   - `uniqCapacity` — a data-free simulation of the builder → a safe LOWER
 *     bound (the builder achieves at least this, more after repair). Runs on
 *     quota numbers only, so it certifies huge configs in milliseconds
 *     without assembling any data.
 *   - `arrangeUnique` — the constructive builder (proportional fill + swap
 *     repair) that actually produces the rearranged columns.
 */

const SEP = '\u0000';

function stddev(nums: readonly number[]): number {
  const n = nums.length;
  if (n < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/** Counts of each distinct value in a column, in first-seen order. */
export function valueCounts(column: readonly string[]): number[] {
  const m = new Map<string, number>();
  for (const v of column) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.values()];
}

/** Order column-count vectors by deviation ascending (balanced first). */
function byDeviation<T>(items: readonly T[], countsOf: (t: T) => readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, index, dev: stddev(countsOf(item)) }))
    .sort((a, b) => a.dev - b.dev || a.index - b.index)
    .map((e) => e.item);
}

/**
 * Proven UPPER bound on the number of distinct tuples achievable from columns
 * with these value-counts. Never undercounts (see doc 20 for the induction
 * proof). `count > uniqUpperBound(...)` ⇒ definitely infeasible.
 */
export function uniqUpperBound(columnCounts: readonly (readonly number[])[]): number {
  let need = 1;
  for (const counts of byDeviation(columnCounts, (c) => c)) {
    let sum = 0;
    for (const c of counts) sum += Math.min(c, need);
    need = sum;
  }
  return need;
}

/**
 * Largest-remainder split of `total` rows over `parts` (each `{weight, cap}`),
 * clamped to each part's `cap`. Deterministic. Returns the integer allocation
 * aligned to `parts`.
 */
function proportionalSplit(
  total: number,
  parts: readonly { weight: number; cap: number }[],
): number[] {
  const sumW = parts.reduce((a, p) => a + p.weight, 0);
  const alloc = parts.map((p) => {
    const exact = sumW === 0 ? 0 : (total * p.weight) / sumW;
    return { base: Math.min(p.cap, Math.floor(exact)), rem: exact - Math.floor(exact), cap: p.cap };
  });
  let assigned = alloc.reduce((a, x) => a + x.base, 0);
  const order = alloc.map((x, i) => ({ i, rem: x.rem })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (assigned >= total) break;
    const a = alloc[i];
    if (a && a.base < a.cap) {
      a.base += 1;
      assigned += 1;
    }
  }
  // Any residual from clamping: round-robin over parts with room.
  for (let i = 0; assigned < total; i = (i + 1) % alloc.length) {
    const a = alloc[i];
    if (a && a.base < a.cap) {
      a.base += 1;
      assigned += 1;
    } else if (alloc.every((x) => x.base >= x.cap)) break;
  }
  return alloc.map((x) => x.base);
}

/**
 * Data-free simulation of the builder over quota numbers → a safe LOWER bound
 * on achievable distinct tuples (build+repair only ever does better). Stops
 * early once `need` is reached, since the distinct count only grows per
 * column. Milliseconds even at 1e9 rows — the feasibility check never touches
 * data.
 */
export function uniqCapacity(
  columnCounts: readonly (readonly number[])[],
  need = Number.POSITIVE_INFINITY,
): number {
  const sorted = byDeviation(columnCounts, (c) => c);
  if (sorted.length === 0) return 0;
  let profile: number[] = (sorted[0] ?? []).slice();
  for (let k = 1; k < sorted.length; k++) {
    const pool = (sorted[k] ?? []).slice();
    const next: number[] = [];
    for (const groupSize of [...profile].sort((a, b) => b - a)) {
      const live = pool.map((c, i) => ({ i, c })).filter((e) => e.c > 0);
      const split = proportionalSplit(
        groupSize,
        live.map((e) => ({ weight: e.c, cap: e.c })),
      );
      for (let x = 0; x < live.length; x++) {
        const part = split[x] ?? 0;
        const cell = live[x];
        if (part > 0 && cell) {
          next.push(part);
          pool[cell.i] = (pool[cell.i] ?? 0) - part;
        }
      }
    }
    profile = next;
    if (profile.length >= need) return profile.length; // grows only → certified
  }
  return profile.length;
}

/** Proportional builder: assemble rows so tuples are maximally distinct. */
function buildRows(columns: readonly (readonly string[])[]): string[][] {
  const first = columns[0] ?? [];
  const N = first.length;
  const rows: string[][] = first.map((v) => [v]);
  for (let k = 1; k < columns.length; k++) {
    const pool = new Map<string, number>();
    for (const v of columns[k] ?? []) pool.set(v, (pool.get(v) ?? 0) + 1);

    const groups = new Map<string, number[]>();
    for (let j = 0; j < N; j++) {
      const key = (rows[j] ?? []).join(SEP);
      const g = groups.get(key);
      if (g) g.push(j);
      else groups.set(key, [j]);
    }
    // Largest groups first — they need the most diversity.
    for (const idxs of [...groups.values()].sort((a, b) => b.length - a.length)) {
      const live = [...pool.entries()].filter(([, c]) => c > 0);
      const split = proportionalSplit(
        idxs.length,
        live.map(([, c]) => ({ weight: c, cap: c })),
      );
      const deck: string[] = [];
      for (let x = 0; x < live.length; x++) {
        const entry = live[x];
        const times = split[x] ?? 0;
        if (entry) for (let t = 0; t < times; t++) deck.push(entry[0]);
      }
      deck.sort();
      let di = 0;
      for (const j of idxs) {
        const v = deck[di++] ?? deck[deck.length - 1] ?? '';
        pool.set(v, (pool.get(v) ?? 0) - 1);
        const row = rows[j];
        if (row) row.push(v);
      }
    }
  }
  return rows;
}

/**
 * Swap-repair: while a row is a duplicate, swap one of its column cells with
 * another row's cell in the same column when that strictly lowers the total
 * duplicate count. Column multisets are preserved by construction (a swap
 * moves values within one column). O(N²·K) per sweep — fine for the RAM
 * engine's scope; the streaming path uses a different mechanism entirely.
 */
function repairRows(rows: string[][], maxSweeps = 8): void {
  const N = rows.length;
  const K = N > 0 ? (rows[0]?.length ?? 0) : 0;
  const keyOf = (r: readonly string[]): string => r.join(SEP);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);
    const isDup = (key: string): boolean => (counts.get(key) ?? 0) > 1;

    for (let i = 0; i < N; i++) {
      const ri = rows[i];
      if (!ri) continue;
      // `ri` does not change while we scan for a partner — a swap ends the
      // scan — so its key is built once instead of once per candidate.
      const oldI = keyOf(ri);
      if (!isDup(oldI)) continue;
      let done = false;
      for (let k = 0; k < K && !done; k++) {
        for (let j = 0; j < N && !done; j++) {
          const rj = rows[j];
          if (j === i || !rj || ri[k] === rj[k]) continue;
          const oldJ = keyOf(rj);
          const ni = ri.slice();
          const nj = rj.slice();
          ni[k] = rj[k] ?? '';
          nj[k] = ri[k] ?? '';
          const newI = keyOf(ni);
          const newJ = keyOf(nj);
          // `ri` is a duplicate — that is why we are scanning at all.
          const before = 1 + (isDup(oldJ) ? 1 : 0);
          // The swap moves two rows, so only four tallies can change. This
          // used to copy the entire `counts` map to learn that — an O(rows)
          // allocation in the innermost loop, which made a sweep cubic in the
          // row count. 19,000 rows of `uniq` + `percent` never finished.
          const trialCount = (key: string): number =>
            (counts.get(key) ?? 0) +
            (key === newI ? 1 : 0) +
            (key === newJ ? 1 : 0) -
            (key === oldI ? 1 : 0) -
            (key === oldJ ? 1 : 0);
          const after = (trialCount(newI) > 1 ? 1 : 0) + (trialCount(newJ) > 1 ? 1 : 0);
          if (after < before) {
            rows[i] = ni;
            rows[j] = nj;
            counts.set(oldI, (counts.get(oldI) ?? 0) - 1);
            counts.set(oldJ, (counts.get(oldJ) ?? 0) - 1);
            counts.set(newI, (counts.get(newI) ?? 0) + 1);
            counts.set(newJ, (counts.get(newJ) ?? 0) + 1);
            improved = true;
            done = true;
          }
        }
      }
    }
    if (!improved) break;
  }
}

export interface ArrangeResult {
  /** Rearranged columns, in the SAME field order as the input. */
  readonly columns: string[][];
  /** Number of distinct row-tuples actually achieved. */
  readonly distinct: number;
}

/**
 * Rearrange `columns` (each returned as a permutation of its input multiset)
 * so the row-tuples are maximally distinct. Deterministic.
 */
export function arrangeUnique(columns: readonly (readonly string[])[]): ArrangeResult {
  const K = columns.length;
  if (K === 0) return { columns: [], distinct: 0 };
  const N = columns[0]?.length ?? 0;
  if (N === 0) return { columns: columns.map(() => []), distinct: 0 };

  const indexed = columns
    .map((col, index) => ({ col, index, dev: stddev(valueCounts(col)) }))
    .sort((a, b) => a.dev - b.dev || a.index - b.index);

  const rows = buildRows(indexed.map((e) => e.col));
  repairRows(rows);

  const out: string[][] = new Array<string[]>(K);
  indexed.forEach((e, sortedK) => {
    out[e.index] = rows.map((r) => r[sortedK] ?? '');
  });
  const distinct = new Set(rows.map((r) => r.join(SEP))).size;
  return { columns: out, distinct };
}
