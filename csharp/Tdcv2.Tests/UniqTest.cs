using Tdcv2.Sequence;

namespace Tdcv2.Tests;

/// <summary>
/// The claim <c>uniq=</c> rests on: values are rearranged, never replaced.
/// </summary>
/// <remarks>
/// That is what lets uniqueness and an exact <c>percent=</c> share coexist instead of trading
/// against each other. It is also the property a port can break silently — an arranger that quietly
/// substituted a value would still produce unique rows, and the declared share would be wrong by an
/// amount nobody would think to measure.
/// </remarks>
public class UniqTest
{
    [Fact]
    public void EveryColumnKeepsExactlyTheValuesItWasGiven()
    {
        var columns = new IReadOnlyList<string>[]
        {
            new[] { "a", "a", "a", "b", "b", "c" },
            new[] { "x", "x", "y", "y", "z", "z" },
        };

        Uniq.Arrangement arranged = Uniq.Arrange(columns);

        for (int i = 0; i < columns.Length; i++)
        {
            Assert.Equal(
                columns[i].OrderBy(v => v, StringComparer.Ordinal),
                arranged.Columns[i].OrderBy(v => v, StringComparer.Ordinal));
        }
    }

    [Fact]
    public void ArrangesAllSixRowsApartWhenTheValuesAllow()
    {
        var columns = new IReadOnlyList<string>[]
        {
            new[] { "a", "a", "a", "b", "b", "b" },
            new[] { "x", "y", "z", "x", "y", "z" },
        };

        Assert.Equal(6, Uniq.Arrange(columns).Distinct);
    }

    [Fact]
    public void TheUpperBoundNeverUndercounts()
    {
        // The property that makes it safe to refuse a config outright: whatever the arranger can
        // actually reach must not exceed the bound, or a workable config would be rejected.
        IReadOnlyList<string>[][] shapes =
        {
            new IReadOnlyList<string>[]
            {
                new[] { "a", "a", "b", "b" },
                new[] { "x", "x", "y", "y" },
            },
            new IReadOnlyList<string>[]
            {
                new[] { "a", "a", "a", "a" },
                new[] { "x", "y", "z", "w" },
            },
            new IReadOnlyList<string>[]
            {
                new[] { "a", "a", "a", "b", "b", "c" },
                new[] { "x", "x", "x", "y", "y", "z" },
                new[] { "1", "1", "2", "2", "3", "3" },
            },
        };

        foreach (IReadOnlyList<string>[] columns in shapes)
        {
            int bound = Uniq.UpperBound(columns.Select(Uniq.ValueCounts).ToArray());
            Assert.True(Uniq.Arrange(columns).Distinct <= bound);
        }
    }

    [Fact]
    public void OneRepeatedValueCapsEverything()
    {
        // A column of one value can only ever contribute one, so four rows cannot be told apart.
        var columns = new IReadOnlyList<string>[]
        {
            new[] { "a", "a", "a", "a" },
            new[] { "x", "x", "x", "x" },
        };

        Assert.Equal(1, Uniq.UpperBound(columns.Select(Uniq.ValueCounts).ToArray()));
        Assert.Equal(1, Uniq.Arrange(columns).Distinct);
    }

    [Fact]
    public void ValueCountsKeepFirstSeenOrder()
    {
        Assert.Equal(new[] { 2, 3, 1 }, Uniq.ValueCounts(new[] { "b", "a", "b", "a", "a", "c" }));
    }
}
