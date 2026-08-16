using Tdcv2.Engine;
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
/// A pack generator that draws from a WEIGHTED list has to see the whole column.
/// </summary>
/// <remarks>
/// A weighted list is laid out to an exact Hamilton quota over the run, so each value takes its
/// measured share of the rows. Asked for ONE row that plan is computed over a column of one and the
/// single row goes to the largest share — every time, for every seed. A pack generator is resolved
/// a row at a time unless it is marked whole-column, and the mark used to be set only when the pack
/// body wrote <c>percent=</c> itself, which a body that merely draws
/// <c>value="hu.person.lastName"</c> never does.
/// <para>
/// Twelve shipped full-name packs came out of that as one repeated name: eight rows of
/// <c>hu.person.male.fullName</c> were eight copies of "Nagy László". German and Polish full names
/// were correct, and the only difference is that their name lists carry no weights — which is why
/// they are here too, as the case the fix must NOT touch: marking them would cost them the
/// streaming engines for nothing.
/// </para>
/// </remarks>
public class WeightedPackGeneratorTest
{
    /// <summary>The shipped packs whose bodies reach a weighted list, and the locale each needs.</summary>
    public static TheoryData<string, string> DrawsWeights() => new()
    {
        { "hu", "hu.person.male.fullName" },
        { "hu", "hu.person.female.fullName" },
        { "cs", "cs.person.male.fullName" },
        { "cs", "cs.person.female.fullName" },
        { "nl", "nl.person.male.fullName" },
        { "nl", "nl.person.female.fullName" },
        { "sr", "sr.person.male.fullName" },
        { "sr", "sr.person.female.fullName" },
        { "fa", "fa.person.male.fullName" },
        { "fa", "fa.person.female.fullName" },
        { "he", "he.person.male.fullName" },
        { "he", "he.person.female.fullName" },
        { "zh-cn", "china.geo.streetName" },
    };

    /// <summary>The same shape over name lists that carry no weights.</summary>
    public static TheoryData<string, string> DrawsNoWeights() => new()
    {
        { "de", "de.person.male.fullName" },
        { "pl", "pl.person.male.fullName" },
    };

    [Theory]
    [MemberData(nameof(DrawsWeights))]
    public void APackReachingAWeightedListIsWholeColumn(string locale, string address)
    {
        Assert.True(
            DataPacks.Discover().NeedsWholeColumn(address, locale),
            address + " draws from a weighted list and must be marked whole-column");

        // The mark is only useful if it reaches the router: a config naming this pack belongs to
        // the engine that holds the column, not to one that resolves a row at a time.
        Assert.Equal(1, Probe(locale, address).Engine);

        // And the point of all of it — eight rows that are not eight copies of one name.
        Assert.True(
            Distinct(locale, address) > 1,
            address + " returned the same value on every row");
    }

    /// <summary>
    /// Asked for the streaming engine outright, such a pack is refused rather than repeated.
    /// </summary>
    /// <remarks>
    /// The two halves of one rule. Engine 2 cannot apportion a quota row by row, and a caller who
    /// named that engine asked to be told so — emitting one value six times would hide exactly what
    /// they asked about. Engine 3 named no engine: it catches the refusal while the column is being
    /// built and finishes the run in memory, which is why the refusal has to be raised there and not
    /// inside the per-row resolver, where it would arrive after the fallback's catch is gone.
    /// </remarks>
    [Theory]
    [MemberData(nameof(DrawsWeights))]
    public void StreamingRefusesItAndTheExactEngineFallsBack(string locale, string address)
    {
        Assert.Throws<StreamEngine.UnsupportedHere>(() => Probe(locale, address, 2).ToString());
        Assert.Equal(Probe(locale, address).ToString(), Probe(locale, address, 3).ToString());
    }

    [Theory]
    [MemberData(nameof(DrawsNoWeights))]
    public void APackOverPlainListsStaysPerRow(string locale, string address)
    {
        Assert.False(
            DataPacks.Discover().NeedsWholeColumn(address, locale),
            address + " draws from no weighted list and must keep the streaming engines");
        Assert.Equal(2, Probe(locale, address).Engine);
        Assert.Equal(8, Distinct(locale, address));

        // Nothing here is apportioned, so nothing is refused: the streaming engine answers it.
        Assert.Equal(8, Rows(Probe(locale, address, 2)).Distinct(StringComparer.Ordinal).Count());
    }

