using System.Text;
using Tdcv2.Model;
using Tdcv2.Packs;

namespace Tdcv2.Engine;

/// <summary>
/// One run split across threads.
/// </summary>
/// <remarks>
/// <para>
/// A TDC run is the easy case for this. The streaming engine keys every draw by
/// <c>seed|stream|index</c>, so row nine million is a function of its own number and needs to know
/// nothing about row eight million. A shard can therefore be computed with no coordination at all —
/// which is the entire reason the seekable generator exists.
/// </para>
/// <para>
/// Each worker builds its own engine from the same config and writes rows <c>[start, stop)</c> to
/// its own temporary file; the caller's file then receives them in order.
/// </para>
/// <para>
/// Each worker also gets its OWN <see cref="DataPacks"/>. Packs cache what they load in a plain
/// dictionary, and a dictionary being filled from several threads at once is a data race — one that
/// would show up as a corrupted value in one row of a hundred million, which is the worst kind of
/// bug to go looking for. Loading a pack twice is cheap; finding that bug is not.
/// </para>
/// <para>
/// Only the streaming engine qualifies. The in-memory engine holds the whole run anyway, so
/// splitting it would multiply the memory rather than the throughput, and the exact engine carries
/// state across rows that a shard cannot reconstruct. Both fall back to one thread, which is a
/// slower answer and never a wrong one.
/// </para>
/// <para>
/// The class is not called <c>Parallel</c> because <c>System.Threading.Tasks.Parallel</c> is in
/// scope everywhere implicit usings are on, and a name that resolves to two different types
/// depending on the file is worse than a longer one.
/// </para>
/// </remarks>
public static class ParallelWrite
{
    /// <summary>
    /// Below this, a thread costs more to start than its rows cost to generate.
    /// </summary>
    /// <remarks>
    /// Threads are cheaper than the processes Python needs, but a worker still builds its columns
    /// and loads its packs before it renders anything.
    /// </remarks>
    public const int MinRows = 100_000;

    /// <summary>One worker per core bar one, so the machine stays usable while a run is going.</summary>
    public static int DefaultWorkers() => Math.Max(1, Environment.ProcessorCount - 1);

    /// <summary>
    /// How many workers to actually use.
    /// </summary>
    /// <remarks>
    /// Safe to decide from the hardware because the worker count NEVER changes the output — unlike
    /// the engine, which has to be chosen from the config.
    /// </remarks>
    public static int ResolveWorkers(int? asked, bool canSplit, int count)
    {
        if (asked is not null)
        {
            return canSplit ? Math.Max(1, asked.Value) : 1;
        }

        return !canSplit || count < MinRows ? 1 : DefaultWorkers();
    }

    /// <summary>Whether this run can be split at all.</summary>
    public static bool CanSplit(Config config, DataPacks packs) =>
        EngineRouter.Resolve(config, packs) == 2;

    /// <summary>Contiguous, balanced ranges covering <c>[0, count)</c>; the first few get one extra row.</summary>
    public static IReadOnlyList<(int Start, int End)> Shards(int count, int workers)
    {
        int n = Math.Max(1, Math.Min(workers, Math.Max(1, count)));
        int size = count / n;
        int remainder = count % n;
        var result = new List<(int, int)>(n);
        int start = 0;
        for (int i = 0; i < n; i++)
        {
            int end = start + size + (i < remainder ? 1 : 0);
            result.Add((start, end));
            start = end;
        }

        return result;
    }

    /// <summary>
    /// Render the whole run into <paramref name="target"/> using <paramref name="workers"/> threads.
    /// </summary>
    /// <param name="packsFor">
    /// Builds a fresh <see cref="DataPacks"/> for a worker — see the note about caches above.
    /// </param>
    public static void WriteFile(
        Config config,
        Func<DataPacks> packsFor,
        long nowMillis,
        string? baseDir,
        string target,
        int workers,
        int count,
        Progress? onProgress = null)
    {
        IReadOnlyList<(int Start, int End)> ranges = Shards(count, workers);
        // One slot per worker, so a later report REPLACES that worker's earlier one instead of
        // being added to it. Reporting deltas would lose ground the moment a report went missing.
        // Without any of this a parallel run said nothing until the moment it ended — and above a
        // hundred thousand rows the command line chooses parallel by itself.
        var rendered = new long[ranges.Count];
        string scratch = Directory.CreateDirectory(
            Path.Combine(Path.GetTempPath(), "tdcv2-shards-" + Guid.NewGuid().ToString("N"))).FullName;

        try
        {
            var pieces = new string[ranges.Count];
            var pending = new Task[ranges.Count];
            for (int i = 0; i < ranges.Count; i++)
            {
                (int start, int end) = ranges[i];
                string piece = Path.Combine(scratch, "part-" + i.ToString(
                    System.Globalization.CultureInfo.InvariantCulture));
                pieces[i] = piece;
                int slot = i;
                Progress? perWorker = onProgress is null
                    ? null
                    : (phase, done, unusedTotal) =>
                    {
                        Interlocked.Exchange(ref rendered[slot], done);
                        long sum = 0;
                        for (int k = 0; k < rendered.Length; k++)
                        {
                            sum += Interlocked.Read(ref rendered[k]);
                        }

                        onProgress("render", (int)sum, count);
                    };
                pending[i] = Task.Run(() =>
                {
                    // No BOM and no trailing newline of its own: the pieces are concatenated, so
                    // anything a writer adds on its own account lands in the middle of the output.
                    using var writer = new StreamWriter(
                        piece, append: false, new UTF8Encoding(false), 1 << 16);
                    StreamEngine.RenderRows(
                        config, packsFor(), nowMillis, baseDir, writer, start, end, perWorker);
                });
            }

            try
            {
                Task.WaitAll(pending);
            }
            catch (AggregateException e)
            {
                // A worker's failure is the run's failure; unwrap it so the caller sees the real
                // cause rather than "one or more errors occurred". Every worker builds the same
                // config, so when the config is the problem they all fail identically — reporting
                // one of them then says everything the aggregate would, in a sentence a user can
                // act on. Genuinely different failures keep the aggregate, which is the only
                // honest answer when there is no single cause.
                IReadOnlyList<Exception> causes = e.InnerExceptions
                    .GroupBy(x => (x.GetType(), x.Message))
                    .Select(g => g.First())
                    .ToList();
                throw causes.Count == 1
                    ? causes[0]
                    : new InvalidOperationException("a worker failed", e);
            }

            using var output = new FileStream(
                target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
            foreach (string piece in pieces)
            {
                using FileStream part = File.OpenRead(piece);
                part.CopyTo(output);
            }
        }
        finally
        {
            DeleteTree(scratch);
        }
    }

    private static void DeleteTree(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // A leftover scratch directory in the system temp folder is not worth failing a
            // finished run.
        }
    }
}
