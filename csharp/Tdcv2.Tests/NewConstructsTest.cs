namespace Tdcv2.Tests;

/// <summary>
/// The three constructs this engine learned last: a per-row assertion, a walked list with a
/// repeat, and a <c>&lt;data&gt;</c> inside a <c>&lt;case&gt;</c> that reads its row.
/// </summary>
/// <remarks>
/// The shared fixtures pin what each of them PRODUCES, because that is expressible as output.
/// What only lives here is the half a rendering fixture cannot hold: which row a refusal names,
/// and the equality between two configs — a claim only checked when both are run and compared.
/// </remarks>
public class NewConstructsTest
{
    /// <summary>2026-04-23T12:00:00Z, the fixed instant every implementation shares.</summary>
    private const long Now = 1777032000000L;

    private const string Amount =
        "<sequence name=\"Amount\"><gen type=\"number\" value=\"1..100\"/></sequence>";

    private const string Fee =
        "<sequence name=\"Fee\"><gen type=\"number\" value=\"-3..20\"/></sequence>";

    private const string City =
        "<sequence name=\"City\"><gen type=\"text\" value=\"Alpha,Beta,Gamma\"/></sequence>";

    private static string[] Rows(string env, int count, string line, string mode)
    {
        string config =
            $"<tdc><env count=\"{count}\" seed=\"s\" local=\"en\" mode=\"{mode}\">{env}</env>"
            + $"<block><line><data>{line}</data></line></block></tdc>";
        var tdc = new Tdc(new Tdc.Options { ConfigString = config, NowMillis = Now });
        return tdc.ToString().TrimEnd('\n').Split('\n');
    }

    private static string Refusal(string env, int count, string line, string mode)
    {
        Exception thrown = Assert.ThrowsAny<Exception>(() => Rows(env, count, line, mode));
        return thrown.Message;
    }

    // ── <assert each> ────────────────────────────────────────────────────────

    [Fact]
    public void APerRowAssertionThatHoldsSaysNothing() =>
        Rows(Amount + "<assert each=\"Amount > 0\" says=\"positive\"/>", 200, "${{Amount}}",
            "memory");

    [Fact]
    public void TheConfigTheWholeRunFormRefusesIsTheOneEachAccepts()
    {
        // The `that=` refusal names `each=` as the answer, so the two must not both reject it:
        // the signpost would point nowhere.
        Assert.Contains(
            "is not the same on every row",
            Refusal(Amount + "<assert that=\"Amount > 0\" says=\"positive\"/>", 20, "${{Amount}}",
                "memory"));
        Rows(Amount + "<assert each=\"Amount > 0\" says=\"positive\"/>", 20, "${{Amount}}",
            "memory");
    }

    [Fact]
    public void AFailureNamesTheFirstFailingRowAndTheValue()
    {
        string message = Refusal(
            Fee + "<assert each=\"Fee >= 0\" says=\"a fee is never negative\"/>", 20, "${{Fee}}",
            "memory");
        Assert.Contains("assert failed on row 3: a fee is never negative", message);
        Assert.Contains("Fee >= 0   with Fee = -1", message);
    }

    [Fact]
    public void TheStreamingEngineStopsOnTheSameRow() =>
        // The row loop is shared, and this is the proof. An engine that checked after writing
        // would name a different row.
        Assert.Contains(
            "assert failed on row 3",
            Refusal(Fee + "<assert each=\"Fee >= 0\" says=\"never negative\"/>", 20, "${{Fee}}",
                "disk"));

    [Fact]
    public void EveryPerRowAssertionIsCheckedNotOnlyTheFirst()
    {
        string env = Amount
            + "<assert each=\"Amount > 0\" says=\"positive\"/>"
            + "<assert each=\"Amount > 1000\" says=\"over a thousand\"/>";
        Assert.Contains("over a thousand", Refusal(env, 5, "${{Amount}}", "memory"));
    }

    // ── a walked list with a fixed repeat ────────────────────────────────────

    private static string Walked(string value, string extra) =>
        $"<sequence name=\"V\"><gen type=\"text\" value=\"{value}\" order=\"sequential\"{extra}/>"
        + "</sequence>";

    [Fact]
    public void ARepeatMatchingTheListGivesEveryRowTheWholeList() =>
        Assert.Equal(
            new[]
            {
                "created,paid,shipped,delivered",
                "created,paid,shipped,delivered",
                "created,paid,shipped,delivered",
            },
            Rows(Walked("created,paid,shipped,delivered", " repeat=\"4\""), 3, "${{V}}", "memory"));

