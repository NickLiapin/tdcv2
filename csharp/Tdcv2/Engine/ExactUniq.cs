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
    internal const char Join = (char)1;

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

    /// <summary>
    /// The exact construction collided and the bounded repair could not place every row.
    /// </summary>
    /// <remarks>
    /// Two audiences, one sentence. A caller that CHOSE a bounded-memory engine for the user
    /// catches this and falls back to the in-memory engine, which has the whole table to work with.
    /// A caller the user forced into stream mode lets it through instead: holding the whole table is
    /// the one thing that user asked not to happen, so the text says what to change rather than
    /// claiming a fallback that did not occur.
    /// </remarks>
    /// <remarks>
    /// An <c>InvalidOperationException</c>, like <c>UnsupportedHere</c> beside it, because that is
    /// the family the CLI turns into one line and exit 1. As a plain <c>Exception</c> it escaped
    /// both catches and printed a .NET stack trace with exit 134 — a crash where the reference
    /// prints a sentence — the moment env-level uniq made it reachable from a forced engine.
    /// </remarks>
    internal sealed class RepairNeeded : InvalidOperationException
    {
        internal RepairNeeded(int collisions, string label)
            : this(collisions, label, false)
        {
        }

        /// <param name="collisions">How many rows could not be placed.</param>
        /// <param name="label">The group, named the way the config names it.</param>
        /// <param name="atLeast">
        /// Says the count is a floor, not a total. The scan that finds repeats stops as soon as it
        /// is past the cap, because nothing it could find afterwards changes the answer. What it
        /// gives up is the exact figure, and a number that is quietly 20,001 where the truth is
        /// 1,618,803 is worse than no number: it invites someone to widen a column by a little.
        /// </param>
        internal RepairNeeded(int collisions, string label, bool atLeast)
            : base(
                $"uniq {label} is too tight to repair without holding the whole table ("
                + (atLeast ? $"more than {collisions} rows" : $"{collisions} row(s)")
                + " couldn't be placed) — run without mode=\"stream\" so the in-memory engine "
                + "can arrange it.")
        {
        }
    }

    /// <summary>One uniq column: where it lands in the registry, its values, and their shares.</summary>
    internal sealed record Field(string Id, IReadOnlyList<string> Values, double[] Percents);

    /// <summary>
    /// How an arrangement travels between the thread that works it out and the ones that do not.
    /// </summary>
    /// <remarks>
    /// Deciding which rows a uniq group moves where is a pass over every row to find the
    /// collisions and a second to learn which tuples are taken — the expensive half of a uniq
    /// run, and the same answer every time for a given config and seed. <c>OnComputed</c> hands
    /// the result out; <c>Preset</c> hands it back in, and a worker holding one skips the
    /// analysis entirely. That is what lets several threads render different row ranges of one
    /// uniq config instead of each repeating the whole hunt. The result is small — only the rows
    /// that actually moved — so it crosses a thread boundary for nothing.
    /// </remarks>
    internal sealed record Plan(
        Dictionary<int, List<string>>? Preset,
        Action<Dictionary<int, List<string>>>? OnComputed);

    /// <summary>A column of the finished arrangement: the value it gives a row.</summary>
    internal delegate string Resolver(int row);

    /// <summary>
    /// Build the uniq columns with exact shares, and make sure the tuples really are distinct.
    /// </summary>
    /// <returns>One resolver per field, in the order they were given.</returns>
    internal static IReadOnlyDictionary<string, Resolver> Arrange(
        IReadOnlyList<Field> fields, int count, string seed, string label, string tmpDir,
        Progress? onProgress = null, Plan? plan = null)
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
            // Nothing moves, and a worker waiting to be told must hear that rather than wait.
            plan?.OnComputed?.Invoke(new Dictionary<int, List<string>>());
            return RegistryOf(IdsOf(fields), resolvers);
        }

        return Repair(IdsOf(fields), resolvers, count, label, tmpDir, null, onProgress, plan);
    }

    private static IReadOnlyList<string> IdsOf(IReadOnlyList<Field> fields) =>
        fields.Select(field => field.Id).ToList();

    private static IReadOnlyDictionary<string, Resolver> RegistryOf(
        IReadOnlyList<string> ids, IReadOnlyList<Resolver> resolvers)
    {
        var result = new Dictionary<string, Resolver>(StringComparer.Ordinal);
        for (int j = 0; j < ids.Count; j++)
        {
            result[ids[j]] = resolvers[j];
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
    /// <para>
    /// <paramref name="blockOf"/> names which rows may trade values with each other. A
    /// <c>&lt;switch&gt;</c> member draws from a different list depending on another column, so a
    /// male row's first name is not a value a female row is allowed to hold; without this the repair
    /// would keep the tuple unique and stop the record making sense. <c>null</c> means one block
    /// holding everything, which is the ordinary case.
    /// </para>
    /// </remarks>
    internal static IReadOnlyDictionary<string, Resolver> Repair(
        IReadOnlyList<string> ids, IReadOnlyList<Resolver> resolvers, int count, string label,
        string tmpDir, Func<int, string>? blockOf, Progress? onProgress = null, Plan? plan = null)
    {
        // Told rather than worked out: the whole point of a plan. Nothing below this line runs.
        if (plan?.Preset is not null)
        {
            return ApplyOverride(ids, resolvers, plan.Preset);
        }

        // How the duplicates are hunted: by fingerprint on a large run, by tuple text on a small
        // one. The carrier is all that differs — the rows found are the same either way, because a
        // matching fingerprint is verified against the true tuples before it is believed.
        var report = new RepairReport(onProgress);
        FingerprintScan? scan = RunFingerprintScan(resolvers, count, tmpDir, onProgress, report);

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
            plan?.OnComputed?.Invoke(new Dictionary<int, List<string>>());
            return RegistryOf(ids, resolvers);
        }

        int cap = MaxRepairRowsFor(count);
        if (excess.Count > cap)
        {
            scan?.Drop();
            // The fingerprint path stops counting once it is past the cap, so its figure is a
            // floor. Said as a floor; everywhere else it is exact.
            bool partial = scan?.Partial ?? false;
            throw new RepairNeeded(partial ? cap : excess.Count, label, partial);
        }

        // The colliding rows on their own often lack the variety to move — a lone duplicate can
        // only re-form the tuple it already has. So the pool takes in donor rows sampled across the
        // run, which gives the arrangement room without letting any value leave the pool.
        excess.Sort();
        int donorTarget = Math.Min(count - excess.Count, (8 * excess.Count) + 24);
        var inPool = new HashSet<int>(excess);
        var pool = new List<int>(excess);
        if (donorTarget > 0 && blockOf is null)
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
        else if (donorTarget > 0)
        {
            // Donors have to come from the row's OWN block, or they arrive holding values it is not
            // allowed to take. Wanted per block, in proportion to how many of its rows have to move.
            var wanted = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (int row in excess)
            {
                string block = blockOf!(row);
                wanted[block] = wanted.TryGetValue(block, out int held) ? held + 8 : 8;
            }

            foreach (string block in wanted.Keys.ToList())
            {
                wanted[block] += 24;
            }

            int stride = Math.Max(1, count / Math.Max(1, donorTarget));
            for (int i = 0; i < count; i += stride)
            {
                if (inPool.Contains(i))
                {
                    continue;
                }

                string block = blockOf!(i);
                if (!wanted.TryGetValue(block, out int left) || left <= 0)
                {
                    continue;
                }

                wanted[block] = left - 1;
                inPool.Add(i);
                pool.Add(i);
            }
        }

        pool.Sort();

        int k = resolvers.Count;
        report.Step(pool.Count);
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

        // The pool is arranged one block at a time: a value only ever lands on a row that was
        // allowed to hold it. One block, keyed by the empty string, is the ordinary case.
        var blocks = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        var blockOrder = new List<string>();
        for (int m = 0; m < pool.Count; m++)
        {
            string block = blockOf is null ? string.Empty : blockOf(pool[m]);
            if (!blocks.TryGetValue(block, out List<int>? positions))
            {
                positions = new List<int>();
                blocks[block] = positions;
                blockOrder.Add(block);
            }

            positions.Add(m);
        }

        var overrides = new Dictionary<int, List<string>>();
        try
        {
            foreach (string block in blockOrder)
            {
                List<int> positions = blocks[block];
                var columns = poolColumns
                    .Select(column => (IReadOnlyList<string>)positions.Select(m => column[m]).ToList())
                    .ToList();
                List<List<string>>? arranged =
                    ArrangeAvoiding(columns, forbidden, positions.Count, report);
                if (arranged is null)
                {
                    throw new RepairNeeded(excess.Count, label);
                }

                for (int at = 0; at < positions.Count; at++)
                {
                    int index = at;
                    overrides[pool[positions[at]]] =
                        arranged.Select(column => column[index]).ToList();
                }
            }
        }
        finally
        {
            ledger?.Dispose();
            scan?.Drop();
        }

        report.Finish();
        plan?.OnComputed?.Invoke(overrides);
        return ApplyOverride(ids, resolvers, overrides);
    }

    /// <summary>
    /// Columns that answer from the override where there is one and from the original resolver
    /// everywhere else — which is all a repaired uniq column IS.
    /// </summary>
    private static IReadOnlyDictionary<string, Resolver> ApplyOverride(
        IReadOnlyList<string> ids, IReadOnlyList<Resolver> resolvers,
        Dictionary<int, List<string>> overrides)
    {
        var result = new Dictionary<string, Resolver>(StringComparer.Ordinal);
        for (int j = 0; j < ids.Count; j++)
        {
            int column = j;
            Resolver baseResolver = resolvers[j];
            result[ids[j]] = row =>
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
    /// <summary>
    /// One rising scale for the whole <c>uniq-repair</c> phase.
    /// </summary>
    /// <remarks>
    /// The repair is several steps with different units: candidate groups to check here, pool
    /// rows to prepare there, then a deal repeated per sweep. Reported straight, each step would
    /// restart the counter at zero, and a bar drawn from the phase would jump backwards every
    /// time one ended — which reads as a bug, not as progress.
    /// <para>
    /// So the steps are added up. Each declares its size, the phase's total grows to hold it, and
    /// <c>done</c> only ever rises. The total is not known in advance and is not meant to be: it
    /// is what has been taken on so far.
    /// </para>
    /// </remarks>
    // Internal, not private: the rising scale is a promise to whoever draws a bar from this
    // channel, and a promise is worth a test of its own.
    internal sealed class RepairReport
    {
        private readonly Progress? _onProgress;
        private long _base;
        private long _size;

        internal RepairReport(Progress? onProgress)
        {
            _onProgress = onProgress;
        }

        private void Emit(long done)
        {
            _onProgress?.Invoke("uniq-repair", Fits(done), Fits(_base + _size));
        }

        /// <summary>Take on a step of <paramref name="next"/> units. Ends the previous one.</summary>
        internal void Step(long next)
        {
            _base += _size;
            _size = next;
            Emit(_base);
        }

        /// <summary><paramref name="done"/> units into the current step.</summary>
        internal void At(long done) => Emit(_base + done);

        /// <summary>Close the phase full, so a watcher sees it end rather than stall.</summary>
        internal void Finish() => Emit(_base + _size);

        /// <summary>
        /// The channel carries <c>int</c>s and the scale is a SUM, so it could in principle
        /// outgrow one where a row count never does. Held at the ceiling rather than wrapped: a
        /// bar that stops at full is wrong by a little, a bar that goes negative is wrong by
        /// everything.
        /// </summary>
        private static int Fits(long value) => value > int.MaxValue ? int.MaxValue : (int)value;
    }

    /// <param name="Partial">True when the verify stopped at the cap, so <c>Excess</c> is a floor.</param>
    private sealed record FingerprintScan(
        List<string> SortedPaths, string Directory, List<int> Excess, bool Partial)
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
        IReadOnlyList<Resolver> resolvers, int count, string tmpDir, Progress? onProgress,
        RepairReport report)
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
            asFunctions, 0, count, directory, "raw", buckets, Join.ToString(), onProgress);

        var sortedPaths = new List<string>();
        var candidates = new List<List<int>>();
        for (int b = 0; b < buckets; b++)
        {
            onProgress?.Invoke("uniq-sort", b, buckets);
            string outPath = Path.Combine(directory, $"sorted-{b}");
            Fingerprint.SortFiles(new[] { rawPaths[b] }, outPath, directory);
            File.Delete(rawPaths[b]);
            sortedPaths.Add(outPath);
            candidates.AddRange(Fingerprint.CandidateGroups(outPath));
        }

        // Past the cap the caller refuses whatever the exact figure is, so the verify is told
        // where the answer stops mattering.
        int stopAfter = MaxRepairRowsFor(count);
        List<int> excess = Verify(resolvers, candidates, report, stopAfter);
        return new FingerprintScan(sortedPaths, directory, excess, excess.Count > stopAfter);
    }

    /// <summary>Keep only the rows whose tuples GENUINELY repeat, lowest row of each group spared.</summary>
    private static List<int> Verify(
        IReadOnlyList<Resolver> resolvers,
        List<List<int>> candidates,
        RepairReport report,
        int stopAfter)
    {
        var excess = new List<int>();
        report.Step(candidates.Count);
        // Reported, because this is where a large run goes quiet: every candidate group costs a
        // tuple recomputed per row to tell a real duplicate from a hash collision, and there can
        // be a hundred thousand of them — tens of seconds saying nothing.
        int reportEvery = Math.Max(1, candidates.Count / 200);
        int reported = 0;
        foreach (List<int> group in candidates)
        {
            if (reported % reportEvery == 0)
            {
                report.At(reported);
            }

            reported++;
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

            // Past the cap the run falls back to the in-memory engine whatever the exact figure
            // is, and finding it out costs a tuple recomputed per row for every remaining group.
            // On a config that misses the cap by two orders of magnitude — 1,618,803 rows against
            // 20,000 — the reference measured 6.79 s to finish counting against 0.08 s to stop.
            if (excess.Count > stopAfter)
            {
                break;
            }
        }

        excess.Sort();
        return excess;
    }

    private static IEnumerable<List<int>> DuplicateGroups(
        IReadOnlyList<Resolver> resolvers, int count, string tmpDir, Progress? onProgress = null)
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
        IReadOnlyList<IReadOnlyList<string>> columns, IMembership forbidden, int size,
        RepairReport report)
    {
        int k = columns.Count;
        if (size == 0 || k == 0)
        {
            return columns.Select(c => c.ToList()).ToList();
        }

        // Said BEFORE the first deal: Uniq.Arrange below is itself seconds of work on a large
        // pool, and a watcher that only heard from the sweep loop would sit on a stale
        // "uniq-sort" throughout it. The phase NAME answers "what is it doing".
        report.Step(size);
        IReadOnlyList<List<string>> arranged = Uniq.Arrange(columns).Columns;
        var rows = new List<List<string>>(size);
        for (int i = 0; i < size; i++)
        {
            rows.Add(arranged.Select(column => column[i]).ToList());
        }

        int reportEvery = Math.Max(1, size / 200);
        for (int sweep = 0; sweep < 32; sweep++)
        {
            // Each sweep is another `size` units taken on, so the scale grows with the work
            // instead of the counter restarting inside the phase.
            if (sweep > 0)
            {
                report.Step(size);
            }

            var tally = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (List<string> row in rows)
            {
                string key = KeyOf(row);
                tally[key] = tally.GetValueOrDefault(key) + 1;
            }

            bool improved = false;
            for (int i = 0; i < size; i++)
            {
                if (i % reportEvery == 0)
                {
                    report.At(i);
                }

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