    /// <summary>
    /// Two generators that reference each other answer instead of recursing for ever.
    /// </summary>
    /// <remarks>
    /// The pack loader reports a reference cycle as its own error; this walk only has to stop. A
    /// ring is reachable from any config that names one of its packs, so without the guard the
    /// answer would be a stack overflow rather than a diagnostic.
    /// </remarks>
    [Fact]
    public void AReferenceRingStopsInsteadOfRecursing()
    {
        string root = Path.Combine(Path.GetTempPath(), "tdc-pack-ring");
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }

        Directory.CreateDirectory(Path.Combine(root, "xx"));
        File.WriteAllText(Path.Combine(root, "xx", "a.tdc"), Ring("xx.b"));
        File.WriteAllText(Path.Combine(root, "xx", "b.tdc"), Ring("xx.a"));

        var packs = new DataPacks(root);
        Assert.False(packs.NeedsWholeColumn("xx.a", "xx"));
        Assert.False(packs.NeedsWholeColumn("xx.b", "xx"));

        Directory.Delete(root, recursive: true);
    }

    private static string Ring(string reference) =>
        "---\ngenerator: tdc\nlocale: xx\n---\n"
        + "<sequence name=\"s\"><gen type=\"template\" value=\"" + reference + "\"/></sequence>\n"
        + "<data>${{s}}</data>\n";

    /// <summary>
    /// Eight rows of one pack, on the named engine or on whichever one the router picks.
    /// </summary>
    private static Tdc Probe(string locale, string address, int? engine = null) =>
        new(new Tdc.Options
        {
            ConfigString =
                "<tdc><env count=\"8\" seed=\"probe\" local=\"" + locale + "\">"
                + "<sequence name=\"P\"><gen type=\"template\" value=\"" + address + "\"/></sequence>"
                + "</env><block><line><data>${{P}}</data></line></block></tdc>",
            Engine = engine,
        });

    private static IEnumerable<string> Rows(Tdc run) =>
        run.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private static int Distinct(string locale, string address) =>
        Rows(Probe(locale, address)).Distinct(StringComparer.Ordinal).Count();
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

    /// <summary>
    /// Which folder the packs come out of, before any config or command line adds to it.
    /// </summary>
    /// <remarks>
    /// One rule in all five implementations: <c>TDCV2_PACKS</c>, then the source checkout this
    /// build came from, then the starter set inside the artefact. What is worth testing is the
    /// middle one — the step that used to differ between implementations, and the step that can
    /// capture the wrong folder if the marker is dropped.
    /// </remarks>
    [Fact]
    public void DiscoveryFindsTheRepositoryThisBuildCameFrom()
    {
        string? found = DataPacks.SourceCheckoutPacks(AppContext.BaseDirectory);
        Assert.NotNull(found);
        Assert.Equal("packs", Path.GetFileName(found));
        Assert.Equal("data", Path.GetFileName(Path.GetDirectoryName(found)));
    }

    [Fact]
    public void DiscoveryRefusesADataPacksThatIsNotThisRepository()
    {
        // The point of the marker. Without it an unrelated data/packs above an installed package
        // would answer, and the same config would then read different data depending on where the
        // user happened to install it.
        string root = Path.Combine(Path.GetTempPath(), "tdc-discovery-stranger");
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }

        Directory.CreateDirectory(Path.Combine(root, "data", "packs", "en"));
        string deep = Path.Combine(root, "project", "deep");
        Directory.CreateDirectory(deep);

        Assert.Null(DataPacks.SourceCheckoutPacks(deep));

        Directory.Delete(root, recursive: true);
    }

    [Fact]
    public void DiscoveryAcceptsACheckoutFromAnyDepthBelowIt()
    {
        string root = Path.Combine(Path.GetTempPath(), "tdc-discovery-checkout");
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }

        Directory.CreateDirectory(Path.Combine(root, "data", "packs"));
        Directory.CreateDirectory(Path.Combine(root, "fixtures", "cross-language"));
        string deep = Path.Combine(root, "a", "b", "c");
        Directory.CreateDirectory(deep);

        Assert.Equal(Path.Combine(root, "data", "packs"), DataPacks.SourceCheckoutPacks(deep));

        Directory.Delete(root, recursive: true);
    }
}
