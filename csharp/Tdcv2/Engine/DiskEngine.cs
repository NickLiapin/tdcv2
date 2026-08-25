using Tdcv2.Model;
using Tdcv2.Packs;

namespace Tdcv2.Engine;

/// <summary>
/// Engine 3: everything the in-memory engine does, for runs that do not fit in memory.
/// </summary>
/// <remarks>
/// <para>
/// It is not a third implementation. It is the streaming engine with one setting changed — a
/// <c>uniq</c> sequence is built to its exact shares and then verified on disk, instead of being
/// given uniform combinations — and a fallback for the configs that setting cannot satisfy.
/// </para>
/// <para>
/// The fallback is the honest part. A config that turns out to need the whole column, or a
/// uniqueness constraint so tight the bounded repair cannot place every row, goes to the in-memory
/// engine and produces correct data at the cost of the memory profile. Which is the right trade: an
/// engine chosen for its memory behaviour must not answer differently from the one that was not.
/// </para>
/// <para>
/// Two things it must NOT do, and both used to happen here. It must not fall back for a caller
/// that NAMED this engine: <c>engine="3"</c> and <c>--engine 3</c> say WHICH engine to run, so
/// quietly running another hides exactly what the author asked to be told — the rule the streaming
/// engine has followed all along. Measured before the fix: a tight <c>&lt;uniq&gt;</c> under
/// <c>--engine 3</c> produced byte-identical output to <c>--engine 1</c>, so anyone benchmarking
/// engine 3 on a tight config was benchmarking engine 1. And it must not fall back past what the
/// in-memory engine can hold, where the fallback does not fail fast — it fails after half an hour
/// of materialising, out of memory, with nothing written.
/// </para>
/// </remarks>
public static class DiskEngine
{
    /// <summary>The run as addressable records, exact and bounded — or in memory when it cannot be both.</summary>
    /// <param name="named">
    /// Whether the caller asked for this engine BY NAME rather than describing a constraint.
    /// </param>
    public static IRowSource Rows(
        Config config, DataPacks packs, long nowMillis, string? baseDir,
        Progress? onProgress = null, bool named = false)
    {
        try
        {
            return StreamEngine.Rows(config, packs, nowMillis, baseDir, true, onProgress);
        }
        catch (Exception e) when (e is StreamEngine.UnsupportedHere or ExactUniq.RepairNeeded)
        {
            RefuseIfItMust(e, config.Count, named && e is ExactUniq.RepairNeeded);
            return MemoryEngine.Run(config, packs, nowMillis, baseDir, onProgress);
        }
    }

    /// <summary>
    /// Raise instead of falling back, in the two cases where falling back is the wrong answer.
    /// </summary>
    /// <remarks>
    /// <paramref name="named"/> here means "named AND stopped by the repair cap". A shape the lazy
    /// path cannot express at all — a weighted pack generator, say — means engine 3 never got to
    /// run the config, and covering that is what engine 3 IS. The cap is the other case: engine 3
    /// DID run this config, got most of the way, and gave up on a memory budget — the very
    /// property the caller named this engine to get.
    /// </remarks>
    private static void RefuseIfItMust(Exception error, int count, bool named)
    {
        // The refusals share a first half — up to the em dash — and differ in the advice after it.
        string said = error.Message.Split(" — ", 2)[0];
        if (count > ExactUniq.InMemoryFallbackMaxRows)
        {
            throw new InvalidOperationException(
                $"{said} — and at {count} rows the in-memory engine cannot take over. Widen the "
                    + "uniq columns' values (more distinct names, wider ranges…) or lower the "
                    + "count.");
        }

        if (named)
        {
            throw new InvalidOperationException(
                $"{said} — and engine 3 was asked for by name, so it refuses rather than quietly "
                    + "running another engine. Remove the engine choice to let a uniq this tight "
                    + "go to the in-memory engine, which is what has been happening here all "
                    + "along.");
        }
    }
}
