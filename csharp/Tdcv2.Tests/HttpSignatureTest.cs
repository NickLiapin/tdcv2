using Tdcv2.Generators;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The signature has to be the SAME number in every implementation.
/// </summary>
/// <remarks>
/// A service checks one signature and does not know which runtime sent the request, so this value
/// is the contract. Measured from Node's <c>crypto.createHmac</c>, Python's <c>hmac</c>, Java's
/// <c>Mac</c> and the hand-written HMAC in the Rust crate — all four give these 64 hex digits.
/// </remarks>
public class HttpSignatureTest
{
    [Fact]
    public void AgreesWithTheOtherImplementations()
    {
        Assert.Equal(
            "d0be9a276deb4802b0a2ec6d85050f7f90e1c44cf42c25773740b755f98803ce",
            HttpGen.SignRequest("k7Fm2p-test-secret", "1786000000", "seed1", 4, "body"));
    }

    /// <summary>Everything that decides the answer is inside the signature.</summary>
    [Fact]
    public void CoversEveryPartOfTheRequest()
    {
        string baseline = HttpGen.SignRequest("s", "1786000000", "seed1", 4, "body");
        Assert.NotEqual(baseline, HttpGen.SignRequest("s", "1786000001", "seed1", 4, "body"));
        Assert.NotEqual(baseline, HttpGen.SignRequest("s", "1786000000", "seed2", 4, "body"));
        Assert.NotEqual(baseline, HttpGen.SignRequest("s", "1786000000", "seed1", 5, "body"));
        Assert.NotEqual(baseline, HttpGen.SignRequest("s", "1786000000", "seed1", 4, "other"));
        Assert.Equal(baseline, HttpGen.SignRequest("s", "1786000000", "seed1", 4, "body"));
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
