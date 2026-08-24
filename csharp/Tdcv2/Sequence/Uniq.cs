namespace Tdcv2.Sequence;

/// <summary>
/// <c>uniq="true"</c> — make every row's tuple different from every other row's.
/// </summary>
/// <remarks>
/// <para>
/// The one invariant everything here is built around: values are only ever <b>rearranged</b>, never
/// replaced. Each column keeps exactly the multiset of values it was drawn with, so a declared
/// <c>percent=</c> share survives unchanged. Uniqueness and an exact distribution are not in tension
/// — they coexist because the arrangement is a permutation.
/// </para>
/// <para>Three pieces:</para>
/// <list type="bullet">
///   <item>
///     <see cref="UpperBound"/> — a proven ceiling. Asking for more than this is impossible, so it
///     is a safe reject before any work.
///   </item>
///   <item>
///     <see cref="Capacity"/> — a simulation over the quota numbers alone, giving a safe floor. It
///     certifies a huge config in milliseconds without assembling a single row.
///   </item>
///   <item><see cref="Arrange"/> — the constructive builder: proportional fill, then swap repair.</item>
/// </list>
/// <para>
/// Pure: no DSL, no randomness, no input beyond the columns. The rearrangement is a function of the
/// values drawn, which is what lets it be checked against a brute-force answer.
/// </para>
/// </remarks>
public static class Uniq
{
    /// <summary>
    /// The separator that keys a tuple.
    /// </summary>
    /// <remarks>
    /// NUL, because it is the one character a generated value cannot contain. With a space or a
    /// comma, <c>["a b", "c"]</c> and <c>["a", "b c"]</c> would key alike, and two genuinely
    /// different rows would count as one duplicate — the exact mistake this file exists to avoid.
    /// </remarks>
    private const string Sep = "\0";

    /// <summary>Sweeps of swap repair before the arrangement is accepted as it stands.</summary>
    private const int MaxSweeps = 8;

    public sealed record Arrangement(IReadOnlyList<List<string>> Columns, int Distinct);

    /// <summary>Counts of each distinct value in a column, in first-seen order.</summary>
    public static List<int> ValueCounts(IReadOnlyList<string> column)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (string v in column)
        {
            if (!counts.TryGetValue(v, out int seen))
            {
                order.Add(v);
            }

            counts[v] = seen + 1;
        }

