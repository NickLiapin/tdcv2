using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Tdcv2.Engine;

/// <summary>
/// Tuple fingerprints — how a large uniq run finds its duplicates.
/// </summary>
/// <remarks>
/// <para>
/// Sorting the tuples THEMSELVES means sorting text: records of eighty-odd characters, millions of
/// strings, each one an object the collector has to track. That text is what makes the middle of a
/// big run heavy — in scratch disk, in sort time, and in memory.
/// </para>
/// <para>
/// None of it is needed to DETECT a duplicate. Detection only asks "are these two the same?", and
/// a hash answers that in thirteen bytes: <c>[hi 4B][lo 4B][row index 5B]</c>, big-endian, fixed
/// width.
/// </para>
/// <para>
/// Fixed width and big-endian together buy the whole design. Comparing the raw thirteen bytes IS
/// comparing <c>(hi, lo, index)</c>, so sorting needs no comparator and every implementation
/// agrees by construction. And a record's place in a file is <c>13 * ordinal</c>, so a sorted pile
/// can be binary-searched on disk: "is this tuple taken?" costs about twenty-five tiny reads and
/// no resident memory at all.
/// </para>
/// <para>
/// A 64-bit hash is not proof — two different tuples can collide — so a group of records sharing a
/// hash is a CANDIDATE, not a verdict. Candidates are verified by recomputing the actual tuples by
/// row number. That is what makes the duplicates found exactly the ones the text sort would name.
/// </para>
/// <para>
/// Every number here is part of the cross-language contract, pinned by
/// <c>fixtures/cross-language/fingerprint-vectors.json</c>.
/// </para>
/// </remarks>
public static class Fingerprint
{
    /// <summary>Bytes per record: 4 (hash hi) + 4 (hash lo) + 5 (row index).</summary>
    public const int RecordBytes = 13;

    /// <summary>Rows a 5-byte index can name. Checked at the door rather than wrapped silently.</summary>
    public const long MaxIndex = 1L << 40;

    /// <summary>Records held in memory per sort batch.</summary>
    private const int SortBatch = 2_000_000;

    /// <summary>The 64-bit fingerprint of a tuple key, as two 32-bit halves.</summary>
    public static (int Hi, int Lo) Hash64(string key)
    {
        int[] state = Prng.Prng.Cyrb128(key);
        return (state[0], state[1]);
    }

    /// <summary>Which pile a fingerprint belongs to. The hash word is UNSIGNED.</summary>
    public static int BucketOf(int hi, int buckets) => (int)((uint)hi % (uint)buckets);

    /// <summary>
    /// How many piles for a run of <paramref name="count"/> rows.
    /// </summary>
    /// <remarks>
    /// A short run gets one pile — the signal to stay on the exact text path, where hashing has
    /// nothing to pay for itself with. Above that, four piles per core: measured sizes come out
    /// even enough that no core waits on a straggler.
    /// </remarks>
    public static int BucketCountFor(long count, int cores)
    {
        if (count < 1_000_000L)
        {
            return 1;
        }

        return Math.Min(256, Math.Max(2, Math.Max(1, cores) * 4));
    }

    /// <summary>One record's bytes. Refuses an index the five bytes cannot carry.</summary>
    public static byte[] Encode(int hi, int lo, long index)
    {
        if (index >= MaxIndex)
        {
            throw new ArgumentOutOfRangeException(
                nameof(index),
                $"fingerprint index {index} exceeds the 5-byte record limit ({MaxIndex} rows)");
        }

        var record = new byte[RecordBytes];
        WriteUInt32BigEndian(record, 0, (uint)hi);
        WriteUInt32BigEndian(record, 4, (uint)lo);
        for (int b = 0; b < 5; b++)
        {
            record[8 + b] = (byte)((index >> ((4 - b) * 8)) & 0xFF);
        }

        return record;
    }

    /// <summary>The row index carried by one record.</summary>
    public static long IndexOf(ReadOnlySpan<byte> record)
    {
        long index = 0;
        for (int b = 0; b < 5; b++)
        {
            index = (index << 8) | record[8 + b];
        }

        return index;
    }

    private static void WriteUInt32BigEndian(byte[] target, int at, uint value)
    {
        target[at] = (byte)(value >> 24);
        target[at + 1] = (byte)(value >> 16);
        target[at + 2] = (byte)(value >> 8);
        target[at + 3] = (byte)value;
    }

    /// <summary>Writes fingerprint records to a file, buffered.</summary>
    public sealed class Writer : IDisposable
    {
        private readonly Stream _out;

        public Writer(string path)
        {
            _out = new BufferedStream(File.Create(path), 1 << 20);
        }

