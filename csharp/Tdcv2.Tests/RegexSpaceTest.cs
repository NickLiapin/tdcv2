using System.IO;
using System.Text.Json;
using Tdcv2.Generators;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// How many different strings a regex pattern makes, against the shared fixture.
/// </summary>
/// <remarks>
/// <c>uniq="true"</c> over a <c>type="regex"</c> pattern refuses a count the pattern cannot meet
/// before it draws, and knows the pattern's size by counting its parse tree. That count decides
/// which configs are refused, so all five implementations are held to one set of numbers —
/// including the deliberate overcounts, which are the contract rather than a mistake.
/// </remarks>
public class RegexSpaceTest
{
    private static JsonDocument Fixture() =>
        JsonDocument.Parse(File.ReadAllText(
            Path.Combine(PrngVectorsTest.FixturesDir(), "regex-space.json")));

    [Fact]
    public void SaturatesAtTheSameCeiling()
    {
        using JsonDocument doc = Fixture();
        Assert.Equal(doc.RootElement.GetProperty("cap").GetInt64(), RegexGen.SpaceCap);
    }

    [Fact]
    public void CountsTheSpaceTheReferenceCounts()
    {
        using JsonDocument doc = Fixture();
        foreach (JsonElement c in doc.RootElement.GetProperty("patterns").EnumerateArray())
        {
            string pattern = c.GetProperty("pattern").GetString()!;
            long want = c.GetProperty("size").GetInt64();
            long got = RegexGen.SpaceSize(pattern, RegexGen.DefaultMaxLength);
            Assert.True(
                want == got,
                $"{pattern}: expected {want}, counted {got} — {c.GetProperty("why").GetString()}");
        }
    }
}
