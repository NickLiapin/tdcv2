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

/**
 * A set of row numbers that answers "the next one at or after here" in a few
 * machine words.
 *
 * Repair needs to visit the duplicate rows below a given row in ascending
 * order. Walking every row to find them was 47% of the time on a 400,000-row
 * block, and collecting them all up front was worse — quadratic again, since
 * the collection is rebuilt for every duplicate.
 *
 * Two levels of bitmap: one bit per row, and one summary bit per 32 rows. A
 * lookup skips 32 empty rows at a time, and both levels update in constant
 * time. Deliberately not a balanced tree — this is thirty lines that four other
 * implementations have to carry, and the constant factor of a word scan beats
 * the pointer chasing at every size this sees.
 */
class RowSet {
  private readonly bits: Uint32Array;
  private readonly summary: Uint32Array;

  constructor(private readonly size: number) {
    this.bits = new Uint32Array((size >> 5) + 1);
    this.summary = new Uint32Array((size >> 10) + 1);
  }

  add(row: number): void {
    this.bits[row >> 5] = (this.bits[row >> 5] ?? 0) | (1 << (row & 31));
    this.summary[row >> 10] = (this.summary[row >> 10] ?? 0) | (1 << ((row >> 5) & 31));
  }

  remove(row: number): void {
    const word = row >> 5;
    const cleared = (this.bits[word] ?? 0) & ~(1 << (row & 31));
    this.bits[word] = cleared;
    // The summary bit stands for a whole word, so it only falls when the word does.
    if (cleared === 0) {
      this.summary[row >> 10] = (this.summary[row >> 10] ?? 0) & ~(1 << (word & 31));
    }
  }

  has(row: number): boolean {
    return ((this.bits[row >> 5] ?? 0) & (1 << (row & 31))) !== 0;
  }

  /** The smallest member at or after `from`, or -1. */
  nextAtOrAfter(from: number): number {
    if (from >= this.size) return -1;
    let word = from >> 5;
    const masked = (this.bits[word] ?? 0) & (0xffffffff << (from & 31));
    if (masked !== 0) return (word << 5) + trailingZeros(masked);

    // Skip whole words through the summary, then whole summary words.
    word += 1;
    while (word <= this.size >> 5) {
      const block = word >> 5;
      const inBlock = (this.summary[block] ?? 0) & (0xffffffff << (word & 31));
      if (inBlock !== 0) {
        word = (block << 5) + trailingZeros(inBlock);
        const bits = this.bits[word] ?? 0;
        if (bits !== 0) return (word << 5) + trailingZeros(bits);
        word += 1;
        continue;
      }
      word = (block + 1) << 5;
    }
    return -1;
  }
}

