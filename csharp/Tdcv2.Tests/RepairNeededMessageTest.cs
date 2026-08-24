using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The refusal a too-tight <c>&lt;uniq&gt;</c> gets, worded the same in all five implementations.
/// </summary>
public class RepairNeededMessageTest
{
    private static string Sentence(string rows) =>
        "uniq \"A × B\" is too tight to repair without holding the whole table ("
        + rows
        + " couldn't be placed) — run without mode=\"stream\" so the in-memory engine "
        + "can arrange it.";

    /// <summary>
    /// The scan stops as soon as it is past the cap, because nothing it could find afterwards
    /// changes the answer — measured on a config that misses the cap by two orders of magnitude
    /// (1,618,803 rows against 20,000), finishing the count took 6.79 s against 0.08 s to stop.
    /// What it gives up is the exact figure, so the sentence stops claiming one.
    /// </summary>
    [Fact]
    public void AFloorIsNamedAsAFloor()
    {
        Assert.Equal(
            Sentence("more than 20000 rows"),
            new ExactUniq.RepairNeeded(20_000, "\"A × B\"", true).Message);
    }

    [Fact]
    public void AnExactCountIsNamedExactly()
    {
        Assert.Equal(Sentence("1 row(s)"), new ExactUniq.RepairNeeded(1, "\"A × B\"").Message);
    }
}
