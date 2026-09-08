using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// Sorting more records than fit in memory.
/// </summary>
/// <remarks>
/// <para>
/// The exact engine asks one question of this — are any two records identical — and answers it by
/// putting equal records next to each other. Get the merge wrong and the answer is wrong:
/// duplicates that never meet are duplicates that ship.
/// </para>
/// <para>
/// The disk half had never run here. An input that fits in one chunk is sorted in memory and never
/// touches a file, and everything this suite sorted was that size, so the run files, the k-way
/// merge and the cleanup were dead to the tests while being exactly what a large run uses.
/// TypeScript and Java each had a test for it; this implementation, Python and Rust had none.
/// <c>chunkSize</c> is the seam: production leaves it at a million records, and these pass a
/// handful.
/// </para>
/// </remarks>
public class ExternalSortTest : IDisposable
{
    private readonly string _dir = Directory.CreateDirectory(
        Path.Combine(Path.GetTempPath(), "tdc-esort-test-" + Guid.NewGuid().ToString("N")[..8]))
        .FullName;

    public void Dispose()
    {
        Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }

    private List<string> Sorted(IEnumerable<string> records, int chunk) =>
        ExternalSort.Sort(records, chunk, _dir).ToList();

    [Fact]
    public void SpansManyRunsAndLosesNothing()
    {
        // 500 records, chunk of 7 → about 72 runs merged. Forces the disk path.
        List<string> records = Enumerable.Range(0, 500)
            .Select(i => (((i * 137) + 11) % 500).ToString())
            .ToList();
        List<string> got = Sorted(records, 7);
        List<string> want = records.OrderBy(r => r, StringComparer.Ordinal).ToList();
        Assert.Equal(want, got);
        Assert.Equal(records.Count, got.Count);
    }

    /// <summary>
    /// The whole point: equal records end up adjacent, and none is dropped on the way. Two equal
    /// lines coming from DIFFERENT runs is the case a tie-break can silently swallow.
    /// </summary>
    [Fact]
    public void KeepsDuplicatesSoTheScanCanFindThem()
    {
        Assert.Equal(
            new[] { "a", "a", "a", "b", "b", "c" },
            Sorted(new[] { "b", "a", "b", "c", "a", "a" }, 2));
    }

    [Fact]
    public void TheInMemoryPathWhenItAllFits() =>
        Assert.Equal(new[] { "1", "2", "3" }, Sorted(new[] { "3", "1", "2" }, 1000));

    [Fact]
    public void EmptyInput() => Assert.Empty(Sorted(Array.Empty<string>(), 4));

    [Fact]
    public void ChunkSizeCannotChangeTheAnswer()
    {
        List<string> records = Enumerable.Range(0, 200)
            .Select(i => ((i * 977) % 251).ToString())
            .ToList();
        List<string> once = Sorted(records, 5);
        foreach (int chunk in new[] { 5, 50, 100000 })
        {
            Assert.Equal(once, Sorted(records, chunk));
        }
    }

    /// <summary>
    /// The keys are opaque and only equality of neighbours matters, so this sorts as text.
    /// "100" before "2" is correct, and a culture-aware comparison would be slower and
    /// machine-dependent.
    /// </summary>
    [Fact]
    public void ByteOrderNotNumberOrder() =>
        Assert.Equal(
            new[] { "10", "100", "2", "30", "9" },
            Sorted(new[] { "10", "9", "100", "2", "30" }, 2));

    [Fact]
    public void TheTempFilesAreGoneWhenTheScanEnds()
    {
        List<string> records = Enumerable.Range(0, 60).Select(i => i.ToString()).ToList();
        List<string> got = Sorted(records, 4);
        Assert.Equal(records.OrderBy(r => r, StringComparer.Ordinal).ToList(), got);
        // A long run sorts many times; a leaked run directory each time fills the disk.
        Assert.Empty(Directory.GetFileSystemEntries(_dir));
    }
}
