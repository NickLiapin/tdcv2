using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The fingerprint layer against the shared cross-language vectors.
/// </summary>
/// <remarks>
/// Every number in that fixture decides WHICH tuples a large uniq run avoids, so an implementation
/// that differs in any of them produces a different file from the same seed. Hash, pile, record
/// bytes and pile count are each pinned here rather than trusted.
/// </remarks>
public class FingerprintVectorsTest
{
    private static readonly Lazy<JsonDocument> Vectors = new(() =>
        JsonDocument.Parse(File.ReadAllText(
            Path.Combine(PrngVectorsTest.FixturesDir(), "fingerprint-vectors.json"))));

    [Fact]
    public void RecordWidthAndIndexLimitMatchTheContract()
    {
        JsonElement root = Vectors.Value.RootElement;
        Assert.Equal(root.GetProperty("recordBytes").GetInt32(), Fingerprint.RecordBytes);
        Assert.Equal(root.GetProperty("maxIndex").GetInt64(), Fingerprint.MaxIndex);
    }

    [Fact]
    public void HashAndPileMatchTheReference()
    {
        foreach (JsonElement vector in Vectors.Value.RootElement.GetProperty("hashes").EnumerateArray())
        {
            string key = vector.GetProperty("key").GetString()!;
            (int hi, int lo) = Fingerprint.Hash64(key);
            Assert.Equal(vector.GetProperty("hi").GetInt64(), (uint)hi);
            Assert.Equal(vector.GetProperty("lo").GetInt64(), (uint)lo);

            foreach (JsonProperty pile in vector.GetProperty("buckets").EnumerateObject())
            {
                Assert.Equal(
                    pile.Value.GetInt32(),
                    Fingerprint.BucketOf(hi, int.Parse(pile.Name)));
            }
        }
    }

    [Fact]
    public void RecordBytesMatchTheReferenceAndReadBackAsWritten()
    {
        foreach (JsonElement vector in Vectors.Value.RootElement.GetProperty("records").EnumerateArray())
        {
            int hi = unchecked((int)vector.GetProperty("hi").GetInt64());
            int lo = unchecked((int)vector.GetProperty("lo").GetInt64());
            long index = vector.GetProperty("index").GetInt64();

            byte[] encoded = Fingerprint.Encode(hi, lo, index);
            Assert.Equal(vector.GetProperty("bytes").GetString(), Convert.ToHexString(encoded).ToLowerInvariant());
            // A reader that disagrees with its own writer is worse than one that disagrees with
            // the reference, because nothing would catch it.
            Assert.Equal(index, Fingerprint.IndexOf(encoded));
        }
    }

