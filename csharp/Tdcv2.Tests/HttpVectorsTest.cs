using System.Text.Json;
using Tdcv2.Generators;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The two numbers a service recomputes, against the vectors all five answer to.
/// </summary>
/// <remarks>
/// A service checks ONE signature and reads ONE seed, and cannot tell which of the five runtimes
/// sent the request — so both are the wire contract rather than an implementation detail. This
/// project held one of only two pinned signature values and no pinned seed at all; the file it
/// now reads is shared, so a drift in any implementation fails in every one of them.
/// </remarks>
public class HttpVectorsTest
{
    private static JsonElement Vectors(string section)
    {
        string text = File.ReadAllText(
            Path.Combine(PrngVectorsTest.FixturesDir(), "http-vectors.json"));
        using JsonDocument document = JsonDocument.Parse(text);
        return document.RootElement.GetProperty(section).GetProperty("vectors").Clone();
    }

    [Fact]
    public void SignaturesMatchEveryImplementation()
    {
        JsonElement vectors = Vectors("signature");
        int checked_ = 0;
        foreach (JsonElement v in vectors.EnumerateArray())
        {
            Assert.Equal(
                v.GetProperty("signature").GetString(),
                HttpGen.SignRequest(
                    v.GetProperty("secret").GetString()!,
                    v.GetProperty("timestamp").GetString()!,
                    v.GetProperty("seed").GetString()!,
                    v.GetProperty("count").GetInt32(),
                    v.GetProperty("body").GetString()!));
            checked_++;
        }

        Assert.True(checked_ > 0, "an empty fixture would pass anything");
    }

    /// <summary>
    /// Pinning one request pins nothing. The vectors differ from the canonical one in a single
    /// field each, so an implementation that dropped a field from the message would match the
    /// first and fail one of the others.
    /// </summary>
    [Fact]
    public void EveryPartOfTheMessageChangesTheAnswer()
    {
        List<string> signatures = Vectors("signature")
            .EnumerateArray()
            .Select(v => v.GetProperty("signature").GetString()!)
            .ToList();
        Assert.Equal(signatures.Count, signatures.Distinct().Count());
    }

    [Fact]
    public void DerivedSeedsMatchEveryImplementation()
    {
        JsonElement vectors = Vectors("derivedSeed");
        int checked_ = 0;
        foreach (JsonElement v in vectors.EnumerateArray())
        {
            Assert.Equal(
                v.GetProperty("derived").GetString(),
                HttpGen.SeedFor(
                    v.GetProperty("envSeed").GetString()!,
                    v.GetProperty("sequence").GetString()!));
            checked_++;
        }

        Assert.True(checked_ > 0, "an empty fixture would pass anything");
    }
}
