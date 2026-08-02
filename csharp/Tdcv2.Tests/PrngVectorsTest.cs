using System.Text.Json;
using Tdcv2.Prng;

namespace Tdcv2.Tests;

/// <summary>
/// The generator, against the vectors the other three are held to.
/// </summary>
/// <remarks>
/// <para>
/// Every value TDC produces comes from here, so this file is where a port either joins the others
/// or quietly forks. The vectors are shared — the same JSON checks TypeScript, Java and Python —
/// which is what makes "the same seed gives the same data in every language" a fact rather than
/// an intention.
/// </para>
/// <para>
/// Compared exactly, not approximately. These are doubles produced by the same integer arithmetic
/// in every implementation; a tolerance here would hide precisely the drift the test exists to
/// catch.
/// </para>
/// </remarks>
public class PrngVectorsTest
{
    /// <summary>The shared fixtures, found by walking up from the test assembly.</summary>
    internal static string FixturesDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "fixtures", "cross-language");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "cannot find fixtures/cross-language above " + AppContext.BaseDirectory);
    }

    [Fact]
    public void MatchesTheSharedVectors()
    {
        string text = File.ReadAllText(Path.Combine(FixturesDir(), "prng-vectors.json"));
        using JsonDocument document = JsonDocument.Parse(text);
        JsonElement root = document.RootElement;

        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());

        int vectors = 0;
        foreach (JsonElement vector in root.GetProperty("vectors").EnumerateArray())
        {
            string seed = vector.GetProperty("seed").GetString()!;
            Sfc32 generator = Prng.Prng.Create(seed);

            int i = 0;
            foreach (JsonElement expected in vector.GetProperty("values").EnumerateArray())
            {
                Assert.Equal(expected.GetDouble(), generator.Next());
                i++;
            }

            Assert.True(i > 0, $"seed \"{seed}\" has no values");
            vectors++;
        }

        Assert.True(vectors > 0, "no vectors in prng-vectors.json");
    }

    [Fact]
    public void SeekableDrawsDependOnlyOnTheRowNumber()
    {
        // The property the streaming engine and every parallel run rest on: asking for row 900 000
        // must not require having asked for the 899 999 before it.
        double direct = Seekable.Next("s", "Name", 900_000);
        double again = Seekable.Next("s", "Name", 900_000);
        Assert.Equal(direct, again);
        Assert.NotEqual(direct, Seekable.Next("s", "Name", 900_001));
        Assert.NotEqual(direct, Seekable.Next("s", "Other", 900_000));
    }

    [Fact]
    public void OpenUnitNeverReturnsZeroOrOne()
    {
        // Inverse-CDF sampling takes logarithms, and log(0) is not a number anyone wants in a row.
        Assert.True(Seekable.OpenUnit(0.0) > 0.0);
        Assert.True(Seekable.OpenUnit(0.9999999999) < 1.0);
    }
}
