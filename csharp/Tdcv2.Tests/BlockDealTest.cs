using System;
using System.Collections.Generic;
using System.Linq;
using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The block dealer, on its own.
/// </summary>
/// <remarks>
/// A <c>&lt;switch&gt;</c> inside a <c>&lt;uniq&gt;</c> cuts the rows into blocks by its subject,
/// and each block is arranged separately. The free columns are dealt across those blocks first, or
/// one block ends up holding four <c>a</c>s while the next holds none and the group runs out of
/// distinct rows far below its real ceiling. The arrangements below were measured against the
/// reference implementation rather than derived by hand: a deal that is merely valid is a different
/// product for everyone holding a seed.
/// </remarks>
public class BlockDealTest
{
    public static IEnumerable<object[]> Shapes() => new List<object[]>
    {
        new object[]
        {
            new List<string> { "a", "a", "b", "b" }, new List<int> { 2, 2 },
            new List<List<string>>
            {
                new() { "a", "b" },
                new() { "a", "b" },
            },
        },
        new object[]
        {
            new List<string> { "a", "a", "a", "b" }, new List<int> { 2, 2 },
            new List<List<string>>
            {
                new() { "a", "a" },
                new() { "a", "b" },
            },
        },
        new object[]
        {
            new List<string> { "x", "x", "x", "y" }, new List<int> { 1, 3 },
            new List<List<string>>
            {
                new() { "x" },
                new() { "x", "x", "y" },
            },
        },
        new object[]
        {
            new List<string> { "a", "b", "a", "b" }, new List<int> { 4 },
            new List<List<string>> { new() { "a", "a", "b", "b" } },
        },
        new object[]
        {
            new List<string> { "p", "q", "r", "p", "q", "r", "p", "q", "r", "p", "q", "r" },
            new List<int> { 5, 4, 3 },
            new List<List<string>>
            {
                new() { "p", "p", "q", "q", "r" },
                new() { "p", "q", "r", "r" },
                new() { "p", "q", "r" },
            },
        },
        new object[]
        {
            new List<string>(), new List<int> { 0 },
            new List<List<string>> { new() },
        },
        new object[]
        {
            new List<string> { "z", "z", "z" }, new List<int> { 0, 3 },
            new List<List<string>>
            {
                new(),
                new() { "z", "z", "z" },
            },
        },
    };

    [Theory]
    [MemberData(nameof(Shapes))]
    public void TheDealIsTheArrangementTheReferenceMakes(
        List<string> column, List<int> sizes, List<List<string>> want)
    {
        Assert.Equal(want, MemoryEngine.DealAcrossBlocks(column, sizes));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void EveryBlockGetsExactlyTheRowsItHas(
        List<string> column, List<int> sizes, List<List<string>> want)
    {
        _ = want;
        Assert.Equal(sizes, MemoryEngine.DealAcrossBlocks(column, sizes).Select(b => b.Count));
    }

    [Theory]
    [MemberData(nameof(Shapes))]
    public void NothingIsLostAndNothingIsInvented(
        List<string> column, List<int> sizes, List<List<string>> want)
    {
        _ = want;
        Assert.Equal(
            column.OrderBy(v => v, System.StringComparer.Ordinal),
            MemoryEngine.DealAcrossBlocks(column, sizes)
                .SelectMany(b => b)
                .OrderBy(v => v, System.StringComparer.Ordinal));
    }

    /// <summary>
    /// One <c>y</c> against three <c>x</c>s over two blocks: <c>y</c> is owed a quarter of a row in
    /// one and three quarters in the other, and gets a whole one. A value that rounds to nothing
    /// everywhere would otherwise be dropped.
    /// </summary>
    [Fact]
    public void AValueShortOfAWholeShareStillLandsSomewhere()
    {
        Assert.Equal(
            new List<List<string>>
            {
                new() { "x", "x" },
                new() { "x", "y" },
            },
            MemoryEngine.DealAcrossBlocks(
                new List<string> { "x", "x", "x", "y" }, new List<int> { 2, 2 }));
    }

    /// <summary>
    /// Both values are owed half a row in each block; <c>a</c>'s claim on block 0 is walked
    /// first (equal remainders, value order), takes the block's one free slot, and <c>b</c>'s
    /// unit goes to block 1. Assigning per VALUE was tried twice and starved a block both times.
    /// </summary>
    [Fact]
    public void LeftoverUnitsAreHandedOutGloballyStrongestClaimFirst()
    {
        Assert.Equal(
            new List<List<string>>
            {
                new() { "a" },
                new() { "a", "b", "b" },
            },
            MemoryEngine.DealAcrossBlocks(
                new List<string> { "a", "a", "b", "b" }, new List<int> { 1, 3 }));
    }

    /// <summary>
    /// Five values × 5 over blocks [13, 12] — the shape an ODD count cuts. A per-value deal
    /// dumped the fifth value [1, 4] and "count 25" was refused saying "at most 24"; the
    /// global walk lands every value [3, 2] or [2, 3].
    /// </summary>
    [Fact]
    public void UnequalBlocksDoNotStarveTheLastValue()
    {
        var column = new List<string>();
        for (int i = 0; i < 25; i++)
        {
            column.Add("v" + (i % 5));
        }

        List<List<string>> dealt = MemoryEngine.DealAcrossBlocks(column, new List<int> { 13, 12 });
        for (int v = 0; v < 5; v++)
        {
            string value = "v" + v;
            int a = dealt[0].Count(x => x == value);
            int b = dealt[1].Count(x => x == value);
            Assert.Equal(5, a + b);
            Assert.Equal(1, Math.Abs(a - b));
        }
    }
}
