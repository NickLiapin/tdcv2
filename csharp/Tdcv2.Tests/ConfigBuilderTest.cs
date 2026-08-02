using Tdcv2.Model;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// The tree turned into the model the engine reads.
/// </summary>
/// <remarks>
/// The shapes checked here are the ones a sequence can take, and they are checked because getting
/// them wrong is quiet: a compound mistaken for a plain gen still renders something, just not the
/// thing that was asked for. The golden fixtures are built too — parsing them was proved earlier,
/// and this asks the harder question of whether the tree means the same thing here as elsewhere.
/// </remarks>
public class ConfigBuilderTest
{
    private static Config Build(string source)
    {
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(source);
        Assert.True(parsed.Ok, string.Join("; ", parsed.Problems.Select(p => p.ToString())));
        return ConfigBuilder.Build(parsed.Tree);
    }

    [Fact]
    public void ReadsEnvAndDefaults()
    {
        Config config = Build(
            "<tdc><env count=\"7\" seed=\"s\" local=\"ru\"><sequence name=\"A\">"
            + "<gen type=\"text\" value=\"x\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>");

        Assert.Equal(7, config.Count);
        Assert.Equal("s", config.Seed);
        Assert.Equal("ru", config.Locale);
        Assert.Equal("${{%}}", config.Inject);
        Assert.Equal(32, config.RegexMaxLength);
        Assert.Single(config.Sequences);
        Assert.Single(config.Block);
    }

    [Fact]
    public void ADefaultedEnvStillHasACountAndALocale()
    {
        Config config = Build(
            "<tdc><env><sequence name=\"A\"><gen type=\"text\" value=\"x\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>");
        Assert.Equal(10, config.Count);
        Assert.Equal("en", config.Locale);
        Assert.Equal("", config.Seed);
    }

    [Fact]
    public void OneUnnamedGenIsAPlainSequence()
    {
        SequenceSpec spec = Build(
            "<tdc><env><sequence name=\"A\"><gen type=\"number\" value=\"1..9\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>").Sequences[0];

        Assert.False(spec.IsCompound);
        Assert.False(spec.IsConditional);
        Assert.Equal("number", spec.Gen!.Type);
        Assert.Equal("1..9", spec.Gen.Attr("value"));
    }

    [Fact]
    public void ASingleNamedGenIsStillACompound()
    {
        // Deliberate, not accidental: naming the only field says "this is one thing with parts",
        // and the fields register as Name.Field rather than as the sequence itself.
        SequenceSpec spec = Build(
            "<tdc><env><sequence name=\"A\"><gen name=\"City\" type=\"text\" value=\"x\"/></sequence>"
            + "</env><block><line><data>${{A.City}}</data></line></block></tdc>").Sequences[0];

        Assert.True(spec.IsCompound);
        Assert.Single(spec.Fields!);
        Assert.Equal("City", spec.Fields![0].Name);
    }

    [Fact]
    public void AnIfOnAGenMakesTheSequenceConditional()
    {
        SequenceSpec spec = Build(
            "<tdc><env><sequence name=\"A\">"
            + "<gen if=\"B == 1\" type=\"text\" value=\"yes\"/>"
            + "<gen type=\"text\" value=\"no\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>").Sequences[0];

        Assert.True(spec.IsConditional);
        Assert.Equal(2, spec.Branches!.Count);
        Assert.Equal("B == 1", spec.Branches[0].IfExpr);
        Assert.Null(spec.Branches[1].IfExpr);
        // The condition is the branch's, not a setting the generator should be handed.
        Assert.Null(spec.Branches[0].Gen.Attr("if"));
    }

    [Fact]
    public void AMapTableSplitsOnTheFirstColonOnly()
    {
        // A value may contain colons — a time of day, a namespaced id — and must survive whole.
        SequenceSpec spec = Build(
            "<tdc><env><sequence name=\"S\"><gen type=\"text\" value=\"x\"/></sequence>"
            + "<switch name=\"A\" on=\"S\"><map>US|CA:09:30, MX:10:00</map></switch></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>").Sequences[1];

        Assert.True(spec.IsSwitch);
        Assert.Equal(2, spec.SwitchSpec!.Entries.Count);
        Assert.Equal(new[] { "US", "CA" }, spec.SwitchSpec.Entries[0].Keys);
        Assert.Equal("09:30", spec.SwitchSpec.Entries[0].Value.Parts[0].Text);
        Assert.Equal("10:00", spec.SwitchSpec.Entries[1].Value.Parts[0].Text);
    }

    [Fact]
    public void FixturesLandInTheirOwnSlots()
    {
        Config config = Build(
            "<tdc><env><before><line><data>HEAD</data></line></before>"
            + "<delimiter_block><line><data>,</data></line></delimiter_block>"
            + "<after><line><data>TAIL</data></line></after>"
            + "<sequence name=\"A\"><gen type=\"text\" value=\"x\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>");

        Assert.Equal("HEAD", config.Fixtures.Before[0].Parts[0].Text);
        Assert.Equal(",", config.Fixtures.DelimiterBlock[0].Parts[0].Text);
        Assert.Equal("TAIL", config.Fixtures.After[0].Parts[0].Text);
        Assert.Empty(config.Fixtures.BeforeLine);
    }

    [Fact]
    public void ARegexLimitIsReadFromTheRootAndMustBePositive()
    {
        Config config = Build(
            "<tdc regex_max_length=\"12\"><env><sequence name=\"A\">"
            + "<gen type=\"text\" value=\"x\"/></sequence></env>"
            + "<block><line><data>${{A}}</data></line></block></tdc>");
        Assert.Equal(12, config.RegexMaxLength);

        Assert.Throws<ArgumentException>(() => ConfigBuilder.ParseMaxLength("0"));
        Assert.Throws<ArgumentException>(() => ConfigBuilder.ParseMaxLength("nonsense"));
    }

    [Fact]
    public void AConfigWithoutABlockIsRefused()
    {
        // Better to stop than to render nothing and call it a run.
        Assert.Throws<ArgumentException>(() => Build("<tdc><env></env></tdc>"));
    }

    [Theory]
    [MemberData(nameof(ParseFixturesTest.Fixtures), MemberType = typeof(ParseFixturesTest))]
    public void GoldenFixturesBuild(string name, string path)
    {
        Config config = Build(File.ReadAllText(path));
        Assert.True(config.Count > 0, $"{name}: count is not positive");
        Assert.NotEmpty(config.Block);
    }
}