        public void Write(int hi, int lo, long index) => _out.Write(Encode(hi, lo, index));

        public void Dispose() => _out.Dispose();
    }

    /// <summary>
    /// Hash rows <c>[from, to)</c> and route each fingerprint into its pile file.
    /// </summary>
    /// <remarks>
    /// Returns one path per pile, in pile order. Nothing is sorted here — a pile is sorted by
    /// whoever picks it up.
    /// </remarks>
    public static List<string> WritePiles(
        IReadOnlyList<Func<int, string>> resolvers,
        int from,
        int to,
        string dir,
        string prefix,
        int buckets,
        string join,
        Progress? onProgress = null)
    {
        var paths = new List<string>();
        var writers = new List<Writer>();
        for (int b = 0; b < buckets; b++)
        {
            string path = Path.Combine(dir, $"{prefix}-{b}");
            paths.Add(path);
            writers.Add(new Writer(path));
        }

        try
        {
            var key = new StringBuilder();
            // About one report per half-percent of the range: cheap enough to leave on always.
            int reportEvery = Math.Max(1, (to - from) / 200);
            for (int row = from; row < to; row++)
            {
                if (onProgress is not null && (row - from) % reportEvery == 0)
                {
                    onProgress("uniq-scan", row - from, to - from);
                }

                key.Clear();
                for (int r = 0; r < resolvers.Count; r++)
                {
                    if (r > 0)
                    {
                        key.Append(join);
                    }

                    key.Append(resolvers[r](row));
                }

                (int hi, int lo) = Hash64(key.ToString());
                writers[BucketOf(hi, buckets)].Write(hi, lo, row);
            }
        }
        finally
        {
            foreach (Writer writer in writers)
            {
                writer.Dispose();
            }
        }

        return paths;
    }

