using System.Text.Json;
using Tdcv2.Format;

namespace Tdcv2.Tests;

/// <summary>
/// The formatting layer, against the reference's own answers.
/// </summary>
/// <remarks>
/// <para>
/// Masks and filters are small and full of decisions that are easy to get subtly wrong: which end
/// an index counts from, whether a range may run backwards, whether an out-of-range index is an
/// error or a gap, whether an unknown filter throws or passes the value through. Every one of
/// those has a right answer that is the reference's answer, so they are pinned as data rather than
/// argued about per implementation.
/// </para>
/// <para>
/// This layer is shared by three places that mean the same thing — the <c>case=</c> attribute, the
/// compute tags, and <c>${{Name|filter}}</c> — so one of them drifting shows up in all three.
/// </para>
/// </remarks>
public class FormattingTest
{
    public static TheoryData<string, string, string, string> Vectors()
    {
        string path = Path.Combine(PrngVectorsTest.FixturesDir(), "filter-vectors.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal(1, document.RootElement.GetProperty("schemaVersion").GetInt32());

        var data = new TheoryData<string, string, string, string>();
        foreach (JsonElement v in document.RootElement.GetProperty("vectors").EnumerateArray())
        {
            data.Add(
                v.GetProperty("kind").GetString()!,
                v.GetProperty("arg").GetString()!,
                v.GetProperty("input").GetString()!,
                v.GetProperty("expected").GetString()!);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Vectors))]
    public void MatchesTheReference(string kind, string arg, string input, string expected)
    {
        string actual = Transforms.ApplyFilter(kind, arg.Length == 0 ? null : arg, input);
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void InterpolationLeavesAnUnknownNameExactlyAsWritten()
    {
        // Replacing it with an empty string would hide a typo inside data that still looks
        // well-formed. Leaving the marker makes it obvious on the first row.
        var lookup = new Table(new Dictionary<string, string> { ["Name"] = "Ann" });
        Assert.Equal("Ann and ${{Gendre}}", Interpolate.Apply("${{Name}} and ${{Gendre}}", null, lookup));
    }

    [Fact]
    public void TheMarkerIsConfigurable()
    {
        // A config generating shell scripts sets inject="<<%>>" and stops fighting dollar signs.
        var lookup = new Table(new Dictionary<string, string> { ["Name"] = "Ann" });
        Assert.Equal("Ann", Interpolate.Apply("<<Name>>", "<<%>>", lookup));
        // An inject with no % slot names nothing, so nothing is substituted.
        Assert.Equal("<<Name>>", Interpolate.Apply("<<Name>>", "nopercent", lookup));
    }

    [Fact]
    public void FiltersChainLeftToRight()
    {
        var lookup = new Table(new Dictionary<string, string> { ["N"] = "  john smith  " });
        Assert.Equal("JOHN SMITH", Interpolate.Apply("${{N|trim|upper}}", null, lookup));
        Assert.Equal("smith john", Interpolate.Apply("${{N|trim|mask:w[1] w[0]}}", null, lookup));
    }

    [Fact]
    public void ABrokenMaskIndexIsRefusedBeforeAnyRowExists()
    {
        // The validator calls Check so a config with a typo fails at once rather than a million
        // rows later.
        Assert.Throws<ArgumentException>(() => Mask.Check("x[1-3]"));
        Mask.Check("x[1..3]");
    }

    private sealed class Table : Interpolate.ILookup
    {
        private readonly IReadOnlyDictionary<string, string> _values;

        internal Table(IReadOnlyDictionary<string, string> values) => _values = values;

        public bool Has(string name) => _values.ContainsKey(name);

        public string Value(string name) => _values[name];
    }
}
