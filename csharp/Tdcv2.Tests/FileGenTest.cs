using Tdcv2.Engine;
using Tdcv2.Generators;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// The file generator, which the shared cases cannot reach because they carry no files.
/// </summary>
/// <remarks>
/// What matters here is not that a CSV parses — it is the handful of decisions that turn a plausible
/// reading of a file into a wrong one: a weight column that silently drops a product, a header row
/// counted as data, a byte-order mark hiding the first column's name.
/// </remarks>
public class FileGenTest : IDisposable
{
    private readonly string _dir = Directory.CreateDirectory(
        Path.Combine(Path.GetTempPath(), "tdcv2-filegen-" + Guid.NewGuid().ToString("N"))).FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Write(string name, string content)
    {
        string path = Path.Combine(_dir, name);
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public void APlainListIsOneValuePerLineWithBlanksSkipped()
    {
        Write("codes.txt", "alpha\n\n  beta  \ngamma\n");
        var attrs = new Dictionary<string, string> { ["src"] = "codes.txt" };

        Assert.Equal(new[] { "alpha", "beta", "gamma" }, FileGen.Load(attrs, _dir));
    }

    [Fact]
    public void ANamedColumnSkipsTheHeaderAndANumberedOneDoesNot()
    {
        Write("rows.csv", "name,count\nSmith,3\nJones,1\n");

        Assert.Equal(
            new[] { "Smith", "Jones" },
            FileGen.Load(new Dictionary<string, string> { ["src"] = "rows.csv", ["column"] = "name" }, _dir));

        // A file of pure data has no header to skip, so a numbered column takes every row.
        Assert.Equal(
            new[] { "name", "Smith", "Jones" },
            FileGen.Load(new Dictionary<string, string> { ["src"] = "rows.csv", ["column"] = "1" }, _dir));
    }

    [Fact]
    public void AByteOrderMarkDoesNotHideTheFirstColumnsName()
    {
        // Excel writes one ahead of the first header cell; without stripping it, every
        // "Save as CSV" export would fail to resolve its first column by name and no other.
        Write("bom.csv", "﻿name,count\nSmith,3\n");

        Assert.Equal(
            new[] { "Smith" },
            FileGen.Load(new Dictionary<string, string> { ["src"] = "bom.csv", ["column"] = "name" }, _dir));
    }

    [Fact]
    public void QuotedFieldsKeepTheirCommasAndTheirDoubledQuotes()
    {
        Write("quoted.csv", "name\n\"Smith, John\"\n\"He said \"\"hi\"\"\"\n");

        Assert.Equal(
            new[] { "Smith, John", "He said \"hi\"" },
            FileGen.Load(new Dictionary<string, string> { ["src"] = "quoted.csv", ["column"] = "name" }, _dir));
    }

    [Fact]
    public void WeightsAreHonouredExactlyRatherThanOnAverage()
    {
        Write("weighted.csv", "name,count\nSmith,20000\nJones,10000\n");
        var attrs = new Dictionary<string, string>
        {
            ["src"] = "weighted.csv", ["column"] = "name", ["weight"] = "count",
        };

        FileGen.Weighted weighted = FileGen.LoadWeighted(attrs, _dir)!;
        Assert.Equal(new[] { "Smith", "Jones" }, weighted.Values);
        Assert.Equal(200.0 / 3, weighted.Percents[0], 9);
        Assert.Equal(100.0 / 3, weighted.Percents[1], 9);
    }

    [Fact]
    public void AZeroWeightDropsAValueButABlankOneIsAnError()
    {
        Write("zero.csv", "name,count\nSmith,5\nGone,0\n");
        var attrs = new Dictionary<string, string>
        {
            ["src"] = "zero.csv", ["column"] = "name", ["weight"] = "count",
        };
        Assert.Equal(new[] { "Smith" }, FileGen.LoadWeighted(attrs, _dir)!.Values);

        // A blank must not slide through as zero. A product vanishing from a catalogue because one
        // cell of an export was empty is discovered far too late, and "missing" and "deliberately
        // excluded" are different statements — only one of them is actionable.
        Write("blank.csv", "name,count\nSmith,5\nOops,\n");
        var blank = new Dictionary<string, string>
        {
            ["src"] = "blank.csv", ["column"] = "name", ["weight"] = "count",
        };
        ArgumentException e = Assert.Throws<ArgumentException>(() => FileGen.LoadWeighted(blank, _dir));
        Assert.Contains("write 0 to exclude it", e.Message);
    }

    [Fact]
    public void TwoColumnsOnOneRowLinkComeFromTheSameRecord()
    {
        Write("places.csv", "city,postcode\nBerlin,10115\nHamburg,20095\nMunich,80331\n");

        string rendered = Engines.Render(
            ConfigBuilder.Build(
                TdcParserFacade.Parse(
                    "<tdc><env count=\"4\" seed=\"link\" mode=\"memory\">"
                    + "<sequence name=\"City\"><gen type=\"file\" src=\"places.csv\" "
                    + "column=\"city\" row=\"place\"/></sequence>"
                    + "<sequence name=\"Zip\"><gen type=\"file\" src=\"places.csv\" "
                    + "column=\"postcode\" row=\"place\"/></sequence>"
                    + "</env><block><line><data>${{City}} ${{Zip}}</data></line></block></tdc>").Tree),
            null, null, _dir);

        // Every emitted pair is a real record, never a plausible-looking recombination.
        var real = new Dictionary<string, string>
        {
            ["Berlin"] = "10115", ["Hamburg"] = "20095", ["Munich"] = "80331",
        };
        foreach (string line in rendered.TrimEnd('\n').Split('\n'))
        {
            string[] parts = line.Split(' ');
            Assert.Equal(real[parts[0]], parts[1]);
        }
    }

    [Fact]
    public void ARelativeSourceIsRelativeToTheConfigNotTheWorkingDirectory()
    {
        string path = Write("here.txt", "one\n");

        // Otherwise the same config would work from one shell and fail from another.
        Assert.Equal(path, FileGen.Resolve("here.txt", _dir, null));
        Assert.Equal(path, FileGen.Resolve("./here.txt", _dir, null));
    }

    [Fact]
    public void TheDataAliasNamesTheConfiguredFoldersAndSaysSoWhenThereAreNone()
    {
        string path = Write("shared.txt", "one\n");
        Assert.Equal(path, FileGen.Resolve("@data/shared.txt", "/nowhere", new[] { _dir }));

        ArgumentException e = Assert.Throws<ArgumentException>(
            () => FileGen.Resolve("@data/shared.txt", _dir, null));
        Assert.Contains("needs at least one data folder", e.Message);
    }

    [Theory]
    [InlineData("tab")]
    [InlineData("\\t")]
    // A real tab arrives as a single character and is taken as written: trimming it would leave
    // nothing and fall back to a comma, so resolving twice has to be harmless.
    [InlineData("\t")]
    public void EverySpellingOfTabIsATab(string spec)
    {
        Write("tabbed.tsv", "name\tcount\nSmith\t3\n");
        var attrs = new Dictionary<string, string>
        {
            ["src"] = "tabbed.tsv", ["column"] = "name", ["delimiter"] = spec,
        };

        Assert.Equal(new[] { "Smith" }, FileGen.Load(attrs, _dir));
    }

    [Fact]
    public void SequentialOrderWalksTheFileInOrder()
    {
        Write("months.txt", "Jan\nFeb\nMar\n");

        string rendered = Engines.Render(
            ConfigBuilder.Build(
                TdcParserFacade.Parse(
                    "<tdc><env count=\"5\" seed=\"s\" mode=\"memory\"><sequence name=\"M\">"
                    + "<gen type=\"file\" src=\"months.txt\" order=\"sequential\"/></sequence>"
                    + "</env><block><line><data>${{M}}</data></line></block></tdc>").Tree),
            null, null, _dir);

        // Looping is the default: a short list over many rows is the ordinary case.
        Assert.Equal("Jan\nFeb\nMar\nJan\nFeb\n", rendered);
    }
}
