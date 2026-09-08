using System;
using System.Collections.Generic;
using System.Linq;
using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The fingerprint repair against the text repair — same table, or no deal.
/// </summary>
/// <remarks>
/// <para>
/// Engine 3 changes the CARRIER when a run is large: 13-byte hashes routed into piles, each pile
/// sorted as raw bytes, groups sharing a hash treated as candidates. Which rows collide and where
/// they move must not change with the carrier. These cases run the same columns through both paths
/// and compare every row.
/// </para>
/// <para>
/// None of this had a test in this port, and it could not have had one: the carrier switches at a
/// MILLION rows, and no suite renders a million rows. So <c>Repair</c> takes the pile count instead
/// of working it out — the same knob the reference has always had — and these run at a few thousand.
/// </para>
/// <para>
/// The one place the two may legitimately differ is a real 64-bit hash collision, whose odds at
/// these sizes are nil; equality is asserted outright.
/// </para>
/// </remarks>
public class ExactUniqFingerprintTest
{
    /// <summary>A column that cycles through <paramref name="values"/>, holding each for a stride.</summary>
    private static ExactUniq.Resolver Column(IReadOnlyList<string> values, int stride) =>
        row => values[(row / stride) % values.Count];

    private static List<string> Many(int n, string prefix) =>
        Enumerable.Range(0, n).Select(i => prefix + i).ToList();

    private static List<string> RowsOf(
        IReadOnlyDictionary<string, ExactUniq.Resolver> built, IReadOnlyList<string> ids, int count)
    {
        var rows = new List<string>(count);
        for (int row = 0; row < count; row++)
        {
            rows.Add(string.Join("|", ids.Select(id => built[id](row))));
        }

        return rows;
    }

    private static int DuplicateCount(IReadOnlyList<ExactUniq.Resolver> resolvers, int count)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int duplicates = 0;
        for (int row = 0; row < count; row++)
        {
            string key = string.Join(ExactUniq.Join, resolvers.Select(r => r(row)));
            if (!seen.Add(key))
            {
                duplicates++;
            }
        }

        return duplicates;
    }

    /// <summary>One case: a name, a row count, the column ids, and the columns themselves.</summary>
    /// <remarks>
    /// A plain loop rather than a <c>[Theory]</c>, because <c>ExactUniq.Resolver</c> is internal
    /// and a public test parameter cannot name it.
    /// </remarks>
    private sealed record Case(string Name, int Count, string[] Ids, ExactUniq.Resolver[] Columns);

    private static IReadOnlyList<Case> Cases() => new[]
    {
        new Case(
            "a wide column and a narrow one, hundreds of collisions",
            3000,
            new[] { "A", "B" },
            new[] { Column(Many(200, "a"), 1), Column(Many(25, "b"), 11) }),
        new Case(
            "three columns, collisions in quantity",
            2000,
            new[] { "A", "B", "C" },
            new[] { Column(Many(50, "a"), 1), Column(Many(20, "b"), 13), Column(Many(6, "c"), 29) }),
        new Case(
            "two columns drawing from one list",
            1500,
            new[] { "A", "B" },
            new[] { Column(Many(60, "v"), 1), Column(Many(60, "v"), 11) }),
    };

    [Fact]
    public void TheCarrierDoesNotChangeTheAnswer()
    {
        foreach (Case c in Cases())
        {
            string label = "\"" + string.Join(" × ", c.Ids) + "\"";
            Assert.True(
                DuplicateCount(c.Columns, c.Count) > 0,
                $"{c.Name}: nothing to repair, so the case proves nothing");

            List<string> text = RowsOf(
                ExactUniq.Repair(c.Ids, c.Columns, c.Count, label, string.Empty, null),
                c.Ids,
                c.Count);
            Assert.Equal(c.Count, new HashSet<string>(text, StringComparer.Ordinal).Count);

            foreach (int buckets in new[] { 2, 8, 32 })
            {
                List<string> printed = RowsOf(
                    ExactUniq.Repair(
                        c.Ids, c.Columns, c.Count, label, string.Empty, null, null, null, buckets),
                    c.Ids,
                    c.Count);
                Assert.Equal(text, printed);
            }
        }
    }

    [Fact]
    public void AHashCollisionBetweenDifferentTuplesNeverBecomesADuplicate()
    {
        // Pinned directly, because at these sizes a real 64-bit collision does not happen — turn
        // verification off entirely and every comparison above still passes. Only a FORGED
        // candidate group can fail this: rows whose tuples differ, handed over as if their hashes
        // had matched.
        var resolvers = new ExactUniq.Resolver[]
        {
            row => "a" + row, // all distinct
            row => row is 1 or 2 ? "same" : "b" + row,
        };
        Assert.Empty(ExactUniq.VerifyCandidates(resolvers, new List<List<int>> { new() { 5, 6 } }));
        // Rows 1 and 2 share ONLY the second column; the tuples still differ through the first.
        Assert.Empty(
            ExactUniq.VerifyCandidates(resolvers, new List<List<int>> { new() { 1, 2, 9 } }));

        // And a genuine repeat inside a mixed group survives, lowest row spared.
        var twin = new ExactUniq.Resolver[]
        {
            row => row is 3 or 7 ? "x" : "a" + row,
            row => row is 3 or 7 ? "y" : "b" + row,
        };
        Assert.Equal(
            new List<int> { 7 },
            ExactUniq.VerifyCandidates(twin, new List<List<int>> { new() { 3, 7, 12 } }));
    }

    [Fact]
    public void ARunWithNothingToRepairPassesThroughUntouched()
    {
        var columns = new[] { Column(Many(400, "a"), 1), Column(Many(400, "b"), 1) };
        var ids = new[] { "A", "B" };
        IReadOnlyDictionary<string, ExactUniq.Resolver> built = ExactUniq.Repair(
            ids, columns, 400, "\"A × B\"", string.Empty, null, null, null, 8);
        List<string> rows = RowsOf(built, ids, 400);
        Assert.Equal(400, new HashSet<string>(rows, StringComparer.Ordinal).Count);
        // Untouched means untouched: every row still holds what it drew.
        for (int row = 0; row < 400; row++)
        {
            Assert.Equal($"{columns[0](row)}|{columns[1](row)}", rows[row]);
        }
    }
}
