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
/**
 * The remaining stock of one column, ordered the way the deal picks from it:
 * largest stock first, ties to the value that appeared first.
 *
 * Both callers below want exactly that, and both used to get it by walking the
 * WHOLE pool once per group — `dealDistinct` also SORTED it, thirty thousand
 * entries at a time. Measured on a 6,000,000-row `<uniq>` whose repair pool held
 * 179,133 rows over 30,000 values: 44 of the run's 85 seconds, growing with the
 * product of the two, while the partner scan everyone suspected cost 2.
 *
 * A binary heap answers the same question by popping. Entries go stale as the
 * deal spends stock, so a pop compares the entry against the live count in
 * `pool` and discards it if the value has moved on — the ordinary lazy heap.
 * What does NOT change is the answer: same comparator, same ties, same values
 * to the same rows, byte for byte. That is the whole constraint here — which
 * value a row draws is the dataset, so a faster deal that deals differently is
 * a different product.
 */
class StockHeap {
  /** `[value, stock, appearance]`, heapified on (stock desc, appearance asc). */
  private readonly heap: [string, number, number][] = [];
  /** How many values still have stock — the `live.length` the sort used to count. */
  private live = 0;
  private readonly at = new Map<string, number>();

  constructor(private readonly pool: Map<string, number>) {
    let appearance = 0;
    for (const [value, stock] of pool) {
      this.at.set(value, appearance);
      if (stock > 0) {
        this.heap.push([value, stock, appearance]);
        this.live += 1;
      }
      appearance += 1;
    }
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.sink(i);
  }

  /** Values with stock left. The deal refuses a group larger than this. */
  get liveCount(): number {
    return this.live;
  }

  /**
   * The next value the sort would have put first, or undefined if none is left.
   *
   * It is NOT returned to the heap here. A group takes several values and they
   * must be distinct, so the caller spends each one and hands them all back
   * once the group is dealt — until then a spent value has no fresh entry to
   * be drawn a second time.
   */
  take(): string | undefined {
    while (this.heap.length > 0) {
      const top = this.heap[0];
      if (top === undefined) return undefined;
      this.pop();
      if (top[1] > 0 && this.pool.get(top[0]) === top[1]) return top[0];
    }
    return undefined;
  }

  /** One unit of `value` dealt to a row. */
  spend(value: string): void {
    const stock = (this.pool.get(value) ?? 0) - 1;
    this.pool.set(value, stock);
    if (stock === 0) this.live -= 1;
  }

  /** Put `value` back in the running at whatever stock it has now. */
  restore(value: string): void {
    const stock = this.pool.get(value) ?? 0;
    if (stock <= 0) return;
    const appearance = this.at.get(value) ?? 0;
    this.heap.push([value, stock, appearance]);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Larger stock first; equal stocks in order of first appearance. */
  private before(a: number, b: number): boolean {
    const x = this.heap[a];
    const y = this.heap[b];
    if (x === undefined || y === undefined) return false;
    return x[1] !== y[1] ? x[1] > y[1] : x[2] < y[2];
  }

  private swap(a: number, b: number): void {
    const x = this.heap[a];
    const y = this.heap[b];
    if (x === undefined || y === undefined) return;
    this.heap[a] = y;
    this.heap[b] = x;
  }

  private pop(): void {
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.sink(0);
    }
  }

  private sink(from: number): void {
    let i = from;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.heap.length && this.before(left, best)) best = left;
      if (right < this.heap.length && this.before(right, best)) best = right;
      if (best === i) return;
      this.swap(i, best);
      i = best;
    }
  }
}

