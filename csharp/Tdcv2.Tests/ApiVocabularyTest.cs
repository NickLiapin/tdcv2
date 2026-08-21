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
}
