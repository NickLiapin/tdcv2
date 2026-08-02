using System.Text.Json;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// Every config in the golden set has to parse cleanly with the shared grammar.
/// </summary>
/// <remarks>
/// <para>
/// This is the cheapest possible check that the four implementations still speak one language.
/// The grammar files are shared; if a fixture the reference reads every day fails to parse here,
/// the two have started accepting different dialects — and that would show up much later as
/// "works on my machine, not in .NET", which is a far more expensive way to learn it.
/// </para>
/// <para>
/// Parsing only. What the tree MEANS is the config builder's problem, and the shared case
/// fixtures hold that to the reference separately.
/// </para>
/// </remarks>
public class ParseFixturesTest
{
    public static TheoryData<string, string> Fixtures()
    {
        string shared = PrngVectorsTest.FixturesDir();
        string manifestPath = Path.Combine(shared, "manifest.json");
        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));

        var data = new TheoryData<string, string>();
        int found = 0;
        foreach (JsonElement fixture in manifest.RootElement.GetProperty("runtimeFixtures").EnumerateArray())
        {
            found++;
            string name = fixture.GetProperty("name").GetString()!;
            // Paths in the manifest are relative to the manifest itself.
            string source = Path.GetFullPath(
                Path.Combine(shared, fixture.GetProperty("source").GetString()!));
            data.Add(name, source);
        }

        Assert.True(found > 0, "the manifest lists no runtime fixtures");
        return data;
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void GoldenFixturesParse(string name, string path)
    {
        Assert.True(File.Exists(path), $"{name}: {path} does not exist");
        TdcParserFacade.Result result = TdcParserFacade.Parse(File.ReadAllText(path));
        Assert.True(
            result.Ok,
            $"{name} does not parse: " + string.Join("; ", result.Problems.Select(p => p.ToString())));
    }

    [Fact]
    public void SyntaxErrorsAreReportedRatherThanPrinted()
    {
        // ANTLR would print this and hand back a best-effort tree. A half-parsed config generating
        // plausible-looking data is the failure mode worth being loud about.
        TdcParserFacade.Result result = TdcParserFacade.Parse("<tdc><env count=></tdc>");
        Assert.False(result.Ok);
        Assert.NotEmpty(result.Problems);
        Assert.True(result.Problems[0].Line > 0);
    }
}
