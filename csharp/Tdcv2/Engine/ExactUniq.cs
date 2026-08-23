using System.Globalization;
using System.Text;
using Tdcv2.Distribution;
using Tdcv2.Prng;
using Tdcv2.Sequence;

namespace Tdcv2.Engine;

/// <summary>
/// Exact percentages and uniqueness at the same time, past the size of memory.
/// </summary>
/// <remarks>
/// <para>
/// The streaming engine can give unique combinations, but only uniform ones: its mixed-radix index
/// spreads rows evenly over the combination space by construction. It can give exact percentages
/// too. It cannot give both, because the arrangement that satisfies one is not free to satisfy the
/// other. The in-memory engine does both by holding the whole table and repairing collisions, which
/// is precisely what stops working at scale.
/// </para>
/// <para>
/// So: build each column with its exact quota the seekable way, then ask whether the tuples happen
/// to be distinct — a question a sort on disk can answer with bounded memory. Usually they are,
/// because a run of a million rows over a space of billions collides by birthday odds, which is to
/// say rarely. Then nothing more is needed and the whole run stays O(1) in memory.
/// </para>
/// <para>
/// When there are collisions there are few of them, so they can be repaired in RAM: gather the
/// colliding rows plus enough neighbours to give them somewhere to move, learn which tuples already
/// exist inside that small value space, and rearrange the pool to avoid them. Only the pool's rows
/// move, and only among the pool's own values, so every column's totals come out exactly as
/// declared. A pool too tight to solve hands the config back to the in-memory engine rather than
/// shipping data that is nearly unique.
/// </para>
/// </remarks>
internal static class ExactUniq
{
    /// <summary>Separates a tuple's columns. Control characters cannot appear in a generated value.</summary>
    private const char Join = (char)1;

    /// <summary>Separates a key from its row index in a sortable record. NUL sorts below everything.</summary>
    private const char Sep = (char)0;

    /// <summary>Enough digits for any run: the index is padded so byte order is also numeric order.</summary>
    private const int IndexWidth = 16;

    /// <summary>The pool repair is quadratic; past this many collisions, the config is pathological.</summary>
    /// <summary>Anything that can answer "is this tuple taken?" — an exact set, or the disk ledger.</summary>
    public interface IMembership
    {
        bool Has(string key);
    }

    /// <summary>The small-run answer: every in-space tuple, held exactly.</summary>
    private sealed class ExactMembership : IMembership
    {
        private readonly HashSet<string> _keys;

        internal ExactMembership(HashSet<string> keys) => _keys = keys;

        public bool Has(string key) => _keys.Contains(key);
    }

    /// <summary>
    /// How many colliding rows the bounded repair takes on, for a run of <paramref name="count"/>.
    /// </summary>
    /// <remarks>
    /// A flat cap was written when the repair was quadratic in its pool. It is not any more, and
    /// collisions grow as the SQUARE of the run — so a flat cap doomed every sufficiently large
    /// run. A thousandth of the rows keeps the repair pool in tens of megabytes at any size, and
    /// the floor keeps small runs as permissive as they were.
    /// </remarks>
    private static int MaxRepairRowsFor(int count) => Math.Max(20_000, count / 1000);

    /// <summary>
    /// Rows past which the in-memory engine is NOT a fallback: past this it cannot hold the table
    /// at all, so falling back fails after a long materialisation rather than fast.
    /// </summary>
    public const int InMemoryFallbackMaxRows = 20_000_000;

    /// <summary>The exact construction collided and the bounded repair could not place every row.</summary>
    internal sealed class RepairNeeded : Exception
    {
        internal RepairNeeded(int collisions, string label)
            : base(
                $"Engine 3: uniq {label} is too tight for the bounded-memory repair ({collisions} "
                + "row(s) couldn't be placed) — using the in-memory engine instead.")
        {
        }
    }

    /// <summary>One uniq column: where it lands in the registry, its values, and their shares.</summary>
    internal sealed record Field(string Id, IReadOnlyList<string> Values, double[] Percents);

    /// <summary>A column of the finished arrangement: the value it gives a row.</summary>
    internal delegate string Resolver(int row);

