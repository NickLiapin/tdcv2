using Tdcv2.Model;
using Tdcv2.Packs;

namespace Tdcv2.Engine;

/// <summary>
/// The way in: pick the engine a config belongs to, and run it.
/// </summary>
/// <remarks>
/// <para>
/// Routing lives here rather than inside one of the engines because it belongs to neither. The
/// engines draw in different orders, so the same seed lands on different values — that is documented
/// behaviour, not a defect. Which makes the choice part of the contract: running a config on engine 1
/// when the reference would have used engine 2 produces output that is wrong in every row while
/// looking perfectly plausible.
/// </para>
/// <para>
/// Packs are resolved before the router is asked, because some of its rules read one to decide.
/// </para>
/// </remarks>
public static class Engines
{
    /// <summary>The run, as something a caller can read rows and text out of.</summary>
    public static IRowSource Run(
        Config config, DataPacks? packs, long? nowMillis = null, string? baseDir = null)
    {
        DataPacks resolved = packs ?? DataPacks.Discover();
        long now = nowMillis ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        int engine = EngineRouter.Resolve(config, resolved);
        if (engine == 1)
        {
            return MemoryEngine.Run(config, resolved, now, baseDir);
        }

        if (engine == 3)
        {
            // Engine 3 falls back on its own, so a config it cannot do exactly still renders.
            return DiskEngine.Rows(config, resolved, now, baseDir);
        }

        try
        {
            return StreamEngine.Rows(config, resolved, now, baseDir);
        }
        catch (StreamEngine.UnsupportedHere) when (!EngineRouter.Forced(config))
        {
            // The router sent this config here from its shape, and the engine turned out to need
            // the whole column after all. Nothing asked for streaming, so nothing is owed a
            // refusal: the in-memory engine answers it, at the cost of the memory profile. A
            // forced engine is excluded above and still throws, which is the point of forcing one.
            return MemoryEngine.Run(config, resolved, now, baseDir);
        }
    }

    /// <summary>The whole output as one string.</summary>
    public static string Render(
        Config config, DataPacks? packs = null, long? nowMillis = null, string? baseDir = null) =>
        Run(config, packs, nowMillis, baseDir).Text();
}
