using Tdcv2.Packs;

namespace Tdcv2.Tests;

/// <summary>
/// The address rule, which is the part of the pack layer a port gets wrong.
/// </summary>
/// <remarks>
/// Everything else about a pack is a text file read line by line. What decides whether the right
/// file is opened is one branch: an address is absolute when its first segment names a folder that
/// exists, and relative to the active locale when it does not. Getting that backwards loads real
/// data from the wrong place, which reads as plausible output rather than as an error.
/// </remarks>
public class DataPacksTest
{
    private static DataPacks Packs() => DataPacks.Discover();

    [Fact]
    public void RelativeAddressGoesThroughTheActiveLocale()
    {
        // `person.lastName` is a different file under `en` than under `ru`.
        DataPacks.Entry en = Packs().Load("person.lastName", "en");
        DataPacks.Entry ru = Packs().Load("person.lastName", "ru");
        Assert.NotEmpty(en.Values);
        Assert.NotEmpty(ru.Values);
        Assert.NotEqual(en.Values[0], ru.Values[0]);
    }

    [Fact]
    public void ACountryAddressIsAbsoluteAndIgnoresTheLocale()
    {
        // countries/ is a physical grouping, not part of the address anyone writes.
        DataPacks.Entry underEn = Packs().Load("usa.finance.aba_routing", "en");
        DataPacks.Entry underRu = Packs().Load("usa.finance.aba_routing", "ru");
        Assert.True(underEn.IsGenerator);
        Assert.Equal(underEn.Generator, underRu.Generator);
    }

    [Fact]
    public void AWeightedPackBecomesPercentagesThatSumToAHundred()
    {
        DataPacks.Entry entry = Packs().Load("person.lastName", "en");
        Assert.True(entry.Weighted);
        Assert.Equal(entry.Values.Count, entry.Percents!.Length);
        Assert.Equal(100, entry.Percents.Sum(), 6);
        // A zero count means "never drawn", and census files are full of them.
        Assert.All(entry.Percents, p => Assert.True(p > 0));
    }

    [Fact]
    public void AGeneratorPackCarriesItsRuleInsteadOfValues()
    {
        DataPacks.Entry entry = Packs().Load("common.id.uuid", "en");
        Assert.True(entry.IsGenerator);
        Assert.Empty(entry.Values);
        Assert.Contains("<gen", entry.Generator);
    }

    [Fact]
    public void AnUnknownAddressSaysWhatItLookedFor()
    {
        ArgumentException e = Assert.Throws<ArgumentException>(
            () => Packs().Load("person.nosuchthing", "en"));
        Assert.Contains("en/person/nosuchthing.txt", e.Message);
    }
}

/// <summary>
/// The starter packs compiled into the assembly.
/// </summary>
/// <remarks>
/// A NuGet package has nothing above it, so looking beside the assembly and walking up for
/// <c>data/packs</c> cannot work in <c>~/.nuget/packages</c>. The package built before this
/// carried 0 data files and threw on the first <c>type="template"</c> — while all 775 tests were
/// green, because every test runs inside the repository.
/// <para>
/// These assert the SHAPE of the embedded source. Whether the packed .nupkg actually carries
/// anything is a question no in-repo test can answer, so <c>scripts/verify-package.mjs</c> packs
/// it, installs it outside the repository and runs one.
/// </para>
/// </remarks>
public class EmbeddedPacksTest
{
    [Fact]
    public void ACheckoutEmbedsNothingAndReadsTheRepositoryInstead()
    {
        // `bundle-packs.mjs add` stages the packs only for packing, and `remove` clears them. A
        // checkout that had them embedded would be reading a stale copy of packs that live once.
        Assert.True(
            EmbeddedSource.IsEmpty,
            "a checkout must not carry a second copy of the packs; run "
                + "`node scripts/bundle-packs.mjs remove`");
    }

    [Fact]
    public void AnEmptyEmbeddedSourceAnswersNothingRatherThanWrongly()
    {
        // The dangerous failure is not "no data" — it is an empty source that claims to have an
        // address and hands back nothing.
        var source = new EmbeddedSource();
        Assert.False(source.Has("en/person/lastName.txt"));
        Assert.Empty(source.ReadLines("en/person/lastName.txt"));
        Assert.Empty(source.ListFiles());
        Assert.False(source.HasTopLevel("en"));
        Assert.False(source.HasCountry("usa"));
    }
}