    /// <summary>
    /// Build the uniq columns with exact shares, and make sure the tuples really are distinct.
    /// </summary>
    /// <returns>One resolver per field, in the order they were given.</returns>
    internal static IReadOnlyDictionary<string, Resolver> Arrange(
        IReadOnlyList<Field> fields, int count, string seed, string label, string tmpDir)
    {
        var columnCounts = new List<IReadOnlyList<int>>();
        var counts = new List<int[]>();
        foreach (Field field in fields)
        {
            int[] c = Hamilton.CountsPerValue(
                count, field.Percents, Prng.Prng.Create(seed + "|" + field.Id + "|pct"));
            counts.Add(c);
            columnCounts.Add(c);
        }

        int upper = Uniq.UpperBound(columnCounts);
        if (count > upper)
        {
            throw new InvalidOperationException(
                $"uniq {label} is infeasible — its data supports at most {upper} distinct rows, "
                + $"but {count} were requested. Widen a column's values or lower count.");
        }

        var resolvers = new List<Resolver>();
        for (int j = 0; j < fields.Count; j++)
        {
            int[] cumHi = Cumulative(counts[j]);
            int key = Permute.Key(seed, fields[j].Id);
            IReadOnlyList<string> values = fields[j].Values;
            resolvers.Add(row => values[RunFor(cumHi, Permute.Apply(row, count, key))]);
        }

        // If any column uses each of its values at most once, the tuple is unique by that column
        // alone. Worth checking: it turns the whole verification pass into an inspection of a
        // handful of integers, and a serial-number column makes it true.
        if (counts.Any(c => c.All(v => v <= 1)))
        {
            return RegistryOf(fields, resolvers);
        }

        return Repair(fields, resolvers, count, label, tmpDir);
    }

    private static IReadOnlyDictionary<string, Resolver> RegistryOf(
        IReadOnlyList<Field> fields, IReadOnlyList<Resolver> resolvers)
    {
        var result = new Dictionary<string, Resolver>(StringComparer.Ordinal);
        for (int j = 0; j < fields.Count; j++)
        {
            result[fields[j].Id] = resolvers[j];
        }

        return result;
    }

    /// <summary>
    /// Verify, and repair what the construction left colliding.
    /// </summary>
    /// <remarks>
    /// The repair moves a small pool of rows and nothing else. That is what keeps the percentages
    /// exact: a value only ever changes hands between two rows of the pool, so every column ends the
    /// pass with the multiset it started with.
    /// </remarks>
    private static IReadOnlyDictionary<string, Resolver> Repair(
        IReadOnlyList<Field> fields, IReadOnlyList<Resolver> resolvers, int count, string label,
        string tmpDir)
    {
        // How the duplicates are hunted: by fingerprint on a large run, by tuple text on a small
        // one. The carrier is all that differs — the rows found are the same either way, because a
        // matching fingerprint is verified against the true tuples before it is believed.
        FingerprintScan? scan = RunFingerprintScan(resolvers, count, tmpDir);

        var excess = new List<int>();
        if (scan is not null)
        {
            excess.AddRange(scan.Excess);
        }
        else
        {
            // Keep the first row of every colliding group; the rest have to move.
            foreach (List<int> group in DuplicateGroups(resolvers, count, tmpDir))
            {
                for (int m = 1; m < group.Count; m++)
                {
                    excess.Add(group[m]);
                }
            }
        }

        if (excess.Count == 0)
        {
            scan?.Drop();
            return RegistryOf(fields, resolvers);
        }

        if (excess.Count > MaxRepairRowsFor(count))
        {
            scan?.Drop();
            throw new RepairNeeded(excess.Count, label);
        }

        // The colliding rows on their own often lack the variety to move — a lone duplicate can
        // only re-form the tuple it already has. So the pool takes in donor rows sampled across the
        // run, which gives the arrangement room without letting any value leave the pool.
        int donorTarget = Math.Min(count - excess.Count, (8 * excess.Count) + 24);
        var inPool = new HashSet<int>(excess);
        var pool = new List<int>(excess);
        if (donorTarget > 0)
        {
            int stride = Math.Max(1, count / donorTarget);
            for (int i = 0; i < count && pool.Count - excess.Count < donorTarget; i += stride)
            {
                if (inPool.Add(i))
                {
                    pool.Add(i);
                }
            }
        }

        pool.Sort();

        int k = resolvers.Count;
        var poolColumns = new List<IReadOnlyList<string>>();
        var poolSpace = new List<HashSet<string>>();
        for (int j = 0; j < k; j++)
        {
            List<string> column = pool.Select(row => resolvers[j](row)).ToList();
            poolColumns.Add(column);
            poolSpace.Add(new HashSet<string>(column, StringComparer.Ordinal));
        }

        // "Is this tuple taken?" — answered one of two ways.
        //
        // Large run: no structure at all. The sorted fingerprint piles on disk ARE the ledger, and
        // a query is a binary search. Small run: derive every row's tuple once more and hold the
        // ones inside the pool's value space in an exact set, exactly as before.
        IMembership forbidden;
        Fingerprint.Ledger? ledger = null;
        if (scan is not null)
        {
            ledger = new Fingerprint.Ledger(scan.SortedPaths, inPool);
            forbidden = ledger;
        }
        else
        {
            var exact = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < count; i++)
            {
                if (inPool.Contains(i))
                {
                    continue;
                }

                var key = new StringBuilder();
                bool inSpace = true;
                for (int j = 0; j < k; j++)
                {
                    string value = resolvers[j](i);
                    if (!poolSpace[j].Contains(value))
                    {
                        inSpace = false;
                        break;
                    }

                    if (j > 0)
                    {
                        key.Append(Join);
                    }

                    key.Append(value);
                }

                if (inSpace)
                {
                    exact.Add(key.ToString());
                }
            }

            forbidden = new ExactMembership(exact);
        }