    /// <summary>
    /// Sort any number of fingerprint files into ONE sorted file. Returns the record count.
    /// </summary>
    /// <remarks>
    /// The records are sorted AS BYTES. Because the encoding is big-endian and fixed width, that
    /// is exactly <c>(hi, lo, index)</c> ascending — no comparator to reproduce, and no way for
    /// two implementations to disagree about the order.
    /// </remarks>
    public static long SortFiles(IReadOnlyList<string> inputs, string outPath, string tmpRoot)
    {
        string dir = Path.Combine(tmpRoot, "tdc-fp-sort-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        var runs = new List<string>();
        long total = 0;
        try
        {
            var batch = new List<byte[]>();
            foreach (string input in inputs)
            {
                foreach (byte[] record in ReadRecords(input))
                {
                    batch.Add(record);
                    total++;
                    if (batch.Count >= SortBatch)
                    {
                        runs.Add(WriteRun(batch, dir, runs.Count));
                    }
                }
            }

            if (batch.Count > 0)
            {
                runs.Add(WriteRun(batch, dir, runs.Count));
            }

            MergeRuns(runs, outPath);
            return total;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>Every record in a file, one at a time, in bounded memory.</summary>
    public static IEnumerable<byte[]> ReadRecords(string path)
    {
        using FileStream stream = File.OpenRead(path);
        var buffer = new byte[RecordBytes * 4096];
        while (true)
        {
            int read = stream.Read(buffer, 0, buffer.Length);
            if (read <= 0)
            {
                yield break;
            }

            for (int at = 0; at + RecordBytes <= read; at += RecordBytes)
            {
                yield return buffer[at..(at + RecordBytes)];
            }
        }
    }

    private static string WriteRun(List<byte[]> batch, string dir, int index)
    {
        batch.Sort(CompareRecords);
        string path = Path.Combine(dir, $"run-{index}");
        using (var out_ = new BufferedStream(File.Create(path), 1 << 20))
        {
            foreach (byte[] record in batch)
            {
                out_.Write(record);
            }
        }

        batch.Clear();
        return path;
    }

    /// <summary>Unsigned byte order — the total order the whole design rests on.</summary>
    public static int CompareRecords(byte[] a, byte[] b)
    {
        for (int i = 0; i < RecordBytes; i++)
        {
            int diff = a[i].CompareTo(b[i]);
            if (diff != 0)
            {
                return diff;
            }
        }

        return 0;
    }

    private static void MergeRuns(List<string> runs, string outPath)
    {
        var readers = new List<IEnumerator<byte[]>>();
        foreach (string run in runs)
        {
            IEnumerator<byte[]> reader = ReadRecords(run).GetEnumerator();
            readers.Add(reader);
        }

        try
        {
            var heads = new byte[readers.Count][];
            for (int r = 0; r < readers.Count; r++)
            {
                heads[r] = readers[r].MoveNext() ? readers[r].Current : null!;
            }

            using var out_ = new BufferedStream(File.Create(outPath), 1 << 20);
            while (true)
            {
                int best = -1;
                for (int r = 0; r < heads.Length; r++)
                {
                    if (heads[r] is null)
                    {
                        continue;
                    }

                    if (best < 0 || CompareRecords(heads[r], heads[best]) < 0)
                    {
                        best = r;
                    }
                }

                if (best < 0)
                {
                    break;
                }

                out_.Write(heads[best]);
                heads[best] = readers[best].MoveNext() ? readers[best].Current : null!;
            }
        }
        finally
        {
            foreach (IEnumerator<byte[]> reader in readers)
            {
                reader.Dispose();
            }
        }
    }

    /// <summary>
    /// Row groups that share a fingerprint, from a SORTED file.
    /// </summary>
    /// <remarks>
    /// Candidates, not verdicts: a 64-bit collision between different tuples lands here too, so
    /// the caller recomputes the true tuples and keeps only the rows that genuinely repeat.
    /// </remarks>
    public static List<List<int>> CandidateGroups(string sortedPath)
    {
        var groups = new List<List<int>>();
        byte[]? current = null;
        var group = new List<int>();
        foreach (byte[] record in ReadRecords(sortedPath))
        {
            bool sameHash = current is not null && SameFingerprint(current, record);
            if (!sameHash)
            {
                if (group.Count >= 2)
                {
                    groups.Add(group);
                }

                group = new List<int>();
                current = record;
            }

            group.Add((int)IndexOf(record));
        }

        if (group.Count >= 2)
        {
            groups.Add(group);
        }

        return groups;
    }

    private static bool SameFingerprint(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        for (int i = 0; i < 8; i++)
        {
            if (a[i] != b[i])
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// "Is this tuple already taken?" — answered by binary search on the sorted piles.
    /// </summary>
    /// <remarks>
    /// The sorted fingerprints ARE the ledger; a lookup is about twenty-five record-sized reads
    /// and no resident memory. Rows being reassigned have their old tuples freed, so a match
    /// counts only if some matching record's row is not among them. A 64-bit collision can only
    /// make the answer "taken" for a free tuple — the repair then picks another combination; it
    /// can never hide a taken one.
    /// </remarks>
    public sealed class Ledger : ExactUniq.IMembership, IDisposable
    {
        private readonly List<FileStream> _files = new();
        private readonly long[] _counts;
        private readonly HashSet<int> _moving;
        private readonly int _piles;
        private readonly byte[] _probe = new byte[RecordBytes];

        public Ledger(IReadOnlyList<string> sortedPaths, HashSet<int> moving)
        {
            _moving = moving;
            _piles = sortedPaths.Count;
            _counts = new long[_piles];
            for (int b = 0; b < _piles; b++)
            {
                _files.Add(File.OpenRead(sortedPaths[b]));
                _counts[b] = new FileInfo(sortedPaths[b]).Length / RecordBytes;
            }
        }

        public bool Has(string key)
        {
            (int hi, int lo) = Hash64(key);
            int pile = BucketOf(hi, _piles);
            long count = _counts[pile];
            if (count == 0)
            {
                return false;
            }

            byte[] wanted = Encode(hi, lo, 0);
            FileStream file = _files[pile];

            long low = 0;
            long high = count;
            while (low < high)
            {
                long mid = (low + high) / 2;
                file.Seek(mid * RecordBytes, SeekOrigin.Begin);
                FillExactly(file, _probe);
                if (CompareFingerprint(_probe, wanted) < 0)
                {
                    low = mid + 1;
                }
                else
                {
                    high = mid;
                }
            }

            for (long at = low; at < count; at++)
            {
                file.Seek(at * RecordBytes, SeekOrigin.Begin);
                FillExactly(file, _probe);
                if (CompareFingerprint(_probe, wanted) != 0)
                {
                    break;
                }

                if (!_moving.Contains((int)IndexOf(_probe)))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>Read a whole record. A short read mid-file means the pile is corrupt.</summary>
        private static void FillExactly(Stream stream, byte[] into)
        {
            int at = 0;
            while (at < into.Length)
            {
                int read = stream.Read(into, at, into.Length - at);
                if (read <= 0)
                {
                    throw new EndOfStreamException("fingerprint pile ended mid-record");
                }

                at += read;
            }
        }

        private static int CompareFingerprint(byte[] a, byte[] b)
        {
            for (int i = 0; i < 8; i++)
            {
                int diff = a[i].CompareTo(b[i]);
                if (diff != 0)
                {
                    return diff;
                }
            }

            return 0;
        }

        public void Dispose()
        {
            foreach (FileStream file in _files)
            {
                file.Dispose();
            }
        }
    }
}
