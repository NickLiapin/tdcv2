using Tdcv2.Errors;

namespace Tdcv2.Tests;

/// <summary>
/// The public surface: what a caller actually touches.
/// </summary>
/// <remarks>
/// The contract worth testing here is not that values are right — the shared cases prove that. It is
/// that the two views agree, that asking twice gives the same answer, and that a sequence with no
/// value on a row says so instead of returning a blank that reads as a real one.
/// </remarks>
public class TdcTest
{
    private const string People =
        "<tdc><env count=\"6\" seed=\"facade\" local=\"en\" mode=\"memory\">"
        + "<sequence name=\"Gender\"><gen type=\"text\" value=\"Male, Female\" percent=\"50,50\"/></sequence>"
        + "<sequence name=\"Beard\" parent=\"Gender.Male\">"
        + "<gen type=\"text\" value=\"yes, no\"/></sequence>"
        + "<sequence name=\"Address\"><gen name=\"city\" type=\"text\" value=\"Berlin, Munich\"/>"
        + "<gen name=\"zip\" type=\"number\" value=\"10000..99999\"/></sequence>"
        + "</env><block><line><data>${{Gender}}</data></line></block></tdc>";

    /// <summary>The same run without <c>mode="memory"</c>, so the router sends it to engine 2.</summary>
    private const string Streamable =
        "<tdc><env count=\"6\" seed=\"facade\" local=\"en\">"
        + "<sequence name=\"N\"><gen type=\"number\" value=\"1..999\"/></sequence>"
        + "<sequence name=\"W\"><gen type=\"regex\" value=\"[a-z]{5}\"/></sequence>"
        + "</env><block><line><data>${{N}},${{W}}</data></line></block></tdc>";

    private static Tdc Build(string config) =>
        new(new Tdc.Options { ConfigString = config });

    [Fact]
    public void TextAndRowsReadTheSameGeneratedValues()
    {
        Tdc data = Build(People);

        string[] lines = data.ToString().TrimEnd('\n').Split('\n');
        Assert.Equal(6, lines.Length);
        Assert.Equal(lines, data.Rows().Select(r => r["Gender"]));
    }

    [Fact]
    public void AskingTwiceGivesTheSameRun()
    {
        Tdc data = Build(People);
        Assert.Equal(data.ToString(), data.ToString());
        // And rows do not re-run the generator either — that would be both slow and, with a
        // generated seed, a different answer.
        Assert.Equal(data.Rows().First()["Gender"], data[0]["Gender"]);
    }

    [Fact]
    public void ASequenceThatDoesNotApplyToARowReturnsNullNotBlank()
    {
        Tdc data = Build(People);

        // parent="Gender.Male" has no value on a female row. An empty string would claim it had
        // one that happened to be blank, which a caller cannot tell from a real empty value.
        foreach (Tdc.Row row in data.Rows())
        {
            if (row["Gender"] == "Female")
            {
                Assert.Null(row["Beard"]);
                Assert.DoesNotContain("Beard", row.ToDictionary().Keys);
            }
            else
            {
                Assert.NotNull(row["Beard"]);
            }
        }
    }

    [Fact]
    public void ACompoundReadsAsOneThingWithParts()
    {
        Tdc.Row row = Build(People)[0];

        // Flat, the caller has to notice the shared prefix.
        Assert.Equal(row["Address.city"], ((IReadOnlyDictionary<string, string>)row.Nested()["Address"])["city"]);
        Assert.Contains("Address.zip", row.ToDictionary().Keys);
        Assert.DoesNotContain("Address", row.ToDictionary().Keys);
    }

    [Fact]
    public void TheSeedSaysWhetherTheRunIsReproducible()
    {
        Assert.Equal(new Tdc.Seed("facade", false), Build(People).SeedInfo);

        Tdc unseeded = Build(Unseeded);
        Assert.True(unseeded.SeedInfo.Generated);

        // A generated seed has to BE a seed: an empty one makes the advice to re-run with it
        // reproduce nothing.
        Assert.NotEqual("", unseeded.SeedInfo.Value);
    }

    private const string Unseeded =
        "<tdc><env count=\"8\" mode=\"memory\"><sequence name=\"N\">"
        + "<gen type=\"number\" value=\"1..999999\"/></sequence></env>"
        + "<block><line><data>${{N}}</data></line></block></tdc>";

    [Fact]
    public void ARunThatNamesNoSeedGetsAFreshOneAndSaysWhatItWas()
    {
        // A seedless run is a fresh sample every time, as it is in the reference.
        Tdc first = Build(Unseeded);
        Tdc second = Build(Unseeded);
        Assert.NotEqual(first.SeedInfo.Value, second.SeedInfo.Value);
        Assert.NotEqual(first.ToString(), second.ToString());

        // And the reported seed is the way back to it — the only reason to report it.
        var replayed = new Tdc(
            new Tdc.Options { ConfigString = Unseeded, SeedValue = first.SeedInfo.Value });
        Assert.Equal(first.ToString(), replayed.ToString());
        Assert.False(replayed.SeedInfo.Generated);
    }