        List<List<string>>? arranged;
        try
        {
            arranged = ArrangeAvoiding(poolColumns, forbidden, pool.Count);
        }
        finally
        {
            ledger?.Dispose();
            scan?.Drop();
        }

        if (arranged is null)
        {
            throw new RepairNeeded(excess.Count, label);
        }

        var overrides = new Dictionary<int, List<string>>();
        for (int m = 0; m < pool.Count; m++)
        {
            overrides[pool[m]] = arranged.Select(column => column[m]).ToList();
        }

        var result = new Dictionary<string, Resolver>(StringComparer.Ordinal);
        for (int j = 0; j < k; j++)
        {
            int column = j;
            Resolver baseResolver = resolvers[j];
            result[fields[j].Id] = row =>
                overrides.TryGetValue(row, out List<string>? replaced)
                    ? replaced[column]
                    : baseResolver(row);
        }

        return result;
    }

    /// <summary>
    /// The groups of rows whose tuples are identical, in bounded memory.
    /// </summary>
    /// <remarks>
    /// Sorting is what makes this affordable: equal keys end up adjacent, so the scan holds one group
    /// rather than a set of every tuple seen. The row index is padded to a fixed width and appended
    /// after a NUL, which makes plain byte order the same as ordering by key and then by row — no
    /// record has to be parsed to be compared.
    /// </remarks>
    /// <summary>What the fingerprint hunt produced: the sorted piles, their home, the verified rows.</summary>
    private sealed record FingerprintScan(List<string> SortedPaths, string Directory, List<int> Excess)
    {
        internal void Drop()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch (IOException)
            {
                // A leftover pile in a temp directory is not worth failing a run over.
            }
        }
    }

    /// <summary>
    /// Hunt duplicates by fingerprint, or return null to leave the text path in charge.
    /// </summary>
    /// <remarks>
    /// Every row's tuple is hashed into a 13-byte record routed straight to its pile; each pile is
    /// sorted as raw bytes; groups sharing a hash are CANDIDATES. Verification then recomputes the
    /// true tuples for those few rows, so a 64-bit collision costs one recomputation and never a
    /// false duplicate — the rows returned are exactly the ones the text sort would name.
    /// </remarks>
    private static FingerprintScan? RunFingerprintScan(
        IReadOnlyList<Resolver> resolvers, int count, string tmpDir)
    {
        int buckets = Fingerprint.BucketCountFor(count, Environment.ProcessorCount);
        if (buckets < 2)
        {
            return null;
        }

        string root = string.IsNullOrEmpty(tmpDir) ? Path.GetTempPath() : tmpDir;
        string directory = Path.Combine(root, "tdc-fp-" + Guid.NewGuid().ToString("N")[..8]);
        System.IO.Directory.CreateDirectory(directory);

        var asFunctions = new List<Func<int, string>>();
        foreach (Resolver resolver in resolvers)
        {
            asFunctions.Add(row => resolver(row));
        }

        List<string> rawPaths = Fingerprint.WritePiles(
            asFunctions, 0, count, directory, "raw", buckets, Join.ToString());

        var sortedPaths = new List<string>();
        var candidates = new List<List<int>>();
        for (int b = 0; b < buckets; b++)
        {
            string outPath = Path.Combine(directory, $"sorted-{b}");
            Fingerprint.SortFiles(new[] { rawPaths[b] }, outPath, directory);
            File.Delete(rawPaths[b]);
            sortedPaths.Add(outPath);
            candidates.AddRange(Fingerprint.CandidateGroups(outPath));
        }

        return new FingerprintScan(sortedPaths, directory, Verify(resolvers, candidates));
    }

    /// <summary>Keep only the rows whose tuples GENUINELY repeat, lowest row of each group spared.</summary>
    private static List<int> Verify(
        IReadOnlyList<Resolver> resolvers, List<List<int>> candidates)
    {
        var excess = new List<int>();
        foreach (List<int> group in candidates)
        {
            var byKey = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            foreach (int row in group)
            {
                var key = new StringBuilder();
                for (int r = 0; r < resolvers.Count; r++)
                {
                    if (r > 0)
                    {
                        key.Append(Join);
                    }

                    key.Append(resolvers[r](row));
                }

                string text = key.ToString();
                if (!byKey.TryGetValue(text, out List<int>? rows))
                {
                    rows = new List<int>();
                    byKey[text] = rows;
                }

                rows.Add(row);
            }

            foreach (List<int> rows in byKey.Values)
            {
                if (rows.Count < 2)
                {
                    continue; // a hash collision, not a duplicate
                }

                rows.Sort();
                excess.AddRange(rows.GetRange(1, rows.Count - 1));
            }
        }

        excess.Sort();
        return excess;
    }

    private static IEnumerable<List<int>> DuplicateGroups(
        IReadOnlyList<Resolver> resolvers, int count, string tmpDir)
    {
        IEnumerable<string> Records()
        {
            for (int i = 0; i < count; i++)
            {
                var key = new StringBuilder();
                for (int j = 0; j < resolvers.Count; j++)
                {
                    if (j > 0)
                    {
                        key.Append(Join);
                    }

                    key.Append(resolvers[j](i));
                }

                key.Append(Sep);
                key.Append(i.ToString(CultureInfo.InvariantCulture).PadLeft(IndexWidth, '0'));
                yield return key.ToString();
            }
        }

        string? currentKey = null;
        var group = new List<int>();
        foreach (string record in ExternalSort.Sort(Records(), 0, tmpDir))
        {
            int split = record.LastIndexOf(Sep);
            string key = record[..split];
            int index = int.Parse(record[(split + 1)..], CultureInfo.InvariantCulture);
            if (key != currentKey)
            {
                if (group.Count >= 2)
                {
                    yield return group;
                }

                group = new List<int>();
                currentKey = key;
            }

            group.Add(index);
        }

        if (group.Count >= 2)
        {
            yield return group;
        }
    }

    /// <summary>
    /// Rearrange the pool's columns so its tuples are distinct and none is already taken.
    /// </summary>
    /// <remarks>
    /// Each column is permuted within itself, never added to or taken from, so the pool's totals
    /// survive the pass. What changes is which values meet each other.
    /// </remarks>
    private static List<List<string>>? ArrangeAvoiding(
        IReadOnlyList<IReadOnlyList<string>> columns, IMembership forbidden, int size)
    {
        int k = columns.Count;
        if (size == 0 || k == 0)
        {
            return columns.Select(c => c.ToList()).ToList();
        }

        IReadOnlyList<List<string>> arranged = Uniq.Arrange(columns).Columns;
        var rows = new List<List<string>>(size);
        for (int i = 0; i < size; i++)
        {
            rows.Add(arranged.Select(column => column[i]).ToList());
        }

        for (int sweep = 0; sweep < 32; sweep++)
        {
            var tally = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (List<string> row in rows)
            {
                string key = KeyOf(row);
                tally[key] = tally.GetValueOrDefault(key) + 1;
            }

            bool improved = false;
            for (int i = 0; i < size; i++)
            {
                List<string> ri = rows[i];
                string keyI = KeyOf(ri);
                if (!IsBad(tally, forbidden, keyI))
                {
                    continue;
                }

                bool done = false;
                for (int col = 0; col < k && !done; col++)
                {
                    for (int j = 0; j < size && !done; j++)
                    {
                        List<string> rj = rows[j];
                        if (j == i || ri[col] == rj[col])
                        {
                            continue;
                        }

                        var ni = new List<string>(ri);
                        var nj = new List<string>(rj);
                        ni[col] = rj[col];
                        nj[col] = ri[col];
                        string keyJ = KeyOf(rj);
                        string newI = KeyOf(ni);
                        string newJ = KeyOf(nj);

                        // Row i is known bad — that is why a partner is being looked for at all.
                        int before = 1 + (IsBad(tally, forbidden, keyJ) ? 1 : 0);
                        // A swap moves two rows, so only four tallies can change. Computing the
                        // delta beats copying the whole table inside the innermost loop, which is
                        // what makes a large pool finish rather than hang.
                        int after =
                            (IsBadAfter(tally, forbidden, newI, keyI, keyJ, newI, newJ) ? 1 : 0)
                            + (IsBadAfter(tally, forbidden, newJ, keyI, keyJ, newI, newJ) ? 1 : 0);
                        if (after < before)
                        {
                            rows[i] = ni;
                            rows[j] = nj;
                            tally[keyI] = tally.GetValueOrDefault(keyI) - 1;
                            tally[keyJ] = tally.GetValueOrDefault(keyJ) - 1;
                            tally[newI] = tally.GetValueOrDefault(newI) + 1;
                            tally[newJ] = tally.GetValueOrDefault(newJ) + 1;
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

        var finalTally = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (List<string> row in rows)
        {
            string key = KeyOf(row);
            finalTally[key] = finalTally.GetValueOrDefault(key) + 1;
        }

        if (rows.Any(row => IsBad(finalTally, forbidden, KeyOf(row))))
        {
            return null;
        }

        var result = new List<List<string>>(k);
        for (int j = 0; j < k; j++)
        {
            result.Add(rows.Select(row => row[j]).ToList());
        }

        return result;
    }

    private static bool IsBad(
        IReadOnlyDictionary<string, int> tally, IMembership forbidden, string key) =>
        tally.GetValueOrDefault(key) > 1 || forbidden.Has(key);

    /// <summary>The verdict on <paramref name="key"/> as it would stand after the two rows swapped.</summary>
    private static bool IsBadAfter(
        IReadOnlyDictionary<string, int> tally, IMembership forbidden, string key, string oldI,
        string oldJ, string newI, string newJ)
    {
        int after = tally.GetValueOrDefault(key)
            + (key == newI ? 1 : 0)
            + (key == newJ ? 1 : 0)
            - (key == oldI ? 1 : 0)
            - (key == oldJ ? 1 : 0);
        return after > 1 || forbidden.Has(key);
    }

    private static string KeyOf(IReadOnlyList<string> row) => string.Join(Join, row);

    private static int[] Cumulative(int[] counts)
    {
        var result = new int[counts.Length];
        int acc = 0;
        for (int i = 0; i < counts.Length; i++)
        {
            acc += counts[i];
            result[i] = acc;
        }

        return result;
    }

    private static int RunFor(int[] cumHi, int slot)
    {
        int lo = 0;
        int hi = cumHi.Length - 1;
        while (lo < hi)
        {
            int mid = (int)(((uint)(lo + hi)) >> 1);
            if (slot < cumHi[mid])
            {
                hi = mid;
            }
            else
            {
                lo = mid + 1;
            }
        }

        return lo;
    }
}
