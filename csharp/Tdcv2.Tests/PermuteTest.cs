using System;
using System.Collections.Generic;
using System.Linq;
using Tdcv2.Prng;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The shuffle you can evaluate at one position without performing it.
/// </summary>
/// <remarks>
/// <para>
/// This is what lets a run give exact percentages with no array to shuffle — "the lottery without
/// a drum". A bijection over <c>[0, n)</c> sends exactly the first <c>q</c> indices' worth of rows
/// into the first <c>q</c> slots, so a sorted quota plan comes out byte-exact, and row nine
/// million can be answered without building the eight million before it.
/// </para>
/// <para>
/// TypeScript, Python, Rust and Java each had a test for this; this implementation had none, and
/// <see cref="Permute.Unapply"/> — the inverse, and its whole round loop — had never executed. A
/// bijection that is not a bijection, or an inverse that does not invert, moves every value in
/// every column, so this is the last place in the project worth leaving unmeasured.
/// </para>
/// </remarks>
public class PermuteTest
{
    private static readonly int Key = Permute.Key("seed-1", "field-a");

    /// <summary>Non-powers-of-two and primes included: the padding is where a bijection breaks.</summary>
    private static readonly int[] Sizes = { 1, 2, 3, 7, 16, 100, 255, 256, 997, 1000, 4096, 12345 };

    [Fact]
    public void IsABijectionOverTheWholeRange()
    {
        foreach (int n in Sizes)
        {
            var seen = new HashSet<int>();
            for (int i = 0; i < n; i++)
            {
                int slot = Permute.Apply(i, n, Key);
                Assert.InRange(slot, 0, n - 1);
                seen.Add(slot);
            }

            Assert.Equal(n, seen.Count); // every slot hit exactly once
        }
    }

    [Fact]
    public void IsDeterministic()
    {
        for (int i = 0; i < 200; i++)
        {
            Assert.Equal(Permute.Apply(i, 1000, Key), Permute.Apply(i, 1000, Key));
        }
    }

    /// <summary>The inverse really inverts — the half that had never run.</summary>
    [Fact]
    public void UnapplyInvertsApply()
    {
        foreach (int n in new[] { 1, 2, 7, 100, 997, 4096 })
        {
            int key = Permute.Key("s", $"n{n}");
            for (int i = 0; i < n; i++)
            {
                Assert.Equal(i, Permute.Unapply(Permute.Apply(i, n, key), n, key));
            }
        }
    }

    /// <summary>And it is a bijection in its own right, not just a left inverse.</summary>
    [Fact]
    public void UnapplyIsItselfABijection()
    {
        foreach (int n in new[] { 3, 100, 997 })
        {
            int key = Permute.Key("s", $"u{n}");
            var seen = new HashSet<int>();
            for (int slot = 0; slot < n; slot++)
            {
                int row = Permute.Unapply(slot, n, key);
                Assert.InRange(row, 0, n - 1);
                seen.Add(row);
            }

            Assert.Equal(n, seen.Count);
        }
    }

    [Fact]
    public void DifferentKeysGiveDifferentOrderings()
    {
        int k1 = Permute.Key("s", "x");
        int k2 = Permute.Key("s", "y");
        int differ = Enumerable.Range(0, 1000)
            .Count(i => Permute.Apply(i, 1000, k1) != Permute.Apply(i, 1000, k2));
        Assert.True(differ > 900, $"only {differ} of 1000 positions moved");
    }

    private static int[] Distribute(int n, int[] quotas, int key)
    {
        var cumulative = new int[quotas.Length];
        int acc = 0;
        for (int c = 0; c < quotas.Length; c++)
        {
            acc += quotas[c];
            cumulative[c] = acc;
        }

        var counts = new int[quotas.Length];
        for (int i = 0; i < n; i++)
        {
            int slot = Permute.Apply(i, n, key);
            int category = Array.FindIndex(cumulative, hi => slot < hi);
            counts[category < 0 ? quotas.Length - 1 : category]++;
        }

        return counts;
    }

    /// <summary>
    /// The property the whole design exists for: exact shares, from a bijection, with no array.
    /// </summary>
    [Fact]
    public void QuotasComeOutExact()
    {
        Assert.Equal(new[] { 700, 300 }, Distribute(1000, new[] { 700, 300 }, Permute.Key("s", "g1")));
        Assert.Equal(
            new[] { 500, 300, 200 },
            Distribute(1000, new[] { 500, 300, 200 }, Permute.Key("s", "g2")));
        // A prime count is where an off-by-one in the padding would show.
        Assert.Equal(
            new[] { 500, 300, 197 },
            Distribute(997, new[] { 500, 300, 197 }, Permute.Key("s", "g3")));
        // And it holds for any key, not the one that happened to be written down.
        for (int t = 0; t < 10; t++)
        {
            Assert.Equal(
                new[] { 800, 434 },
                Distribute(1234, new[] { 800, 434 }, Permute.Key("s", $"k{t}")));
        }
    }

    /// <summary>A run of one has one answer, and the inverse agrees.</summary>
    [Fact]
    public void ASingleRow()
    {
        Assert.Equal(0, Permute.Apply(0, 1, Key));
        Assert.Equal(0, Permute.Unapply(0, 1, Key));
    }
}
