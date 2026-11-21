using Tdcv2.Generators;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The signature has to be the SAME number in every implementation.
/// </summary>
/// <remarks>
/// A service checks one signature and does not know which runtime sent the request, so this value
/// is the contract — the canonical request of <c>fixtures/cross-language/http-vectors.json</c>,
/// which all five answer to.
/// </remarks>
public class HttpSignatureTest
{
    [Fact]
    public void AgreesWithTheOtherImplementations()
    {
        Assert.Equal(
            "1c133c68bac0c7f954628513ab4eae62a11d4da5f2b65a46955c53bfdb6744a2",
            HttpGen.SignRequest(
                "k7Fm2p-test-secret", "POST", "/gen", "1786000000", "seed1", 4, 0, 4, "body"));
    }

    private static string Sign(
        string method = "POST", string target = "/gen", string timestamp = "1786000000",
        string seed = "seed1", int count = 4, int offset = 0, int total = 4, string body = "body") =>
        HttpGen.SignRequest("s", method, target, timestamp, seed, count, offset, total, body);

    /// <summary>Everything that decides the answer is inside the signature.</summary>
    [Fact]
    public void CoversEveryPartOfTheRequest()
    {
        string baseline = Sign();
        Assert.NotEqual(baseline, Sign(timestamp: "1786000001"));
        Assert.NotEqual(baseline, Sign(seed: "seed2"));
        Assert.NotEqual(baseline, Sign(count: 5));
        Assert.NotEqual(baseline, Sign(body: "other"));
        // A request signed for one address is not a request for another one of the same service —
        // the replay the article on http found, 2026-11-19.
        Assert.NotEqual(baseline, Sign(target: "/invite"));
        Assert.NotEqual(baseline, Sign(target: "/gen?model=small"));
        Assert.NotEqual(baseline, Sign(method: "PUT"));
        // A captured batch cannot be replayed as another one of the same column.
        Assert.NotEqual(Sign(total: 8), Sign(offset: 4, total: 8));
        Assert.NotEqual(baseline, Sign(total: 8));
        // ...and it is a function of those alone.
        Assert.Equal(baseline, Sign());
    }

    /// <summary>Three spellings, and an empty one is refused wherever it came from.</summary>
    [Fact]
    public void ResolvesASecretFromWhereItLives()
    {
        Assert.Equal("plain-value", HttpGen.ResolveSecret("  plain-value  ", "."));
        Assert.Throws<HttpGen.SecretException>(() => HttpGen.ResolveSecret("", "."));
        Assert.Throws<HttpGen.SecretException>(
            () => HttpGen.ResolveSecret("env:TDC_DEFINITELY_UNSET_SECRET", "."));
    }
}
