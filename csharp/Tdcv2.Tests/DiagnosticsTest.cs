using System.Text.Json;
using Tdcv2.Errors;
using Tdcv2.Packs;
using Tdcv2.Parser;
using Tdcv2.Validation;

namespace Tdcv2.Tests;

/// <summary>
/// The shared diagnostic cases: the same configs the other three refuse, refused the same way.
/// </summary>
/// <remarks>
/// "The same config produces the same data everywhere" is only half a promise if one implementation
/// accepts what another rejects. A config that runs in C# and fails in TypeScript is a portability
/// bug even when no value was ever wrong — so what is asserted is severity, code and position,
/// never the wording, which is free to improve.
/// </remarks>
public class DiagnosticsTest
{
    public static TheoryData<string, string> Cases()
    {
        string dir = Path.Combine(PrngVectorsTest.FixturesDir(), "diagnostics");
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
    public void ReportsExactlyWhatTheReferenceReports(string name, string raw)
    {
        using JsonDocument node = JsonDocument.Parse(raw);
        Assert.Equal(Expected(node.RootElement), Signatures(node.RootElement));
    }

    private static IReadOnlyList<string> Expected(JsonElement root) =>
        root.GetProperty("expected").EnumerateArray().Select(e => e.GetString()!).ToArray();

    private static IReadOnlyList<string> Signatures(JsonElement root)
    {
        string config = root.GetProperty("config").GetString()!;
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(config);
        if (!parsed.Ok)
        {
            // A parse error stops the run: there is no tree to validate, and the parser's own
            // complaint is the only honest thing to report. The PARSE signature matches the
            // Python and Java harnesses.
            return parsed.Problems
                .Select(p => $"error PARSE {p.Line}:{p.Column}")
                .ToArray();
        }

        return Validator
            .Validate(parsed.Tree, PrngVectorsTest.FixturesDir(), DataPacks.Discover())
            .Select(d => d.Signature())
            .ToArray();
    }

    /// <summary>How much of the shared contract this port answers to, as a number.</summary>
    [Fact]
    public void ReportsProgress()
    {
        int matched = 0;
        var wrong = new List<string>();

        foreach (object[] row in Cases())
        {
            string name = (string)row[0];
            using JsonDocument node = JsonDocument.Parse((string)row[1]);
            try
            {
                if (Expected(node.RootElement).SequenceEqual(Signatures(node.RootElement)))
                {
                    matched++;
                }
                else
                {
                    wrong.Add(
                        $"{name}: want [{string.Join(" | ", Expected(node.RootElement))}] "
                        + $"got [{string.Join(" | ", Signatures(node.RootElement))}]");
                }
            }
            catch (Exception e)
            {
                wrong.Add($"{name}: {e.GetType().Name} {e.Message}");
            }
        }

        Console.WriteLine($"diagnostics: {matched} match the reference, {wrong.Count} do not");
        foreach (string w in wrong.Take(40))
        {
            Console.WriteLine("  " + w);
        }

        Assert.Empty(wrong);
    }
}