function buildRows(columns: readonly (readonly string[])[]): {
  rows: string[][];
  /** Final group id per row: two rows are the SAME tuple iff these match. */
  groupOf: Int32Array;
} {
  const first = columns[0] ?? [];
  const N = first.length;
  const rows: string[][] = first.map((v) => [v]);

  /*
   * Which rows agree on every column placed so far, as a NUMBER per row.
   *
   * This used to be `rows[j].join(SEP)` — the whole prefix, rebuilt for every
   * row on every column. At five columns and ten million rows that is fifty
   * million strings of sixty-odd characters, and it was the reason the run died
   * in the garbage collector rather than in the arithmetic: 3.15 GB at 3.2M
   * rows, and out of heap before ten million.
   *
   * The prefix is never READ, only compared, so an integer that means "the same
   * prefix" does the same job. It is refined one column at a time: two rows keep
   * sharing a group only if they shared the last one AND drew the same value.
   * Int32Array, so ten million rows cost forty megabytes instead of gigabytes.
   */
  let groupOf = new Int32Array(N);
  {
    const seen = new Map<string, number>();
    for (let j = 0; j < N; j++) {
      const v = first[j] ?? '';
      let id = seen.get(v);
      if (id === undefined) {
        id = seen.size;
        seen.set(v, id);
      }
      groupOf[j] = id;
    }
  }

  for (let k = 1; k < columns.length; k++) {
    const pool = new Map<string, number>();
    for (const v of columns[k] ?? []) pool.set(v, (pool.get(v) ?? 0) + 1);
    const stock = new StockHeap(pool);

    const groups = new Map<number, number[]>();
    for (let j = 0; j < N; j++) {
      const key = groupOf[j] ?? 0;
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
      const best = stock.take();
      if (best === undefined) return false; // nothing left — the general path reports it
      stock.spend(best);
      stock.restore(best);
      rows[row]?.push(best);
      return true;
    };

    /*
     * Give a group of `g` rows `g` DISTINCT values when the column still has
     * that many in stock.
     *
     * Two rows in the same group agree on every column before this one, so they
     * are distinct only if they differ HERE. The proportional split does not
     * know that: it hands out values in proportion to remaining stock, which
     * repeats a value inside a group as soon as one value dominates. Every such
     * repeat is a duplicate row, and duplicates are what the repair then spends
     * quadratic time undoing — 3,626 of them on a 400,000-row block, which is
     * 0.9% of the rows and was most of the run time.
     *
     * Taking the `g` largest stocks instead costs nothing in exactness: the
     * column's multiset is fixed either way, and this only chooses WHICH row
     * gets which value. It also spreads the depletion, so later groups still
     * find values left — which is where the repeats came from.
     *
     * When the column genuinely has fewer values left than the group has rows,
     * a repeat is unavoidable and the proportional path below handles it.
     */
    const dealDistinct = (idxs: readonly number[]): boolean => {
      const g = idxs.length;
      // Asked before anything is spent, so a group too large for what is left
      // is refused without having to be undone.
      if (stock.liveCount < g) return false;
      // The `g` largest stocks, ties by first appearance — the same values the
      // full sort put at the front, taken without sorting the rest.
      const taken: string[] = [];
      for (let m = 0; m < g; m++) {
        const chosen = stock.take();
        const row = idxs[m];
        if (chosen === undefined || row === undefined) {
          for (const value of taken) stock.restore(value);
          return false;
        }
        // Spent as it is taken: that is what keeps a value out of the rest of
        // THIS group, which is the whole point of dealing distinct ones.
        stock.spend(chosen);
        taken.push(chosen);
        rows[row]?.push(chosen);
      }
      for (const value of taken) stock.restore(value);
      return true;
    };

    // Largest groups first — they need the most diversity.
    for (const idxs of [...groups.values()].sort((a, b) => b.length - a.length)) {
      if (idxs.length === 1 && takeSingle(idxs[0])) continue;
      if (dealDistinct(idxs)) continue;
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
      const spent = new Set<string>();
      for (const j of idxs) {
        const v = deck[di++] ?? deck[deck.length - 1] ?? '';
        stock.spend(v);
        spent.add(v);
        const row = rows[j];
        if (row) row.push(v);
      }
      // Back in the running at their new stocks, once the group is dealt.
      for (const value of spent) stock.restore(value);
    }

    // Refine: rows stay together only if they also drew the same value here.
    // Keyed by a map per old group rather than by a composite string, so this
    // costs no allocation per row.
    const refined = new Int32Array(N);
    const byGroup = new Map<number, Map<string, number>>();
    let nextId = 0;
    for (let j = 0; j < N; j++) {
      const old = groupOf[j] ?? 0;
      const value = rows[j]?.[k] ?? '';
      let inner = byGroup.get(old);
      if (inner === undefined) {
        inner = new Map<string, number>();
        byGroup.set(old, inner);
      }
      let id = inner.get(value);
      if (id === undefined) {
        id = nextId++;
        inner.set(value, id);
      }
      refined[j] = id;
    }
    groupOf = refined;
  }
  return { rows, groupOf };
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
  /**
   * Distinct tuples the BUILDER reached on its own, before any repair.
   *
   * Equal to `distinct` whenever the deal needed no help, which is the case
   * worth watching: the repair is quadratic in the duplicates it is handed, so
   * a deal that stops handing it any is the difference between a run of
   * minutes and a run of hours. `distinct` alone cannot show that — a repaired
   * table and a table that never needed repairing look identical from outside.
   */
  readonly builtDistinct: number;
}

/**
 * Rearrange `columns` (each returned as a permutation of its input multiset)
 * so the row-tuples are maximally distinct. Deterministic.
 */
export function arrangeUnique(columns: readonly (readonly string[])[]): ArrangeResult {
  const K = columns.length;
  if (K === 0) return { columns: [], distinct: 0, builtDistinct: 0 };
  const N = columns[0]?.length ?? 0;
  if (N === 0) return { columns: columns.map(() => []), distinct: 0, builtDistinct: 0 };

  const indexed = columns
    .map((col, index) => ({ col, index, dev: stddev(valueCounts(col)) }))
    .sort((a, b) => a.dev - b.dev || a.index - b.index);

  const { rows, groupOf } = buildRows(indexed.map((e) => e.col));

  /*
   * Two rows are the same tuple exactly when they end in the same group, so the
   * ids already say how many distinct tuples there are — no keys, no joins.
   *
   * Worth doing for what it SKIPS. A sweep of the repair builds a key per row
   * and a map over all of them before discovering there is nothing to repair;
   * on a run of millions that is hundreds of megabytes and a pass, spent to
   * learn "nothing to do". Since the builder started handing out distinct
   * values within a group it usually IS nothing to do.
   */
  const distinctIds = new Set<number>();
  for (let i = 0; i < N; i++) distinctIds.add(groupOf[i] ?? 0);
  if (distinctIds.size < N) repairRows(rows);

  const out: string[][] = new Array<string[]>(K);
  indexed.forEach((e, sortedK) => {
    out[e.index] = rows.map((r) => r[sortedK] ?? '');
  });
  // Counted from the ids when the builder already had them distinct; only a run
  // that went through the repair needs the tuples looked at again.
  const distinct = distinctIds.size === N ? N : new Set(rows.map((r) => r.join(SEP))).size;
  return { columns: out, distinct, builtDistinct: distinctIds.size };
}

/** The message a group refusal carries: what was asked for, and what the data allows. */
export function uniqGroupMessage(name: string, requested: number, achievable: number): string {
  return (
    `uniq: group "${name}" cannot produce ${String(requested)} unique combinations — ` +
    `the values drawn for these sequences allow at most ${String(achievable)} distinct ` +
    'rows. Add more values to a member (more distinct names, wider ranges…) or lower the count.'
  );
}