/** Position of the lowest set bit. `value` must not be zero. */
function trailingZeros(value: number): number {
  let count = 0;
  let v = value;
  while ((v & 1) === 0) {
    v >>>= 1;
    count += 1;
  }
  return count;
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
    /*
     * A group of ONE row does not need a proportional split, and by the last
     * column almost every group is one row.
     *
     * What the split would do for `total = 1`: every part floors to a base of
     * zero, so the single unit goes to the largest remainder — and the
     * remainder IS the weight, which is the value's remaining stock. Ties go to
     * the lowest index, and `pool` is filled in first-appearance order, so
     * "first strict maximum while iterating the pool" is the same value the
     * split would have chosen. The deck it built held that one value, and
     * sorting a one-element deck changes nothing.
     *
     * So this is the same answer, without rebuilding `live` and sorting a deck
     * per row. It was 73% of the time on a 200,000-row block.
     */
    const takeSingle = (row: number | undefined): boolean => {
      if (row === undefined) return false;
      let best: string | undefined;
      let bestCount = 0;
      for (const [v, c] of pool) {
        if (c > bestCount) {
          best = v;
          bestCount = c;
        }
      }
      if (best === undefined) return false; // nothing left — the general path reports it
      pool.set(best, bestCount - 1);
      rows[row]?.push(best);
      return true;
    };

    // Largest groups first — they need the most diversity.
    for (const idxs of [...groups.values()].sort((a, b) => b.length - a.length)) {
      if (idxs.length === 1 && takeSingle(idxs[0])) continue;
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
 * moves values within one column).
 *
 * The answer is defined by a LINEAR SCAN: for the duplicate row `i` and each
 * column in turn, the partner is the lowest-numbered row whose swap strictly
 * lowers the duplicate count. That definition is the output contract — a
 * different partner is a different dataset from the same seed — so everything
 * below is an index that reaches the same row faster, never a different rule.
 *
 * It needed one. Measured on a 200,000-row block of a four-column group:
 *
 *     duplicates                 258
 *     candidates examined  103,265,946     400,256 per duplicate
 *     swaps accepted             258       every one of them
 *
 * Two full passes over the block to place each swap. Worse, duplicates grow as
 * the square of the row count (birthday) and each cost a scan of every row, so
 * the whole thing was CUBIC: 50k rows 7.2 s, 100k 11.4 s, 200k 58 s, and a
 * 4,000,000-row run burned three and a half hours without writing a byte.
 *
 * Two observations make it cheap, and neither changes which row is chosen:
 *
 *   - A column holding ONE distinct value can never supply a partner: every
 *     candidate fails `ri[k] === rj[k]`. Inside a `<switch>` block the subject
 *     column is exactly that, and it cost a full pass per duplicate.
 *
 *   - The scan rejected 51,104,418 of the 51,104,676 candidates it tested, and
 *     51,074,370 of those because the tuple `ri` WOULD BECOME already exists.
 *     That depends only on the VALUE being swapped in, not on which row carries
 *     it — and there were 98 distinct values across 200,000 rows. The scan was
 *     asking the same question two thousand times per answer.
 *
 * So: ask once per value, then look only at rows that can still qualify. A row
 * carrying a value that fails cannot be accepted UNLESS it is itself a
 * duplicate — a duplicate partner starts from `before = 2`, so it can be
 * accepted while leaving one collision behind. Both sets are kept, merged in
 * ascending row order, and each candidate is put through the ORIGINAL test.
 * Candidates that are skipped are ones that provably cannot pass it.
 */
function repairRows(rows: string[][], maxSweeps = 8): void {
  const N = rows.length;
  const K = N > 0 ? (rows[0]?.length ?? 0) : 0;
  if (N === 0 || K === 0) return;
  const keyOf = (r: readonly string[]): string => r.join(SEP);

  // Columns that can supply a partner at all — see the note above.
  const liveColumns: number[] = [];
  for (let k = 0; k < K; k++) {
    const seen = new Set<string>();
    for (let i = 0; i < N && seen.size < 2; i++) seen.add(rows[i]?.[k] ?? '');
    if (seen.size > 1) liveColumns.push(k);
  }
  if (liveColumns.length === 0) return;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;

    // Row keys, and the rows carrying each key. `counts` is this map's sizes,
    // kept as one structure so a swap updates the two together or neither.
    const keys: string[] = new Array<string>(N);
    const rowsByKey = new Map<string, number[]>();
    for (let i = 0; i < N; i++) {
      const key = keyOf(rows[i] ?? []);
      keys[i] = key;
      const held = rowsByKey.get(key);
      if (held) held.push(i);
      else rowsByKey.set(key, [i]);
    }
    const countOf = (key: string): number => rowsByKey.get(key)?.length ?? 0;
    const isDup = (key: string): boolean => countOf(key) > 1;

    // Which ROWS are duplicates right now. Kept beside `rowsByKey` so a swap
    // updates both, and read by the candidate walk below to skip the rows that
    // cannot qualify without looking at them one by one.
    const duplicates = new RowSet(N);
    for (const held of rowsByKey.values()) {
      if (held.length > 1) for (const row of held) duplicates.add(row);
    }
    /** Re-read the status of every row holding `key`, after its count changed. */
    const refresh = (key: string): void => {
      const held = rowsByKey.get(key);
      if (!held) return;
      if (held.length > 1) for (const row of held) duplicates.add(row);
      else for (const row of held) duplicates.remove(row);
    };

    // Rows carrying each value, per live column, in ascending row order.
    const rowsByValue: Map<string, number[]>[] = liveColumns.map(() => new Map<string, number[]>());
    liveColumns.forEach((k, c) => {
      const index = rowsByValue[c];
      if (!index) return;
      for (let i = 0; i < N; i++) {
        const v = rows[i]?.[k] ?? '';
        const held = index.get(v);
        if (held) held.push(i);
        else index.set(v, [i]);
      }
    });

    /** Insert into an ascending array, keeping it ascending. */
    const insertAscending = (list: number[], row: number): void => {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((list[mid] ?? 0) < row) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, row);
    };
    const removeFrom = (list: number[] | undefined, row: number): void => {
      if (!list) return;
      const at = list.indexOf(row);
      if (at >= 0) list.splice(at, 1);
    };

    for (let i = 0; i < N; i++) {
      const ri = rows[i];
      if (!ri) continue;
      const oldI = keys[i] ?? '';
      if (!isDup(oldI)) continue;

      let done = false;
      for (let c = 0; c < liveColumns.length && !done; c++) {
        const k = liveColumns[c] ?? 0;
        const index = rowsByValue[c];
        if (!index) continue;

        // One question per VALUE: would `ri` land on a tuple that already
        // exists? Asked once per value rather than once per row — 98 values
        // carried 200,000 rows, so the scan was asking it two thousand times
        // over for the same answer.
        // The candidate key is `ri` with one cell replaced, so everything on
        // either side of that cell is the same for every value asked about.
        // Built once instead of copying the row and re-joining it per value:
        // that was four million array allocations and four million joins on a
        // 400,000-row block, which is where the time had moved to.
        const prefix = ri.slice(0, k).join(SEP) + (k > 0 ? SEP : '');
        const suffix = k + 1 < ri.length ? SEP + ri.slice(k + 1).join(SEP) : '';
        const clean: number[][] = [];
        for (const [v, held] of index) {
          if (v === ri[k] || held.length === 0) continue;
          if (countOf(prefix + v + suffix) === 0) clean.push(held);
        }

        /*
         * Candidates in ascending row order, without building the list.
         *
         * A row whose value FAILED can still be accepted, but only if it is
         * itself a duplicate: a duplicate partner starts from `before = 2`, so
         * it may be taken while leaving one collision behind. Those rows lie
         * between the clean ones, and asking `isDup` of each is cheap — far
         * cheaper than collecting every duplicate in the block, which is what
         * the first version of this did and which was quadratic all over again.
         */
        let at = 0;
        const heads = clean.map(() => 0);
        while (!done) {
          let next = -1;
          for (let c2 = 0; c2 < clean.length; c2++) {
            const list = clean[c2];
            const head = heads[c2] ?? 0;
            if (!list || head >= list.length) continue;
            const candidate = list[head] ?? 0;
            if (next < 0 || candidate < next) next = candidate;
          }
          if (next < 0) break;
          for (let c2 = 0; c2 < clean.length; c2++) {
            const list = clean[c2];
            if (list?.[heads[c2] ?? 0] === next) heads[c2] = (heads[c2] ?? 0) + 1;
          }

          // Everything below `next` carries a failed value, so only a duplicate
          // among them can pass — and the test below decides that, not this.
          // `duplicates` hands them over directly instead of being looked for.
          while (at <= next && !done) {
            let j = at >= next ? next : duplicates.nextAtOrAfter(at);
            if (j < 0 || j > next) j = next;
            at = j + 1;
            const rj = rows[j];
            if (j === i || !rj || ri[k] === rj[k]) continue;

            // From here down this is the original test, unchanged.
            const oldJ = keys[j] ?? '';
            const ni = ri.slice();
            const nj = rj.slice();
            ni[k] = rj[k] ?? '';
            nj[k] = ri[k] ?? '';
            const newI = keyOf(ni);
            const newJ = keyOf(nj);
            const before = 1 + (isDup(oldJ) ? 1 : 0);
            const trialCount = (key: string): number =>
              countOf(key) +
              (key === newI ? 1 : 0) +
              (key === newJ ? 1 : 0) -
              (key === oldI ? 1 : 0) -
              (key === oldJ ? 1 : 0);
            const after = (trialCount(newI) > 1 ? 1 : 0) + (trialCount(newJ) > 1 ? 1 : 0);
            if (after >= before) continue;

            const valueI = ri[k] ?? '';
            const valueJ = rj[k] ?? '';
            rows[i] = ni;
            rows[j] = nj;
            keys[i] = newI;
            keys[j] = newJ;

            removeFrom(rowsByKey.get(oldI), i);
            removeFrom(rowsByKey.get(oldJ), j);
            const holdI = rowsByKey.get(newI);
            if (holdI) insertAscending(holdI, i);
            else rowsByKey.set(newI, [i]);
            const holdJ = rowsByKey.get(newJ);
            if (holdJ) insertAscending(holdJ, j);
            else rowsByKey.set(newJ, [j]);
            duplicates.remove(i);
            duplicates.remove(j);
            for (const key of [oldI, oldJ, newI, newJ]) refresh(key);

            removeFrom(index.get(valueI), i);
            removeFrom(index.get(valueJ), j);
            const atI = index.get(valueJ);
            if (atI) insertAscending(atI, i);
            else index.set(valueJ, [i]);
            const atJ = index.get(valueI);
            if (atJ) insertAscending(atJ, j);
            else index.set(valueI, [j]);

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
