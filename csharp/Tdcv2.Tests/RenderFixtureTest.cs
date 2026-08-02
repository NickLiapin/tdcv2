using System.Globalization;
using System.Text.Json;
using Tdcv2.Engine;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// End to end against the captured baselines: parse, generate, render, compare bytes.
/// </summary>
/// <remarks>
/// <para>
/// The fixture list comes from the manifest every implementation reads, not from a list typed here.
/// A hard-coded list drifts silently — a fixture added for the TypeScript engine would never run
/// against this one, and the port would look finished while missing a feature.
/// </para>
/// <para>
/// Byte equality is the only assertion worth making. Data that is merely plausible proves nothing:
/// the promise is that one config and one seed produce the same bytes in every language, and only a
/// comparison of the bytes tests that.
/// </para>
/// </remarks>
public class RenderFixtureTest
{
    public static TheoryData<string, string, string, long> ManifestFixtures()
    {
        string shared = PrngVectorsTest.FixturesDir();
        string manifestPath = Path.Combine(shared, "manifest.json");
        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));

        // The clock comes from the manifest, never from the machine: a date generator reading the
        // real time would pass today and fail tomorrow from the very same seed.
        long fixedNow = DateTimeOffset.Parse(
                manifest.RootElement.GetProperty("fixedNow").GetString()!,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal)
            .ToUnixTimeMilliseconds();

        var data = new TheoryData<string, string, string, long>();
        foreach (JsonElement entry in
                 manifest.RootElement.GetProperty("runtimeFixtures").EnumerateArray())
        {
            // Manifest paths are relative to the manifest's own folder.
            data.Add(
                entry.GetProperty("name").GetString()!,
                Path.GetFullPath(Path.Combine(shared, entry.GetProperty("source").GetString()!)),
                Path.GetFullPath(Path.Combine(shared, entry.GetProperty("expected").GetString()!)),
                fixedNow);
        }

        return data;
    }

    private static string Render(string source, long nowMillis)
    {
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(File.ReadAllText(source));
        Assert.True(
            parsed.Ok,
            $"{source} did not parse: " + string.Join("; ", parsed.Problems));
        Config config = ConfigBuilder.Build(parsed.Tree);
        // The in-memory engine by name, not through the router. These baselines were captured from
        // the reference's engine 1, and none of the fixtures declares a mode — so routing them
        // would send them to engine 2, which draws in a different order and is MEANT to disagree.
        // Comparing against the wrong engine's bytes would report a portability bug that is not one.
        return MemoryEngine.Run(
                config, DataPacks.Discover(), nowMillis, Path.GetDirectoryName(source))
            .Text();
    }

    [Theory]
    [MemberData(nameof(ManifestFixtures))]
    public void RendersByteIdenticalToTheCapturedBaseline(
        string name, string source, string expectedFile, long nowMillis)
    {
        string expected = File.ReadAllText(expectedFile);
        string actual = Render(source, nowMillis);

        if (expected != actual)
        {
            // A whole-file diff of a hundred lines is unreadable in a failure report; the first
            // differing line is what a person actually needs to see.
            string[] want = expected.Split('\n');
            string[] got = actual.Split('\n');
            for (int i = 0; i < Math.Max(want.Length, got.Length); i++)
            {
                string w = i < want.Length ? want[i] : "<missing>";
                string g = i < got.Length ? got[i] : "<missing>";
                if (w != g)
                {
                    Assert.True(false, $"{name}: first difference at line {i + 1}\n  want: {w}\n  got:  {g}");
                }
            }
        }

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void TheSplitIsExactAndChildrenStayInsideTheirParentsRows()
    {
        string path = Path.Combine(
            PrngVectorsTest.FixturesDir(), "..", "tdc_sequence_demo.xml");
        string[] rows = Render(Path.GetFullPath(path), 0).Split('\n');
        Assert.Equal("ID,Gender,ProstateIssue,BreastIssue", rows[0]);

        int male = 0;
        int female = 0;
        for (int i = 1; i <= 100; i++)
        {
            string[] cells = rows[i].Split(',');
            if (cells[1] == "Male")
            {
                male++;
                Assert.True(cells[3].Length == 0, $"row {i}: a male row carries a BreastIssue");
            }
            else
            {
                female++;
                Assert.True(cells[2].Length == 0, $"row {i}: a female row carries a ProstateIssue");
            }
        }

        // 42/58 of 100, exactly — the reason percent exists.
        Assert.Equal(42, male);
        Assert.Equal(58, female);
    }
}
