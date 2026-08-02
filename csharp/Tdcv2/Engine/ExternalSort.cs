using System.Text;

namespace Tdcv2.Engine;

/// <summary>
/// Sort more records than fit in memory.
/// </summary>
/// <remarks>
/// <para>
/// The oldest trick there is, and still the right one: fill a buffer, sort it, write it out,
/// repeat; then merge the sorted runs by always taking the smallest head. Memory is bounded by one
/// chunk plus one line per run, whatever the input's size.
/// </para>
/// <para>
/// Engine 3 needs it for one question — are any two records identical — which cannot be answered by
/// a hash set once the answer stops fitting in RAM. Sorting puts equal records next to each other,
/// and the scan that follows holds nothing but the group it is in.
/// </para>
/// <para>
/// An input that fits in a single chunk never touches the disk. Most runs are that, and paying for
/// temp files to sort ten thousand rows would make the exact engine slower than the one it exists to
/// replace.
/// </para>
/// </remarks>
internal static class ExternalSort
{
    /// <summary>Records held in memory per run. Roughly a hundred megabytes of short keys.</summary>
    private const int DefaultChunk = 1_000_000;

    /// <summary>
    /// The records in ascending order.
    /// </summary>
    /// <remarks>
    /// Returns an enumerable rather than a list on purpose: the caller scans it once, and
    /// materializing the result would give back exactly the memory this class was called to save.
    /// Ordinal order, not culture order — the keys are opaque and only equality of neighbours
    /// matters, and a culture-aware comparison would also be slower and machine-dependent.
    /// </remarks>
    internal static IEnumerable<string> Sort(
        IEnumerable<string> records, int chunkSize, string tmpDir)
    {
        int chunkLimit = Math.Max(1, chunkSize <= 0 ? DefaultChunk : chunkSize);
        var runs = new List<string>();
        var chunk = new List<string>();
        string? dir = null;

        foreach (string record in records)
        {
            chunk.Add(record);
            if (chunk.Count >= chunkLimit)
            {
                dir ??= Directory.CreateDirectory(
                    Path.Combine(tmpDir, "tdc-esort-" + Guid.NewGuid().ToString("N"))).FullName;
                runs.Add(WriteRun(chunk, dir, runs.Count));
                chunk = new List<string>();
            }
        }

        // It all fit. Sort in memory and never create a file — the common case by far.
        if (runs.Count == 0)
        {
            chunk.Sort(StringComparer.Ordinal);
            return chunk;
        }

        if (chunk.Count > 0)
        {
            runs.Add(WriteRun(chunk, dir!, runs.Count));
        }

        return Merge(runs, dir!);
    }

    private static string WriteRun(List<string> chunk, string dir, int index)
    {
        chunk.Sort(StringComparer.Ordinal);
        string path = Path.Combine(dir, $"run-{index}.txt");
        using (var writer = new StreamWriter(path, false, Encoding.UTF8))
        {
            foreach (string record in chunk)
            {
                writer.Write(record);
                writer.Write('\n');
            }
        }

        return path;
    }

    /// <summary>The k-way merge: one line per run in memory, and the temp files gone when it ends.</summary>
    private static IEnumerable<string> Merge(List<string> runs, string dir)
    {
        var readers = new List<StreamReader>(runs.Count);
        try
        {
            // A sorted list keyed by (value, run) is the heap: the run index breaks ties so two
            // identical lines from different runs both survive rather than one displacing the other.
            var heap = new SortedSet<(string Value, int Run)>(
                Comparer<(string Value, int Run)>.Create((a, b) =>
                {
                    int cmp = string.CompareOrdinal(a.Value, b.Value);
                    return cmp != 0 ? cmp : a.Run.CompareTo(b.Run);
                }));

            for (int run = 0; run < runs.Count; run++)
            {
                var reader = new StreamReader(runs[run], Encoding.UTF8);
                readers.Add(reader);
                if (reader.ReadLine() is { } line)
                {
                    heap.Add((line, run));
                }
            }

            while (heap.Count > 0)
            {
                (string Value, int Run) top = heap.Min;
                heap.Remove(top);
                if (readers[top.Run].ReadLine() is { } line)
                {
                    heap.Add((line, top.Run));
                }

                yield return top.Value;
            }
        }
        finally
        {
            foreach (StreamReader reader in readers)
            {
                reader.Dispose();
            }

            // Dropped as soon as the scan ends rather than left for a caller to remember. A run
            // abandoned part-way still cleans up, because this is a finally on the iterator.
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
                // Temp files in the system's own temp directory; the OS clears them eventually.
            }
        }
    }
}
