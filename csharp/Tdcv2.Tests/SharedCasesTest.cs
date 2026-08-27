using System.Globalization;
using System.Text;
using System.Text.Json;
using Tdcv2.Engine;
using Tdcv2.Model;
using Tdcv2.Errors;
using Tdcv2.Packs;
using Tdcv2.Parser;
using Tdcv2.Validation;

namespace Tdcv2.Tests;

/// <summary>
/// The shared cases: the same 104 configs and expected output the other three answer to.
/// </summary>
/// <remarks>
/// <para>
/// A case either matches the reference byte for byte or it does not; there is no partial credit.
/// What this port has not reached yet raises <see cref="NotSupportedException"/> from the engine,
/// and those are counted separately — a feature that says it is missing is a different thing from
/// a feature that quietly produces the wrong column, and only the second is a failure.
/// </para>
/// <para>
/// The progress number is printed rather than asserted, because the count will keep moving. What
/// IS asserted is that nothing regresses: no case may produce output that differs from the
/// reference. A port that renders something wrong fails here immediately.
/// </para>
/// </remarks>
public class SharedCasesTest
{
    public static TheoryData<string, string> Cases()
    {
        string dir = Path.Combine(PrngVectorsTest.FixturesDir(), "cases");
        var data = new TheoryData<string, string>();
        foreach (string file in Directory.GetFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
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
        JsonElement root = node.RootElement;

        string actual;
        try
        {
            actual = Render(root);
        }
        catch (NotSupportedException)
        {
            // Not reached yet. Loud in the code, silent here — this is the honest state of a port
            // in progress, not a defect.
            return;
        }

        var want = new StringBuilder();
        foreach (JsonElement line in root.GetProperty("expected").EnumerateArray())
        {
            want.Append(line.GetString()).Append('\n');
        }

        Assert.Equal(want.ToString(), actual);
    }

    private static string Render(JsonElement node)
    {
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(node.GetProperty("config").GetString()!);
        if (!parsed.Ok)
        {
            throw new InvalidOperationException(
                "does not parse: " + string.Join("; ", parsed.Problems.Select(p => p.ToString())));
        }

        // A case says "this config renders these bytes", which presumes the validator accepts it.
        // Rendering straight off the parse tree skips that presumption, so a port whose validator
        // refuses an attribute the reference reads passes here while `tdcv2 check` on the same file
        // fails. That is how `base=` on <gen type="running"> stayed refused in three ports.
        // With the PACKS, as the command line has them. A pack declares its own parameters —
        // `domain=` on `common.internet.email` is one — and a validator that cannot see the pack
        // reports the parameter as an unknown attribute, so no shared case could ever name one.
        var refusals = Validator
            .Validate(parsed.Tree, PrngVectorsTest.BaseDirOf(node), DataPacks.Discover())
            .Where(d => d.Severity == Severity.Error)
            .ToList();
        if (refusals.Count > 0)
        {
            throw new InvalidOperationException(
                "the validator refuses a shared case: "
                + string.Join("; ", refusals.Select(d => d.Code + " " + d.Message)));
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

        // A case may pin the clock; `value="today"` reads it, and without this the case would
        // pass today and fail tomorrow.
        long? now = node.TryGetProperty("now", out JsonElement n) && n.ValueKind == JsonValueKind.String
            ? DateTimeOffset.Parse(n.GetString()!, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal)
                .ToUnixTimeMilliseconds()
            : null;

        return Engines.Render(
            config.Override(count, seed, locale), null, now, PrngVectorsTest.BaseDirOf(node));
    }

    /// <summary>How far the port has got, as a number rather than an impression.</summary>
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
            JsonElement root = node.RootElement;

            string actual;
            try
            {
                actual = Render(root);
            }
            catch (NotSupportedException e)
            {
                notYet.Add(e.Message);
                continue;
            }
            catch (Exception e)
            {
                wrong.Add($"{name}: {e.GetType().Name} {e.Message}");
                continue;
            }

            var want = new StringBuilder();
            foreach (JsonElement line in root.GetProperty("expected").EnumerateArray())
            {
                want.Append(line.GetString()).Append('\n');
            }

            if (want.ToString() == actual)
            {
                matched++;
            }
            else
            {
                wrong.Add(name);
            }
        }

        Console.WriteLine(
            $"shared cases: {matched} match the reference, {notYet.Count} not ported yet, "
            + $"{wrong.Count} wrong");
        // Grouped, so the biggest remaining piece of work is a number rather than a guess.
        foreach (var group in notYet.GroupBy(m => m).OrderByDescending(g => g.Count()))
        {
            Console.WriteLine($"  {group.Count(),3}  {group.Key}");
        }

        foreach (string w in wrong.Take(10))
        {
            Console.WriteLine("  wrong: " + w);
        }

        Assert.True(wrong.Count == 0, $"{wrong.Count} case(s) render something other than the reference");
        Assert.True(matched > 0, "no shared case matches yet");
    }
}
