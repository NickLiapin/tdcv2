using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using Tdcv2;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The object a finished run hands back answers to the SAME names in all five implementations.
/// </summary>
/// <remarks>
/// There was no guard on this surface and it drifted: Python had no <c>to_string</c>, Java no
/// <c>toArray</c>, C# neither <c>GetAt</c> nor <c>Iterate</c>, Rust neither <c>to_array</c> nor
/// <c>get_at</c>. Each was reasonable in its own language and wrong for a reader crossing between
/// them — which is the only way this library is ever read, because it exists to be used beside
/// the generator. The fixture is the vocabulary; this asks C# to answer to it.
/// </remarks>
public class ApiVocabularyTest
{
    private static readonly Lazy<JsonDocument> Fixture = new(() =>
        JsonDocument.Parse(
            File.ReadAllText(Path.Combine(PrngVectorsTest.FixturesDir(), "api.json"))));

    public static IEnumerable<object[]> Members()
    {
        foreach (JsonElement m in Fixture.Value.RootElement.GetProperty("members").EnumerateArray())
        {
            yield return new object[]
            {
                m.GetProperty("csharp").GetString()!,
                m.GetProperty("concept").GetString()!,
            };
        }
    }

    [Theory]
    [MemberData(nameof(Members))]
    public void TheSharedNameExists(string name, string concept)
    {
        MemberInfo[] found = typeof(Tdc).GetMember(
            name, BindingFlags.Public | BindingFlags.Instance);
        Assert.True(found.Length > 0, $"Tdc has no public member named {name} — {concept}");
    }

    [Fact]
    public void TheVocabularyIsNotEmpty()
    {
        // A fixture that says nothing would let every name above pass by saying nothing.
        Assert.True(Fixture.Value.RootElement.GetProperty("members").GetArrayLength() > 5);
    }

    /// <summary>Each reader, read to the end — an iterator that is never drained checks nothing.</summary>
    private static readonly Dictionary<string, Action<Tdc, int>> Readers = new()
    {
        ["the whole run as text"] = (tdc, index) => _ = tdc.ToString(),
        ["every record, materialised"] = (tdc, index) => _ = tdc.ToArray(),
        ["every record, one at a time"] = (tdc, index) => _ = tdc.Iterate().Count(),
        ["one record by position"] = (tdc, index) => _ = tdc.GetAt(index),
        ["the run as columns rather than rows"] = (tdc, index) => _ = tdc.ToColumns(),
    };

    private static JsonElement Rule =>
        Fixture.Value.RootElement.GetProperty("everyReaderKeepsEachAssert");

    public static IEnumerable<object[]> ReadersOfTheRule()
    {
        foreach (JsonElement r in Rule.GetProperty("readers").EnumerateArray())
        {
            yield return new object[]
            {
                r.GetProperty("concept").GetString()!,
                r.TryGetProperty("index", out JsonElement index) ? index.GetInt32() : 0,
            };
        }
    }

    [Theory]
    [MemberData(nameof(ReadersOfTheRule))]
    public void AFailingEachAssertionStopsEveryReader(string concept, int index)
    {
        Assert.True(Readers.TryGetValue(concept, out Action<Tdc, int>? read), $"no reader mapped for {concept}");
        var tdc = new Tdc(new Tdc.Options { ConfigString = Rule.GetProperty("config").GetString()! });
        Exception thrown = Assert.ThrowsAny<Exception>(() => read!(tdc, index));
        Assert.Contains(Rule.GetProperty("message").GetString()!, thrown.Message);
    }
}