    [Fact]
    public void CodeOverridesWhatTheConfigDeclared()
    {
        // A test that pins the count needs that value to hold even when the config it borrowed
        // carries one of its own — otherwise the override would be advice rather than a setting.
        var data = new Tdc(new Tdc.Options { ConfigString = People, Count = 2, SeedValue = "other" });
        Assert.Equal(2, data.Count);
        Assert.Equal(2, data.Rows().Count());
        Assert.Equal("other", data.SeedInfo.Value);
    }

    [Fact]
    public void ARowOutsideTheRunIsRefusedRatherThanWrappedOrEmpty()
    {
        Tdc data = Build(People);
        Assert.Throws<ArgumentOutOfRangeException>(() => data[6]);
        Assert.Throws<ArgumentOutOfRangeException>(() => data[-1]);
    }

    [Fact]
    public void NeitherBothNorNeitherSourceIsAccepted()
    {
        Assert.Throws<ArgumentException>(() => new Tdc(new Tdc.Options()));
        Assert.Throws<ArgumentException>(
            () => new Tdc(new Tdc.Options { ConfigString = People, ConfigFile = "x.tdc" }));
    }

    [Fact]
    public void WriteFileProducesExactlyWhatToStringDoes()
    {
        Tdc data = Build(People);
        string target = Path.Combine(Path.GetTempPath(), "tdcv2-facade-" + Guid.NewGuid().ToString("N"));
        try
        {
            data.WriteFile(target);
            Assert.Equal(data.ToString(), File.ReadAllText(target));
        }
        finally
        {
            File.Delete(target);
        }
    }

    [Fact]
    public void SplittingTheWriteAcrossThreadsChangesNothingButTheClock()
    {
        // The worker count is safe to pick from the hardware only because it cannot change the
        // bytes: a shard is a range of rows, and every row is a function of its own number.
        Tdc data = Build(Streamable);
        string one = Path.Combine(Path.GetTempPath(), "tdcv2-one-" + Guid.NewGuid().ToString("N"));
        string many = Path.Combine(Path.GetTempPath(), "tdcv2-many-" + Guid.NewGuid().ToString("N"));
        try
        {
            data.WriteFile(one, 1);
            data.WriteFile(many, 4);
            Assert.Equal(File.ReadAllText(one), File.ReadAllText(many));
            Assert.Equal(data.ToString(), File.ReadAllText(many));
        }
        finally
        {
            File.Delete(one);
            File.Delete(many);
        }
    }

    [Fact]
    public void AnEngineNamedByTheCallerBeatsWhateverTheConfigDeclared()
    {
        Assert.Equal(2, Build(Streamable).Engine);
        Assert.Equal(1, new Tdc(new Tdc.Options { ConfigString = Streamable, Engine = 1 }).Engine);

        // A mode is a constraint rather than a choice, and it too outranks <env> — a flag typed on
        // this run is a more recent statement of intent than a line in the file.
        Assert.Equal(1, new Tdc(new Tdc.Options { ConfigString = People }).Engine);
        Assert.Equal(
            2, new Tdc(new Tdc.Options { ConfigString = People, Mode = "disk" }).Engine);
    }

    [Fact]
    public void ARunThatCannotFitIsRefusedBeforeItStarts()
    {
        // Held in memory, a billion records need hundreds of gigabytes on any machine this will
        // ever run on, so the answer does not depend on the one running the test.
        Diagnostic? refused = new Tdc(new Tdc.Options
        {
            ConfigString = People.Replace("count=\"6\"", "count=\"1000000000\""),
        }).Preflight();
        Assert.NotNull(refused);
        Assert.Equal("TDC201", refused!.Code);
        Assert.Equal(Severity.Error, refused.Severity);

        // Six records, and a streaming engine holding one row at a time, are both silent.
        Assert.Null(Build(People).Preflight());
        Assert.Null(
            new Tdc(new Tdc.Options
            {
                ConfigString = Streamable.Replace("count=\"6\"", "count=\"1000000000\""),
            }).Preflight());
    }

    [Fact]
    public void TheClockIsAParameterSoADateTestDoesNotExpireOvernight()
    {
        var data = new Tdc(new Tdc.Options
        {
            ConfigString =
                "<tdc><env count=\"2\" seed=\"s\" local=\"en\" mode=\"memory\"><sequence name=\"D\">"
                + "<gen type=\"date\" value=\"today\" format=\"ISO\"/></sequence></env>"
                + "<block><line><data>${{D}}</data></line></block></tdc>",
            NowMillis = DateTimeOffset.Parse("2026-04-23T12:00:00Z").ToUnixTimeMilliseconds(),
        });

        Assert.Equal("2026-04-23\n2026-04-23\n", data.ToString());
    }
}
