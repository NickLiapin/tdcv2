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
/// </remarks>
public static class DiskEngine
{
    /// <summary>The run as addressable records, exact and bounded — or in memory when it cannot be both.</summary>
    public static IRowSource Rows(
        Config config, DataPacks packs, long nowMillis, string? baseDir,
        Progress? onProgress = null)
    {
        try
        {
            return StreamEngine.Rows(config, packs, nowMillis, baseDir, true, onProgress);
        }
        catch (Exception e) when (e is StreamEngine.UnsupportedHere or ExactUniq.RepairNeeded)
        {
            return MemoryEngine.Run(config, packs, nowMillis, baseDir, onProgress);
        }
    }
}
