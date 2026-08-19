using System.Collections.Generic;
using System.Linq;
using Tdcv2.Packs;
using Tdcv2.Quick;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The quick API: one value, one call, no config.
/// </summary>
/// <remarks>
/// The values are pinned to the TypeScript implementation's, not merely to themselves. That is
/// the point of the feature existing here at all — a name in a C# unit test and a name in a
/// TypeScript fixture should come from the same list, in the same order, under the same seed.
/// The constants below were read out of the published npm package.
/// </remarks>
public class QuickTest
{
    private static dynamic Demo() => Quick.Quick.Seed("demo").locale("en");

    [Fact]
    public void AgreesWithTheTypeScriptImplementation()
    {
        dynamic demo = Demo();
        Assert.Equal("Jones", demo.person.lastName());
        Assert.Equal("Robert", demo.person.male.firstName());
        Assert.Equal("Pharmaceuticals", demo.company.industry());
        Assert.Equal("3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9", demo.common.id.uuid());
        Assert.Equal("DE62299399441396459682", demo.common.finance.iban());
        Assert.Equal("699209702", demo.country.usa.docs.ssn());
    }

    [Fact]
    public void ACallTakesTheNextValueRatherThanReRenderingRowOne()
    {
        // The bug this prevents: a call that means "render one row" returns the same value
        // forever, so a loop of calls produces one name repeated.
        dynamic demo = Demo();
        var drawn = new List<string>();
        for (int i = 0; i < 5; i++)
        {
            drawn.Add(demo.person.lastName());
        }

        Assert.Equal(new[] { "Jones", "Bush", "Armstrong", "Andrews", "Jimenez" }, drawn);
    }

    [Fact]
    public void ManyIsTheSameStreamAsRepeatedCalls()
    {
        dynamic demo = Demo();
        IReadOnlyList<string> five = demo.person.lastName.many(5);
        Assert.Equal(new[] { "Jones", "Bush", "Armstrong", "Andrews", "Jimenez" }, five);
    }

    [Fact]
    public void AddressesDrawIndependentlyOfEachOther()
    {
        // Two addresses are two streams: reading one must not advance the other.
        dynamic demo = Demo();
        demo.company.industry();
        demo.company.industry();
        Assert.Equal("Jones", demo.person.lastName());
    }

    [Fact]
    public void TheStreamContinuesPastOneBatch()
    {
        // BatchRows values come from one underlying run; the next batch reopens under a derived
        // seed. That boundary is where two implementations drift, so these four straddle it and
        // are pinned to the TypeScript output.
        dynamic batch = Quick.Quick.Seed("batch").locale("en");
        IReadOnlyList<string> many = batch.person.lastName.many(QuickDraw.BatchRows + 88);
        Assert.Equal(QuickDraw.BatchRows + 88, many.Count);
        Assert.Equal(new[] { "Nguyen", "Miller", "Gilbert", "Reyes" }, many.Skip(510).Take(4));
    }

    [Fact]
    public void SeedAndLocaleReturnANewObject()
    {
        // Two tests must be able to hold two seeds at once without either leaking into the other.
        dynamic one = Quick.Quick.Seed("a").locale("en");
        dynamic two = Quick.Quick.Seed("b").locale("en");
        string firstOfOne = one.person.lastName();
        Assert.NotEqual(firstOfOne, (string)two.person.lastName());

        // The stream belongs to the OBJECT, not to the seed.
        Assert.NotEqual(firstOfOne, (string)one.person.lastName());
        Assert.Equal(firstOfOne, (string)Quick.Quick.Seed("a").locale("en").person.lastName());
    }

    [Fact]
    public void TheLocaleDecidesWhatABareAddressMeans()
    {
        string english = Quick.Quick.Seed("l").locale("en").person.lastName();
        Assert.All(english, c => Assert.True(c < 128));
    }

    [Fact]
    public void AGeneratorTakesABareValueString()
    {
        Assert.Equal("66", Quick.Quick.Seed("demo").gen.number("18..80"));
        Assert.Equal(
            new[] { "332", "591", "349", "665" },
            (IReadOnlyList<string>)Quick.Quick.Seed("x").gen.number.many(4, "1..1000"));
    }

    [Fact]
    public void AMisspelledAddressNamesTheNearestOne()
    {
        var draw = new QuickDraw("e", "en");
        var caught = Assert.Throws<TdcQuickException>(() =>
            draw.Draw("template", new Dictionary<string, string> { ["value"] = "usa.docs.sn" }, 1));
        Assert.Contains("Did you mean \"usa.docs.ssn\"", caught.Message);
    }

