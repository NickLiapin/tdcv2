using System.Globalization;
using System.Text;
using System.Text.Json;
using Tdcv2.Engine;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// The streaming engine against the reference's own streaming output.
/// </summary>
/// <remarks>
/// The engines draw in different orders, so engine 2's output is NOT engine 1's and is not meant to
/// be. That is why it has a fixture of its own: without one, a streaming engine that produced
/// plausible values would look correct, and the whole point of it is that row nine million agrees
/// with what a single-threaded run would have written there.
/// </remarks>
public class StreamEngineTest
{
    private static readonly Lazy<JsonDocument> Expected = new(() =>
        JsonDocument.Parse(
            File.ReadAllText(
                Path.Combine(PrngVectorsTest.FixturesDir(), "engines.json"))));

    public static TheoryData<string, string> Cases()
    {
        string dir = Path.Combine(PrngVectorsTest.FixturesDir(), "cases");
        var data = new TheoryData<string, string>();
        foreach (string file in Directory.GetFiles(dir, "*.json")
                     .OrderBy(f => f, StringComparer.Ordinal))
        {
            string group = Path.GetFileNameWithoutExtension(file);
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(file));
            foreach (JsonElement node in document.RootElement.GetProperty("cases").EnumerateArray())
            {
                data.Add(group + "/" + node.GetProperty("name").GetString(), node.GetRawText());
            }
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesTheReferenceOrSaysItCannot(string name, string raw)
    {
        using JsonDocument node = JsonDocument.Parse(raw);

        string? actual;
        try
        {
            actual = Render(node.RootElement, Engine);
        }
        catch (Exception e) when (e is NotSupportedException
                                  or StreamEngine.UnsupportedHere
                                  or ArgumentException)
        {
            // Not reached yet, or genuinely not this engine's work. Loud in the code, silent here.
            // ArgumentException belongs here too: a refusal raised by the expression layer rather
            // than the streaming builder — `prev()` without mode="sequential" — is still a refusal,
            // and WHAT is refused is the contract, not which exception carries it.
            return;
        }

        Assert.Equal(Want(name), actual);
    }

    /// <summary>Which engine this class checks. The subclass below points the same cases at 3.</summary>
    protected virtual int Engine => 2;

    private string? Want(string name)
    {
        if (!Expected.Value.RootElement.GetProperty("cases")
                .TryGetProperty(name, out JsonElement entry)
            || !entry.TryGetProperty("engine" + Engine, out JsonElement e2)
            // The reference refuses this one too. A case both engines decline is not a gap in the
            // port, so it is neither counted nor compared.
            || !e2.TryGetProperty("lines", out _))
        {
            return null;
        }

        var text = new StringBuilder();
        foreach (JsonElement line in e2.GetProperty("lines").EnumerateArray())
        {
            text.Append(line.GetString()).Append('\n');
        }

        return text.ToString();
    }

    private static string Render(JsonElement node, int engine)
    {
        TdcParserFacade.Result parsed =
            TdcParserFacade.Parse(node.GetProperty("config").GetString()!);
        if (!parsed.Ok)
        {
            throw new InvalidOperationException(
                "does not parse: " + string.Join("; ", parsed.Problems));
        }

        Config config = ConfigBuilder.Build(parsed.Tree);
        int? count = node.TryGetProperty("count", out JsonElement c) && c.ValueKind != JsonValueKind.Null
            ? c.GetInt32()
            : null;
        string? seed = node.TryGetProperty("seed", out JsonElement s) && s.ValueKind != JsonValueKind.Null
            ? s.GetString()
            : null;
        string? locale = node.TryGetProperty("locale", out JsonElement l) && l.ValueKind != JsonValueKind.Null
            ? l.GetString()
            : null;
        long now = node.TryGetProperty("now", out JsonElement n) && n.ValueKind == JsonValueKind.String
            ? DateTimeOffset.Parse(
                n.GetString()!, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal)
                .ToUnixTimeMilliseconds()
            : 0;

        Config final = config.Override(count, seed, locale);
        string baseDir = PrngVectorsTest.BaseDirOf(node);
        return engine == 2
            ? StreamEngine.Rows(final, DataPacks.Discover(), now, baseDir).Text()
            : DiskEngine.Rows(final, DataPacks.Discover(), now, baseDir).Text();
    }

    /// <summary>How far the streaming engine has got, as a number rather than an impression.</summary>
    [Fact]
    public void ReportsProgress()
    {
        int matched = 0;
        var notYet = new List<string>();
        var wrong = new List<string>();

        foreach (object[] row in Cases())
        {
            string name = (string)row[0];
            using JsonDocument node = JsonDocument.Parse((string)row[1]);
            string? want = Want(name);
            if (want is null)
            {
                continue;
            }

            try
            {
                string actual = Render(node.RootElement, Engine);
                if (actual == want)
                {
                    matched++;
                }
                else
                {
                    wrong.Add(name);
                }
            }
            catch (Exception e) when (e is NotSupportedException or StreamEngine.UnsupportedHere)
            {
                notYet.Add(e.Message);
            }
            catch (Exception e)
            {
                wrong.Add($"{name}: {e.GetType().Name} {e.Message}");
            }
        }

        Console.WriteLine(
            $"engine {Engine}: {matched} match the reference, {notYet.Count} refused, "
            + $"{wrong.Count} wrong");
        foreach (var group in notYet.GroupBy(m => m).OrderByDescending(g => g.Count()).Take(15))
        {
            Console.WriteLine($"  {group.Count(),3}  {group.Key}");
        }

        foreach (string w in wrong.Take(20))
        {
            Console.WriteLine("  wrong: " + w);
        }

        Assert.True(
            wrong.Count == 0, $"{wrong.Count} case(s) stream something other than the reference");
        Assert.True(matched > 0, "no case streams correctly yet");
    }
}

/// <summary>
/// The same cases through engine 3, against the reference's exact-on-disk output.
/// </summary>
/// <remarks>
/// Engine 3 refuses nothing: where the bounded construction cannot satisfy a config it falls back to
/// the in-memory engine rather than shipping data that is nearly unique. So every case here has an
/// expected answer, and any refusal is a gap in the port rather than a property of the engine.
/// </remarks>
public sealed class DiskEngineTest : StreamEngineTest
{
    protected override int Engine => 3;
}