    [Fact]
    public void AnIndexPastTheLimitIsRefusedNotWrapped()
    {
        var e = Assert.Throws<ArgumentOutOfRangeException>(
            () => Fingerprint.Encode(1, 1, Fingerprint.MaxIndex));
        Assert.Contains("5-byte", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PileCountMatchesTheReference()
    {
        foreach (JsonElement vector in Vectors.Value.RootElement.GetProperty("pileCounts").EnumerateArray())
        {
            Assert.Equal(
                vector.GetProperty("buckets").GetInt32(),
                Fingerprint.BucketCountFor(
                    vector.GetProperty("count").GetInt64(),
                    vector.GetProperty("cores").GetInt32()));
        }
    }

    [Fact]
    public void SortingIsByteOrderAndEveryRepeatedFingerprintIsFound()
    {
        string dir = Path.Combine(Path.GetTempPath(), "tdc-fp-test-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var inputs = new List<string>();
            var writers = new List<Fingerprint.Writer>();
            for (int k = 0; k < 3; k++)
            {
                string path = Path.Combine(dir, $"in-{k}");
                inputs.Add(path);
                writers.Add(new Fingerprint.Writer(path));
            }

            for (int i = 0; i < 300; i++)
            {
                (int hi, int lo) = Fingerprint.Hash64($"unique-{i}");
                writers[i % 3].Write(hi, lo, i);
            }

            (int aHi, int aLo) = Fingerprint.Hash64("dupA");
            foreach (long row in new long[] { 7, 105, 203 })
            {
                writers[0].Write(aHi, aLo, row);
            }

            (int bHi, int bLo) = Fingerprint.Hash64("dupB");
            foreach (long row in new long[] { 50, 151 })
            {
                writers[1].Write(bHi, bLo, row);
            }

            // Same high word, differing low words, written descending: an order that only comes out
            // right if the low word decides. 305 random hashes never collide in 32 bits, so without
            // these the sort could ignore the low word and still pass.
            for (int lo = 9; lo >= 0; lo--)
            {
                writers[0].Write(777, lo, 400 + lo);
            }

            foreach (Fingerprint.Writer writer in writers)
            {
                writer.Dispose();
            }

            string sorted = Path.Combine(dir, "sorted");
            Assert.Equal(315, Fingerprint.SortFiles(inputs, sorted, dir));

            byte[] all = File.ReadAllBytes(sorted);
            Assert.Equal(315 * Fingerprint.RecordBytes, all.Length);
            for (int at = Fingerprint.RecordBytes; at < all.Length; at += Fingerprint.RecordBytes)
            {
                byte[] prev = all[(at - Fingerprint.RecordBytes)..at];
                byte[] here = all[at..(at + Fingerprint.RecordBytes)];
                Assert.True(Fingerprint.CompareRecords(prev, here) <= 0, $"not in byte order at {at}");
            }

            List<List<int>> groups = Fingerprint.CandidateGroups(sorted);
            Assert.Equal(2, groups.Count);
            foreach (List<int> group in groups)
            {
                group.Sort();
            }

            Assert.Contains(groups, g => g.Count == 3 && g[0] == 7 && g[1] == 105 && g[2] == 203);
            Assert.Contains(groups, g => g.Count == 2 && g[0] == 50 && g[1] == 151);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void TheLedgerNeverCallsATakenTupleFree()
    {
        string dir = Path.Combine(Path.GetTempPath(), "tdc-fp-ledger-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            const int buckets = 4;
            var keys = new List<string>();
            for (int i = 0; i < 500; i++)
            {
                keys.Add($"taken-{i}");
            }

            var raw = new List<Fingerprint.Writer>();
            for (int b = 0; b < buckets; b++)
            {
                raw.Add(new Fingerprint.Writer(Path.Combine(dir, $"raw-{b}")));
            }

            for (int row = 0; row < keys.Count; row++)
            {
                (int hi, int lo) = Fingerprint.Hash64(keys[row]);
                raw[Fingerprint.BucketOf(hi, buckets)].Write(hi, lo, row);
            }

            foreach (Fingerprint.Writer writer in raw)
            {
                writer.Dispose();
            }

            var sortedPaths = new List<string>();
            for (int b = 0; b < buckets; b++)
            {
                string outPath = Path.Combine(dir, $"sorted-{b}");
                Fingerprint.SortFiles(new[] { Path.Combine(dir, $"raw-{b}") }, outPath, dir);
                sortedPaths.Add(outPath);
            }

            var moving = new HashSet<int> { 3, 4 };
            using var ledger = new Fingerprint.Ledger(sortedPaths, moving);

            // The property uniqueness rests on: every taken tuple answers taken.
            for (int row = 0; row < keys.Count; row++)
            {
                if (!moving.Contains(row))
                {
                    Assert.True(ledger.Has(keys[row]), keys[row]);
                }
            }

            // A tuple held ONLY by rows being moved is free — those values are being given away.
            Assert.False(ledger.Has("taken-3"));
            Assert.False(ledger.Has("taken-4"));

            // And tuples nobody holds are free.
            for (int i = 0; i < 200; i++)
            {
                Assert.False(ledger.Has($"nobody-{i}"));
            }
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