    [Fact]
    public void TheWalkCarriesOnAcrossRowsRatherThanRestarting() =>
        // The part a single row cannot show: restarting would print `a,b` three times and pass
        // any test that only looked at row 0.
        Assert.Equal(
            new[] { "a,b", "c,a", "b,c" },
            Rows(Walked("a,b,c", " repeat=\"2\""), 3, "${{V}}", "memory"));

    [Fact]
    public void RepeatOneIsExactlyThePlainWalk()
    {
        // The property that makes carrying on a generalisation rather than a second meaning.
        string[] one = Rows(Walked("a,b,c", " repeat=\"1\""), 6, "${{V}}", "memory");
        Assert.Equal(Rows(Walked("a,b,c", ""), 6, "${{V}}", "memory"), one);
        Assert.Equal(new[] { "a", "b", "c", "a", "b", "c" }, one);
    }

    [Fact]
    public void BothEnginesWalkTheSameWay() =>
        Assert.Equal(
            Rows(Walked("a,b,c", " repeat=\"2\""), 8, "${{V}}", "memory"),
            Rows(Walked("a,b,c", " repeat=\"2\""), 8, "${{V}}", "disk"));

    [Fact]
    public void RunningOutUnderCycleFalseNamesTheElementAsWellAsTheRow() =>
        // The message names a position in the WALK, not a row number that is really an element
        // index — that would send a reader to the wrong attribute.
        Assert.Contains(
            "row 3 runs out at element 2",
            Refusal(Walked("a,b,c,d,e", " repeat=\"2\" cycle=\"false\""), 5, "${{V}}", "memory"));

    // ── ${{Name}} inside a <case> ────────────────────────────────────────────

    [Fact]
    public void ACaseBodyPairsEachRowWithItsOwnValue()
    {
        // A case is built for the SUBSET of rows that chose it, so an implementation reading a
        // position rather than an absolute row pairs the wrong values and still looks plausible.
        string env = City
            + "<mix name=\"S\" percent=\"50\">"
            + "<case><data>${{City}}/north</data></case>"
            + "<case><data>${{City}}/south</data></case></mix>";
        foreach (string row in Rows(env, 12, "${{City}}|${{S}}", "memory"))
        {
            string[] halves = row.Split('|');
            Assert.StartsWith(halves[0] + "/", halves[1], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void TheFiltersALineMayUseWorkHereToo()
    {
        string env = City
            + "<mix name=\"S\" percent=\"0\">"
            + "<case><data>${{City}} plain</data></case>"
            + "<case><data>${{City|upper}} loud</data></case></mix>";
        foreach (string row in Rows(env, 4, "${{S}}", "memory"))
        {
            Assert.EndsWith(" loud", row, StringComparison.Ordinal);
            string head = row.Split(' ')[0];
            Assert.Equal(head.ToUpperInvariant(), head);
        }
    }

    [Fact]
    public void AColumnEmptyOnThisRowRendersEmptyNotMarked()
    {
        // A declared column with no value here is not the same thing as a name nobody declared:
        // printing the marker would read as a broken config rather than as an empty cell.
        string env =
            "<sequence name=\"K\"><gen type=\"text\" value=\"a,b\" percent=\"50,50\"/></sequence>"
            + "<sequence name=\"Only\" parent=\"K.a\"><gen type=\"text\" value=\"X\"/></sequence>"
            + "<mix name=\"S\" percent=\"100\"><case><data>[${{Only}}]</data></case>"
            + "<case><data>never</data></case></mix>";
        string[] rows = Rows(env, 6, "${{S}}", "memory");
        Assert.All(rows, r => Assert.True(r == "[X]" || r == "[]", r));
        Assert.Contains("[]", rows);
    }

    [Fact]
    public void BothEnginesReadACaseBodyTheSameWay()
    {
        string env = City
            + "<mix name=\"S\" percent=\"60\">"
            + "<case><data>${{City}} North</data></case>"
            + "<case><data>${{City|upper}} South</data></case></mix>";
        Assert.Equal(Rows(env, 12, "${{S}}", "memory"), Rows(env, 12, "${{S}}", "disk"));
    }

    [Fact]
    public void PlainTextInACaseIsLeftAlone()
    {
        string env = "<mix name=\"S\" percent=\"100\"><case><data>just text</data></case>"
            + "<case><data>never</data></case></mix>";
        Assert.Equal(new[] { "just text", "just text" }, Rows(env, 2, "${{S}}", "memory"));
    }
}