        return order.Select(v => counts[v]).ToList();
    }

    /// <summary>
    /// A proven upper bound on the distinct tuples these value-counts can produce.
    /// </summary>
    /// <remarks>
    /// It never undercounts, which is the property that matters: a config asking for more than this
    /// is definitely impossible and can be refused immediately, with no risk of refusing one that
    /// would have worked.
    /// </remarks>
    public static int UpperBound(IReadOnlyList<IReadOnlyList<int>> columnCounts)
    {
        int need = 1;
        foreach (IReadOnlyList<int> counts in ByDeviation(columnCounts))
        {
            int sum = 0;
            foreach (int c in counts)
            {
                sum += Math.Min(c, need);
            }

            need = sum;
        }

        return need;
    }

    /// <summary>
    /// A safe lower bound, simulated over the counts alone.
    /// </summary>
    /// <remarks>
    /// The builder always does at least this well, so reaching <paramref name="need"/> here
    /// certifies the config without touching any data — which is what makes a billion-row config
    /// answerable in milliseconds.
    /// </remarks>
    public static int Capacity(IReadOnlyList<IReadOnlyList<int>> columnCounts, int need)
    {
        IReadOnlyList<IReadOnlyList<int>> sorted = ByDeviation(columnCounts);
        if (sorted.Count == 0)
        {
            return 0;
        }

        var profile = new List<int>(sorted[0]);
        for (int k = 1; k < sorted.Count; k++)
        {
            var pool = new List<int>(sorted[k]);
            var next = new List<int>();
            var groups = new List<int>(profile);
            groups.Sort((a, b) => b.CompareTo(a));
            foreach (int groupSize in groups)
            {
                var live = new List<(int Index, int Cap)>();
                for (int i = 0; i < pool.Count; i++)
                {
                    if (pool[i] > 0)
                    {
                        live.Add((i, pool[i]));
                    }
                }

                int[] split = ProportionalSplit(groupSize, live);
                for (int x = 0; x < live.Count; x++)
                {
                    if (split[x] > 0)
                    {
                        next.Add(split[x]);
                        pool[live[x].Index] -= split[x];
                    }
                }
            }

            profile = next;
            // The count only grows with each further column, so reaching the target certifies it.
            if (profile.Count >= need)
            {
                return profile.Count;
            }
        }

        return profile.Count;
    }

    /// <summary>Rearrange the columns so as many rows as possible carry a distinct tuple.</summary>
    public static Arrangement Arrange(IReadOnlyList<IReadOnlyList<string>> columns)
    {
        int k = columns.Count;
        if (k == 0)
        {
            return new Arrangement(Array.Empty<List<string>>(), 0);
        }

        if (columns[0].Count == 0)
        {
            return new Arrangement(
                Enumerable.Range(0, k).Select(_ => new List<string>()).ToArray(), 0);
        }

        // Balanced columns first. A column whose values are evenly spread offers the most freedom,
        // so spending it early leaves the lopsided ones an easier job.
        var deviations = columns.Select(c => StdDev(ValueCounts(c))).ToArray();
        int[] order = Enumerable.Range(0, k)
            .OrderBy(i => deviations[i]).ThenBy(i => i).ToArray();

        var sortedColumns = order.Select(i => columns[i]).ToArray();
        List<List<string>> rows = BuildRows(sortedColumns);
        RepairRows(rows);

        var result = new List<string>[k];
        for (int sortedK = 0; sortedK < order.Length; sortedK++)
        {
            result[order[sortedK]] = rows.Select(row => row[sortedK]).ToList();
        }

        var seen = new HashSet<string>(rows.Select(r => string.Join(Sep, r)), StringComparer.Ordinal);
        return new Arrangement(result, seen.Count);
    }

    /// <summary>
    /// Give a group of <c>g</c> rows <c>g</c> DISTINCT values, when the column still has that many
    /// left.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two rows in the same group agree on every column before this one, so they are distinct only
    /// if they differ HERE. The proportional split does not know that: it hands out values in
    /// proportion to remaining stock, which repeats a value inside a group as soon as one value
    /// dominates. Every such repeat is a duplicate row, and duplicates are what the repair then
    /// spends quadratic time undoing.
    /// </para>
    /// <para>
    /// Taking the <c>g</c> largest stocks costs nothing in exactness — the column's multiset is
    /// fixed either way, and this only chooses WHICH row gets which value.
    /// </para>
    /// </remarks>
    /// <returns>
    /// False when the column has fewer values left than the group has rows; the proportional path
    /// handles that instead.
    /// </returns>
    /// <summary>
    /// The remaining stock of one column, ordered the way the deal picks from it: largest stock
    /// first, ties to the value that appeared first.
    /// </summary>
    /// <remarks>
    /// That is what <see cref="DealDistinct"/> wants, and it used to get it by walking the WHOLE
    /// pool and SORTING it — once per group. Measured in the reference on a 6,000,000-row
    /// <c>&lt;uniq&gt;</c> whose repair pool held 179,133 rows over 30,000 values: 44 of the run's
    /// 85 seconds, growing with the product of the two, while the partner scan everyone suspected
    /// cost 2.
    /// <para>
    /// A binary heap answers the same question by popping. Entries go stale as the deal spends
    /// stock, so a pop compares the entry against the live count in <c>pool</c> and discards it if
    /// the value has moved on — the ordinary lazy heap. What does NOT change is the answer: same
    /// order, same ties, same values to the same rows, byte for byte. That is the whole constraint
    /// here — which value a row draws IS the dataset, so a faster deal that deals differently is a
    /// different product.
    /// </para>
    /// </remarks>
    private sealed class StockHeap
    {
        private readonly Dictionary<string, int> _pool;
        private readonly Dictionary<string, int> _at = new(StringComparer.Ordinal);
        private readonly PriorityQueue<string, (int Stock, int At)> _heap = new();
        private int _live;

        internal StockHeap(Dictionary<string, int> pool, List<string> poolOrder)
        {
            _pool = pool;
            // `at` counts every entry, not only the live ones, so a tie is broken by first
            // appearance the same way in every implementation.
            for (int at = 0; at < poolOrder.Count; at++)
            {
                string value = poolOrder[at];
                _at[value] = at;
                if (pool[value] > 0)
                {
                    // Negated stock, so the min-priority queue answers "largest stock, earliest at".
                    _heap.Enqueue(value, (-pool[value], at));
                    _live++;
                }
            }
        }

        /// <summary>Values with stock left — the <c>live.Count</c> the sort used to count.</summary>
        internal int LiveCount => _live;

        /// <summary>
        /// The next value the sort would have put first, or null if none is left.
        /// </summary>
        /// <remarks>
        /// It is NOT returned to the heap here. A group takes several values and they must be
        /// distinct, so the caller spends each one and hands them all back once the group is dealt
        /// — until then a spent value has no fresh entry to be drawn a second time.
        /// </remarks>
        internal string? Take()
        {
            while (_heap.TryDequeue(out string? value, out (int Stock, int At) key))
            {
                int stock = -key.Stock;
                if (stock > 0 && _pool.TryGetValue(value, out int now) && now == stock)
                {
                    return value;
                }
            }

            return null;
        }

        /// <summary>One unit of <paramref name="value"/> dealt to a row.</summary>
        internal void Spend(string value)
        {
            // A value the pool never held is left alone, exactly as the direct decrement was.
            if (!_pool.TryGetValue(value, out int stock))
            {
                return;
            }

            _pool[value] = stock - 1;
            if (stock - 1 == 0)
            {
                _live--;
            }
        }

        /// <summary>Put <paramref name="value"/> back in the running at whatever stock it has now.</summary>
        internal void Restore(string value)
        {
            if (_pool.TryGetValue(value, out int stock) && stock > 0)
            {
                _heap.Enqueue(value, (-stock, _at.TryGetValue(value, out int at) ? at : 0));
            }
        }
    }

    private static bool DealDistinct(StockHeap stock, List<int> indexes, List<List<string>> rows)
    {
        int g = indexes.Count;
        // Asked before anything is spent, so a group too large for what is left is refused without
        // having to be undone.
        if (stock.LiveCount < g)
        {
            return false;
        }

        // The `g` largest stocks, ties by first appearance — the same values the full sort put at
        // the front, taken without sorting the rest.
        var taken = new List<string>(g);
        for (int m = 0; m < g; m++)
        {
            string? chosen = stock.Take();
            if (chosen is null)
            {
                foreach (string value in taken)
                {
                    stock.Restore(value);
                }

                return false;
            }

            // Spent as it is taken: that is what keeps a value out of the rest of THIS group,
            // which is the whole point of dealing distinct ones.
            stock.Spend(chosen);
            taken.Add(chosen);
            rows[indexes[m]].Add(chosen);
        }

        foreach (string value in taken)
        {
            stock.Restore(value);
        }

        return true;
    }

    /// <summary>Assemble rows column by column, spreading each column's values across the groups so far.</summary>
    private static List<List<string>> BuildRows(IReadOnlyList<IReadOnlyList<string>> columns)
    {
        IReadOnlyList<string> first = columns[0];
        int n = first.Count;
        var rows = first.Select(v => new List<string> { v }).ToList();

        for (int k = 1; k < columns.Count; k++)
        {
            var poolOrder = new List<string>();
            var pool = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (string v in columns[k])
            {
                if (!pool.TryGetValue(v, out int seen))
                {
                    poolOrder.Add(v);
                }

                pool[v] = seen + 1;
            }

            var stock = new StockHeap(pool, poolOrder);

            var groupOrder = new List<string>();
            var groups = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            for (int j = 0; j < n; j++)
            {
                string key = string.Join(Sep, rows[j]);
                if (!groups.TryGetValue(key, out List<int>? bucket))
                {
                    bucket = new List<int>();
                    groups[key] = bucket;
                    groupOrder.Add(key);
                }

                bucket.Add(j);
            }

            // Largest groups first: they are the ones most in need of diversity, and the pool is
            // finite, so serving them last would leave them whatever nobody else wanted.
            List<List<int>> bySize = groupOrder
                .Select(key => groups[key])
                .OrderByDescending(g => g.Count)
                .ToList();

            foreach (List<int> indexes in bySize)
            {
                if (DealDistinct(stock, indexes, rows))
                {
                    continue;
                }

                var liveKeys = new List<string>();
                var live = new List<(int Index, int Cap)>();
                foreach (string key in poolOrder)
                {
                    if (pool[key] > 0)
                    {
                        live.Add((live.Count, pool[key]));
                        liveKeys.Add(key);
                    }
                }

                int[] split = ProportionalSplit(indexes.Count, live);

                var deck = new List<string>();
                for (int x = 0; x < liveKeys.Count; x++)
                {
                    for (int t = 0; t < split[x]; t++)
                    {
                        deck.Add(liveKeys[x]);
                    }
                }

                deck.Sort(StringComparer.Ordinal);

                int di = 0;
                var spent = new List<string>();
                foreach (int j in indexes)
                {
                    string v = di < deck.Count
                        ? deck[di]
                        : deck.Count == 0 ? "" : deck[^1];
                    di++;
                    stock.Spend(v);
                    if (!spent.Contains(v))
                    {
                        spent.Add(v);
                    }

                    rows[j].Add(v);
                }

                // Back in the running at their new stocks, once the group is dealt.
                foreach (string value in spent)
                {
                    stock.Restore(value);
                }
            }
        }

        return rows;
    }

    /// <summary>
    /// Swap repair: while a row duplicates another, trade one of its cells with another row's cell
    /// in the same column whenever that strictly reduces the number of duplicates.
    /// </summary>
    /// <remarks>
    /// Swapping within a column is what preserves the multiset — the values move between rows but
    /// the column still holds exactly what it held.
    /// </remarks>
    private static void RepairRows(List<List<string>> rows)
    {
        int n = rows.Count;
        int k = n > 0 ? rows[0].Count : 0;

        for (int sweep = 0; sweep < MaxSweeps; sweep++)
        {
            bool improved = false;
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (List<string> r in rows)
            {
                string key = string.Join(Sep, r);
                counts[key] = counts.GetValueOrDefault(key) + 1;
            }

            for (int i = 0; i < n; i++)
            {
                List<string> ri = rows[i];
                string oldI = string.Join(Sep, ri);
                if (counts.GetValueOrDefault(oldI) <= 1)
                {
                    continue;
                }

                bool done = false;
                for (int col = 0; col < k && !done; col++)
                {
                    for (int j = 0; j < n && !done; j++)
                    {
                        List<string> rj = rows[j];
                        if (j == i || ri[col] == rj[col])
                        {
                            continue;
                        }

                        string oldJ = string.Join(Sep, rj);
                        var ni = new List<string>(ri);
                        var nj = new List<string>(rj);
                        ni[col] = rj[col];
                        nj[col] = ri[col];
                        string newI = string.Join(Sep, ni);
                        string newJ = string.Join(Sep, nj);

                        int before = 1 + (counts.GetValueOrDefault(oldJ) > 1 ? 1 : 0);
                        // Only four tallies can change, so they are adjusted rather than recounted.
                        // The obvious version copies the whole map inside the innermost loop, which
                        // makes a sweep cubic in the row count and never finishes on real data.
                        int after =
                            (TrialCount(counts, newI, newI, newJ, oldI, oldJ) > 1 ? 1 : 0)
                            + (TrialCount(counts, newJ, newI, newJ, oldI, oldJ) > 1 ? 1 : 0);

                        if (after < before)
                        {
                            rows[i] = ni;
                            rows[j] = nj;
                            counts[oldI] = counts.GetValueOrDefault(oldI) - 1;
                            counts[oldJ] = counts.GetValueOrDefault(oldJ) - 1;
                            counts[newI] = counts.GetValueOrDefault(newI) + 1;
                            counts[newJ] = counts.GetValueOrDefault(newJ) + 1;
                            improved = true;
                            done = true;
                        }
                    }
                }
            }

            if (!improved)
            {
                break;
            }
        }
    }

    private static int TrialCount(
        IReadOnlyDictionary<string, int> counts, string key, string newI, string newJ, string oldI,
        string oldJ) =>
        counts.GetValueOrDefault(key)
        + (key == newI ? 1 : 0)
        + (key == newJ ? 1 : 0)
        - (key == oldI ? 1 : 0)
        - (key == oldJ ? 1 : 0);

    /// <summary>Largest-remainder split of <paramref name="total"/> over parts of {index, cap}.</summary>
    private static int[] ProportionalSplit(int total, IReadOnlyList<(int Index, int Cap)> parts)
    {
        var result = new int[parts.Count];
        if (parts.Count == 0)
        {
            return result;
        }

        double sumWeight = parts.Sum(p => (double)p.Cap);

        var remainders = new double[parts.Count];
        int assigned = 0;
        for (int i = 0; i < parts.Count; i++)
        {
            double exact = sumWeight == 0 ? 0 : total * parts[i].Cap / sumWeight;
            result[i] = Math.Min(parts[i].Cap, (int)Math.Floor(exact));
            remainders[i] = exact - Math.Floor(exact);
            assigned += result[i];
        }

        int[] order = Enumerable.Range(0, parts.Count)
            .OrderByDescending(i => remainders[i]).ThenBy(i => i).ToArray();
        foreach (int i in order)
        {
            if (assigned >= total)
            {
                break;
            }

            if (result[i] < parts[i].Cap)
            {
                result[i]++;
                assigned++;
            }
        }

        // Whatever the clamping left over, round-robin into the parts that still have room.
        for (int i = 0; assigned < total; i = (i + 1) % result.Length)
        {
            if (result[i] < parts[i].Cap)
            {
                result[i]++;
                assigned++;
            }
            else if (!parts.Where((p, x) => result[x] < p.Cap).Any())
            {
                break;
            }
        }

        return result;
    }

    /// <summary>Column-count vectors ordered by how evenly spread they are, most balanced first.</summary>
    private static IReadOnlyList<IReadOnlyList<int>> ByDeviation(
        IReadOnlyList<IReadOnlyList<int>> items)
    {
        var deviations = items.Select(StdDev).ToArray();
        return Enumerable.Range(0, items.Count)
            .OrderBy(i => deviations[i]).ThenBy(i => i)
            .Select(i => items[i])
            .ToArray();
    }

    private static double StdDev(IReadOnlyList<int> nums)
    {
        int n = nums.Count;
        if (n < 2)
        {
            return 0;
        }

        double mean = nums.Sum() / (double)n;
        double variance = nums.Sum(v => (v - mean) * (v - mean));
        return Math.Sqrt(variance / (n - 1));
    }
}