    [Fact]
    public void AMissingPackSaysSoInsteadOfProposingAnotherLanguage()
    {
        // A build carries common/en/usa; the rest are downloaded. Answering
        // `x-pseudo.person.lastName` with "did you mean en.person.lastName?" offers English to
        // someone who asked for a language nobody has installed.
        var draw = new QuickDraw("m", "en");
        var caught = Assert.Throws<TdcQuickException>(() =>
            draw.Draw(
                "template",
                new Dictionary<string, string> { ["value"] = "x-pseudo.person.lastName" },
                1));
        Assert.Contains("\"x-pseudo\" pack is not installed", caught.Message);
        Assert.Contains("tdcv2 pack add x-pseudo", caught.Message);
        Assert.DoesNotContain("Did you mean", caught.Message);
    }

    [Fact]
    public void ACountThatIsNotAPositiveWholeNumber()
    {
        var draw = new QuickDraw("c", "en");
        Assert.Throws<TdcQuickException>(() =>
            draw.Draw("template", new Dictionary<string, string> { ["value"] = "person.lastName" }, 0));
    }

    [Fact]
    public void NoBundledAddressCollidesWithAReservedName()
    {
        // The API answers to these words, so a pack category called one of them would be
        // unreachable. This says so when the pack is added rather than when a user cannot
        // reach it.
        IReadOnlyCollection<string> addresses = DataPacks.Discover().AddressList();
        var roots = addresses.Select(a => a.Split('.')[0]).ToHashSet();
        foreach (string reserved in Quick.Quick.ReservedRootNames)
        {
            if (reserved is "lang" or "country")
            {
                continue;
            }

            Assert.DoesNotContain(reserved, roots);
        }

        var segments = addresses.SelectMany(a => a.Split('.')).ToHashSet();
        foreach (string reserved in Quick.Quick.ReservedPathNames)
        {
            Assert.DoesNotContain(reserved, segments);
        }
    }

    /// <summary>
    /// The one file all five implementations answer to.
    /// </summary>
    /// <remarks>
    /// The constants above say what the values are; this says that the OTHER FOUR agree, because
    /// every implementation reads this same file. It is generated from the reference, so a change
    /// to the batch size, the derived seed or the synthesised config shows up here in whichever
    /// implementation made it — rather than in a user's diff six months later.
    /// </remarks>
    [Fact]
    public void MatchesTheSharedQuickVectors()
    {
        string path = System.IO.Path.Combine(PrngVectorsTest.FixturesDir(), "quick-vectors.json");
        using System.Text.Json.JsonDocument document =
            System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(path));
        System.Text.Json.JsonElement root = document.RootElement;

        Assert.Equal(QuickDraw.BatchRows, root.GetProperty("batchRows").GetInt32());

        foreach (System.Text.Json.JsonElement c in root.GetProperty("addresses").EnumerateArray())
        {
            string seed = c.GetProperty("seed").GetString()!;
            string locale = c.GetProperty("locale").GetString()!;
            string address = c.GetProperty("address").GetString()!;
            int count = c.GetProperty("count").GetInt32();
            var expected = c.GetProperty("expected").EnumerateArray()
                .Select(v => v.GetString()!).ToList();

            var draw = new QuickDraw(seed, locale);
            IReadOnlyList<string> drawn = draw.Draw(
                "template",
                new Dictionary<string, string> { ["value"] = address },
                count);
            Assert.Equal(expected, drawn);
        }

        foreach (System.Text.Json.JsonElement c in root.GetProperty("generators").EnumerateArray())
        {
            string seed = c.GetProperty("seed").GetString()!;
            string type = c.GetProperty("type").GetString()!;
            int count = c.GetProperty("count").GetInt32();
            var attrs = new Dictionary<string, string>(System.StringComparer.Ordinal);
            foreach (System.Text.Json.JsonProperty a in c.GetProperty("attrs").EnumerateObject())
            {
                attrs[a.Name] = a.Value.GetString()!;
            }

            var expected = c.GetProperty("expected").EnumerateArray()
                .Select(v => v.GetString()!).ToList();
            Assert.Equal(expected, new QuickDraw(seed, null).Draw(type, attrs, count));
        }
    }
}
