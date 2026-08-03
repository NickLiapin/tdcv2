using System.Text.Json;
using Tdcv2.Packs;

namespace Tdcv2.Tests;

/// <summary>
/// The pack store's books, and the move that upgrades a store written by an older tdcv2.
/// </summary>
/// <remarks>
/// <para>
/// None of this touches the network, which is the point of it living apart from the download: what
/// the index means, which paths a bundle owns, what the record says and what the migration would
/// do are all decidable from a temporary folder.
/// </para>
/// <para>
/// Before the flat store, <c>pack add</c> unpacked to <c>&lt;store&gt;/&lt;id&gt;/packs/…</c> and
/// wrote one <c>dataPaths</c> entry per bundle. Anyone who installed a pack has that on disk and in
/// their config, and neither <c>list</c> nor <c>remove</c> can read it any more — so the migration
/// tests here are the ones that stand between an existing user and a store they would otherwise
/// have to delete and download again.
/// </para>
/// </remarks>
public class PackStoreTest
{
    private const string ValidIndex =
        "{\"schemaVersion\": 1, \"description\": \"test\", \"bundles\": [{"
        + "\"id\": \"en\", \"name\": \"English (language)\", \"description\": \"US data\", "
        + "\"file\": \"bundles/en.zip\", \"bytes\": 100, \"sha256\": \"ABCD\", "
        + "\"locale\": \"en\", \"contents\": [\"packs/en\"]}]}";

    private static string Tmp() =>
        Directory.CreateDirectory(
            Path.Combine(Path.GetTempPath(), "tdcpack-" + Guid.NewGuid().ToString("N"))).FullName;

    private static PackStore.InstalledBundle Entry(string id, params string[] paths) =>
        new(id, paths, "", "aa", 2);

    private static void Put(string path, string body)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, body);
    }

    // ── the index ────────────────────────────────────────────────────────────────────────────

    [Fact]
    public void ParsesAValidIndexAndLowerCasesTheHash()
    {
        PackRegistry.Index index = PackRegistry.ParseIndex(ValidIndex);
        Assert.Equal(1, index.SchemaVersion);
        PackRegistry.Bundle bundle = Assert.Single(index.Bundles);
        Assert.Equal("en", bundle.Id);
        Assert.Equal("abcd", bundle.Sha256);
        Assert.Equal(new[] { "packs/en" }, bundle.Contents);
        Assert.Equal("English (language)", index.Find("en").Name);
    }

    [Fact]
    public void KeepsWhateverTheRegistryCalledTheRevision()
    {
        // Today's index declares no version and the digest already tells two revisions apart, so
        // the field is optional — but a registry that starts versioning its bundles has to be
        // understood without a new client.
        Assert.Null(PackRegistry.ParseIndex(ValidIndex).Bundles[0].Version);
        Assert.Equal(
            "2026.07",
            PackRegistry.ParseIndex(ValidIndex.Replace(
                "\"locale\": \"en\"", "\"version\": \"2026.07\", \"locale\": \"en\""))
                .Bundles[0].Version);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("{not json")]
    [InlineData("{\"bundles\": []}")]
    [InlineData("{\"schemaVersion\": 1, \"bundles\": {}}")]
    public void RefusesAnIndexItCannotTrust(string text) =>
        Assert.Throws<PackRegistry.PackException>(() => PackRegistry.ParseIndex(text));

    [Fact]
    public void RefusesAnUnsupportedSchemaVersion() =>
        Assert.Contains(
            "unsupported schemaVersion 2",
            Assert.Throws<PackRegistry.PackException>(
                () => PackRegistry.ParseIndex("{\"schemaVersion\": 2, \"bundles\": []}")).Message);

    [Fact]
    public void RefusesABundleMissingAFieldOrCarryingANegativeSize()
    {
        Assert.Contains(
            "sha256",
            Assert.Throws<PackRegistry.PackException>(() => PackRegistry.ParseIndex(
                "{\"schemaVersion\": 1, \"bundles\": ["
                + "{\"id\": \"x\", \"name\": \"X\", \"file\": \"f.zip\", \"bytes\": 1}]}")).Message);
        Assert.Contains(
            "bytes",
            Assert.Throws<PackRegistry.PackException>(() => PackRegistry.ParseIndex(
                "{\"schemaVersion\": 1, \"bundles\": [{\"id\": \"x\", \"name\": \"X\", "
                + "\"file\": \"f.zip\", \"bytes\": -1, \"sha256\": \"a\"}]}")).Message);
    }

    [Fact]
    public void NamesWhatThereIsWhenAnIdIsUnknown() =>
        Assert.Contains(
            "Available: en",
            Assert.Throws<PackRegistry.PackException>(
                () => PackRegistry.ParseIndex(ValidIndex).Find("nope")).Message);

    // ── the record ───────────────────────────────────────────────────────────────────────────

    [Fact]
    public void IsEmptyForAMissingStore() =>
        Assert.Empty(PackStore.InstalledIds(Path.Combine(Tmp(), "nope")));

    [Fact]
    public void RoundTripsThroughTheDotfileWithIdsSorted()
    {
        string store = Tmp();
        PackStore.Write(
            store,
            new PackStore.InstalledRecord(
                1, new[] { Entry("usa", "countries/usa"), Entry("en", "en") }));

        Assert.Equal(new[] { "en", "usa" }, PackStore.InstalledIds(store));
        Assert.Equal(new[] { "en" }, PackStore.Read(store).Bundles[0].Paths);

        // The name matters: the store is a scan root, and the loader skips ignored NAMES, so
        // anything without a leading dot here would load as a pack at address `installed`.
        Assert.StartsWith(".", PackStore.InstalledFile);
        Assert.True(IPackSource.IsIgnoredEntry(PackStore.InstalledFile));
        Assert.EndsWith("\n", File.ReadAllText(PackStore.InstalledFilePath(store)));
    }

    [Fact]
    public void WritesTheSameBytesTheOtherImplementationsWrite()
    {
        // Five implementations write this file and any of them may be the one that wrote it, so
        // the indent, the key order and the trailing newline are part of the contract.
        string store = Tmp();
        PackStore.Write(
            store,
            new PackStore.InstalledRecord(
                1, new[] { new PackStore.InstalledBundle("demo", new[] { "demo/person" }, "", "", 1) }));

        Assert.Equal(
            "{\n"
            + "  \"schemaVersion\": 1,\n"
            + "  \"bundles\": [\n"
            + "    {\n"
            + "      \"id\": \"demo\",\n"
            + "      \"paths\": [\n"
            + "        \"demo/person\"\n"
            + "      ],\n"
            + "      \"version\": \"\",\n"
            + "      \"sha256\": \"\",\n"
            + "      \"files\": 1\n"
            + "    }\n"
            + "  ]\n"
            + "}\n",
            File.ReadAllText(PackStore.InstalledFilePath(store)));
    }

    [Fact]
    public void ATreeNobodyRecordedIsNotInstalled()
    {
        string store = Tmp();
        Directory.CreateDirectory(Path.Combine(store, "en", "person"));
        Assert.Empty(PackStore.InstalledIds(store));
    }

    [Fact]
    public void RefusesARecordThatClaimsAPathOutsideTheStore()
    {
        string store = Tmp();
        File.WriteAllText(
            PackStore.InstalledFilePath(store),
            "{\"schemaVersion\": 1, \"bundles\": [{\"id\": \"evil\", \"paths\": [\"../../etc\"]}]}");
        Assert.Contains(
            "outside the store",
            Assert.Throws<PackRegistry.PackException>(() => PackStore.Read(store)).Message);
    }

    [Fact]
    public void RefusesAMalformedRecordRatherThanReportingAnEmptyStore()
    {
        // "Nothing is installed" would make `pack remove` claim there is nothing to delete while
        // the files sit there.
        string store = Tmp();
        File.WriteAllText(PackStore.InstalledFilePath(store), "{ not json");
        Assert.Throws<PackRegistry.PackException>(() => PackStore.Read(store));
    }

    [Fact]
    public void RefusesARecordFromANewerTdcv2()
    {
        string store = Tmp();
        File.WriteAllText(
            PackStore.InstalledFilePath(store), "{\"schemaVersion\": 2, \"bundles\": []}");
        Assert.Contains(
            "newer tdcv2",
            Assert.Throws<PackRegistry.PackException>(() => PackStore.Read(store)).Message);
    }

    [Fact]
    public void ReadsAnAbsentVersionSha256AndCountAsNothing()
    {
        string store = Tmp();
        File.WriteAllText(
            PackStore.InstalledFilePath(store),
            "{\"schemaVersion\": 1, \"bundles\": [{\"id\": \"en\", \"paths\": [\"en\"]}]}");
        PackStore.InstalledBundle bundle = Assert.Single(PackStore.Read(store).Bundles);
        Assert.Equal("", bundle.Version);
        Assert.Equal("", bundle.Sha256);
        Assert.Equal(0, bundle.Files);
    }

    [Fact]
    public void ReplacesTheSameIdAndDropsItAgain()
    {
        PackStore.InstalledRecord one = PackStore.With(
            new PackStore.InstalledRecord(1, Array.Empty<PackStore.InstalledBundle>()),
            Entry("en", "en"));
        PackStore.InstalledRecord again =
            PackStore.With(one, Entry("en", "en") with { Files = 9 });
        Assert.Equal(9, Assert.Single(again.Bundles).Files);
        Assert.Empty(PackStore.Without(again, "en").Bundles);
    }

    // ── what a bundle owns ───────────────────────────────────────────────────────────────────

    [Fact]
    public void ClaimsTheOneSubtreeABundleFills() =>
        Assert.Equal(
            new[] { "ru" },
            PackStore.OwnedPaths(new[] { "ru/person/lastName.txt", "ru/city/name.txt" }));

    [Fact]
    public void ClaimsTheCountryNeverTheSharedCountriesFolderAboveIt() =>
        Assert.Equal(
            new[] { "countries/russia" },
            PackStore.OwnedPaths(
                new[] { "countries/russia/docs/inn.txt", "countries/russia/tax/x.txt" }));

    [Fact]
    public void ClaimsEachTopLevelEntryWhenTheFilesShareNoParent() =>
        Assert.Equal(
            new[] { "countries", "en" },
            PackStore.OwnedPaths(new[] { "en/a.txt", "countries/usa/b.txt" }));

    [Fact]
    public void ClaimsALoneFileAtTheRootAsItself() =>
        Assert.Equal(new[] { "loose.txt" }, PackStore.OwnedPaths(new[] { "loose.txt" }));

    [Fact]
    public void ClaimsNoMoreThanTheBundleActuallyFills() =>
        // A one-file country stub owns the folder holding that file, not the whole country — the
        // answer follows the files, so removal can never take more than the bundle brought.
        Assert.Equal(
            new[] { "countries/andorra/docs" },
            PackStore.OwnedPaths(new[] { "countries/andorra/docs/nid.txt" }));

    [Fact]
    public void OwnsNothingWhenThereAreNoFiles() =>
        Assert.Empty(PackStore.OwnedPaths(Array.Empty<string>()));

    [Fact]
    public void AcceptsANestedPathAndTheRootItselfAndRefusesAnEscape()
    {
        Assert.True(PackStore.IsInside("/a/b/c", "/a/b"));
        Assert.True(PackStore.IsInside("/a/b", "/a/b"));
        Assert.False(PackStore.IsInside("/a/b/../../etc/passwd", "/a/b"));
        Assert.False(PackStore.IsInside("/other", "/a/b"));
    }

    // ── the config's dataPaths ───────────────────────────────────────────────────────────────

    private static string WriteConfig(string dir, string body)
    {
        string path = Path.Combine(dir, ProjectConfig.ProjectConfigName);
        File.WriteAllText(path, body);
        return path;
    }

    private static string[] DataPaths(string configPath) =>
        JsonDocument.Parse(File.ReadAllText(configPath)).RootElement
            .GetProperty("dataPaths").EnumerateArray().Select(e => e.GetString()!).ToArray();

    [Fact]
    public void AddsTheStoreAsARelativePathAndKeepsOtherSettings()
    {
        string dir = Tmp();
        string cfg = WriteConfig(dir, "{\n  \"packStore\": \"./tdcv2-packs\",\n  \"locale\": \"en\"\n}\n");

        string stored = ProjectConfig.StoredPath(cfg, Path.Combine(dir, "tdcv2-packs"));
        Assert.True(ProjectConfig.Register(cfg, new[] { Path.Combine(dir, "tdcv2-packs") }));
        Assert.Equal("./tdcv2-packs", stored);

        JsonElement after = JsonDocument.Parse(File.ReadAllText(cfg)).RootElement;
        Assert.Equal(new[] { "./tdcv2-packs" }, DataPaths(cfg));
        Assert.Equal("./tdcv2-packs", after.GetProperty("packStore").GetString());
        Assert.Equal("en", after.GetProperty("locale").GetString());
    }

    [Fact]
    public void AddsNoSecondEntryForASecondBundleOrAnAbsoluteSpelling()
    {
        string dir = Tmp();
        string cfg = WriteConfig(dir, "{\n  \"dataPaths\": [\n    \"./p\"\n  ]\n}\n");
        Assert.False(ProjectConfig.Register(cfg, new[] { Path.Combine(dir, "p") }));
        Assert.Equal(new[] { "./p" }, DataPaths(cfg));
    }

    [Fact]
    public void RefusesAMalformedConfig()
    {
        string dir = Tmp();
        string cfg = WriteConfig(dir, "{ not json");
        Assert.Throws<ProjectConfig.ConfigException>(
            () => ProjectConfig.Register(cfg, new[] { Path.Combine(dir, "p") }));
    }

    [Fact]
    public void DropsTheStoreAndLeavesTheRestAlone()
    {
        string dir = Tmp();
        string cfg = WriteConfig(
            dir, "{\n  \"dataPaths\": [\n    \"./p\",\n    \"./my-own-lists\"\n  ]\n}\n");
        Assert.True(ProjectConfig.Unregister(cfg, new[] { Path.Combine(dir, "p") }));
        Assert.Equal(new[] { "./my-own-lists" }, DataPaths(cfg));
    }

    [Fact]
    public void UnregisteringIsANoOpWhenTheStoreIsNotThere()
    {
        string dir = Tmp();
        string cfg = WriteConfig(dir, "{\n  \"dataPaths\": [\n    \"./elsewhere\"\n  ]\n}\n");
        Assert.False(ProjectConfig.Unregister(cfg, new[] { Path.Combine(dir, "p") }));
        Assert.Equal(new[] { "./elsewhere" }, DataPaths(cfg));
    }

    [Fact]
    public void DropsThePerBundleEntriesAndKeepsTheStoreAndEverythingOutsideIt()
    {
        string dir = Tmp();
        string cfg = WriteConfig(
            dir,
            "{\n  \"dataPaths\": [\n    \"./p/en/packs\",\n    \"./p/usa/packs\",\n"
            + "    \"./p\",\n    \"./my-own-lists\"\n  ]\n}\n");
        Assert.Equal(2, ProjectConfig.UnregisterInside(cfg, Path.Combine(dir, "p")));
        Assert.Equal(new[] { "./p", "./my-own-lists" }, DataPaths(cfg));
    }

    // ── the move to the flat layout ──────────────────────────────────────────────────────────

    /// <summary>A project as the old <c>pack add ru russia</c> left it.</summary>
    /// <remarks>
    /// Two bundle folders, each with its own <c>packs/</c> root, and two <c>dataPaths</c> entries
    /// pointing inside them.
    /// </remarks>
    private static (string Dir, string Cfg, string Store) OldProject(
        IReadOnlyDictionary<string, string>? extra = null)
    {
        string dir = Tmp();
        string store = Path.Combine(dir, "tdcv2-packs");
        string cfg = Path.Combine(dir, ProjectConfig.ProjectConfigName);
        Put(Path.Combine(store, "ru/packs/ru/person/lastName.txt"), "---\nlocale: ru\n---\nИванов\n");
        Put(Path.Combine(store, "ru/packs/ru/city/name.txt"), "---\nlocale: ru\n---\nОмск\n");
        Put(Path.Combine(store, "ru/packs/ru/_locale.json"), "{\"code\":\"ru\"}\n");
        Put(
            Path.Combine(store, "russia/packs/countries/russia/docs/inn.txt"),
            "---\naddress: russia.docs.inn\n---\n7707083893\n");
        Put(
            Path.Combine(store, "russia/packs/countries/russia/bank/bic.txt"),
            "---\naddress: russia.bank.bic\n---\n044525225\n");
        foreach (KeyValuePair<string, string> file in extra ?? new Dictionary<string, string>())
        {
            Put(Path.Combine(store, file.Key), file.Value);
        }

        File.WriteAllText(
            cfg,
            "{\n  \"packStore\": \"./tdcv2-packs\",\n  \"locale\": \"ru\",\n"
            + "  \"dataPaths\": [\n    \"./tdcv2-packs/ru/packs\",\n"
            + "    \"./tdcv2-packs/russia/packs\"\n  ],\n  \"keepThis\": true\n}\n");
        return (dir, cfg, store);
    }

    [Fact]
    public void RecognisesTheOldLayoutAndLeavesAFlatStoreAlone()
    {
        (string _, string _, string store) = OldProject();
        Assert.Equal(new[] { "ru", "russia" }, PackStore.LegacyBundleIds(store));

        string flat = Tmp();
        Directory.CreateDirectory(Path.Combine(flat, "ru"));
        Assert.Empty(PackStore.LegacyBundleIds(flat));
    }

    [Fact]
    public void MovesEachTreeUpRecordsItAndLeavesOneDataPathsEntry()
    {
        (string _, string cfg, string store) = OldProject();

        PackStore.StoreMigration? result = PackStore.Migrate(store, cfg);
        Assert.NotNull(result);

        // On disk: the address path and nothing above it.
        Assert.Contains(
            "Иванов", File.ReadAllText(Path.Combine(store, "ru/person/lastName.txt")));
        Assert.True(File.Exists(Path.Combine(store, "ru/_locale.json"))); // travels with its locale
        Assert.True(File.Exists(Path.Combine(store, "countries/russia/docs/inn.txt")));
        Assert.False(Directory.Exists(Path.Combine(store, "ru/packs")));
        Assert.False(Directory.Exists(Path.Combine(store, "russia")));

        // In the books: who owns what.
        PackStore.InstalledRecord record = PackStore.Read(store);
        Assert.Equal(new[] { "ru", "russia" }, record.Bundles.Select(b => b.Id));
        Assert.Equal(new[] { "ru" }, record.Bundles[0].Paths);
        Assert.Equal(new[] { "countries/russia" }, record.Bundles[1].Paths);
        // Nothing to claim about an archive nobody kept.
        Assert.Equal("", record.Bundles[0].Sha256);
        Assert.Equal(3, record.Bundles[0].Files);

        // In the config: two per-bundle entries out, the store in, everything else kept.
        JsonElement after = JsonDocument.Parse(File.ReadAllText(cfg)).RootElement;
        Assert.Equal(new[] { "./tdcv2-packs" }, DataPaths(cfg));
        Assert.True(after.GetProperty("keepThis").GetBoolean());
        Assert.Equal("ru", after.GetProperty("locale").GetString());
        Assert.Equal(2, result!.DroppedDataPaths);
        Assert.Equal("./tdcv2-packs", result.Registered);
    }

    [Fact]
    public void IsANoOpTheSecondTime()
    {
        (string _, string cfg, string store) = OldProject();
        PackStore.Migrate(store, cfg);
        Assert.Null(PackStore.Migrate(store, cfg));
    }

    [Fact]
    public void LeavesFilesThatWereNeverPackDataWhereTheyAreAndSaysSo()
    {
        (string _, string cfg, string store) = OldProject(
            new Dictionary<string, string> { ["ru/sources/lastName.csv"] = "Иванов,100\n" });
        PackStore.StoreMigration? result = PackStore.Migrate(store, cfg);
        Assert.Equal(new[] { "ru/sources/lastName.csv" }, result!.Leftovers);
        Assert.True(File.Exists(Path.Combine(store, "ru/sources/lastName.csv")));
        Assert.True(File.Exists(Path.Combine(store, "ru/person/lastName.txt")));
    }

    [Fact]
    public void RefusesMovingNothingWhenADestinationIsAlreadyTaken()
    {
        (string _, string cfg, string store) = OldProject();
        // Something already sits where `ru` has to land.
        Put(Path.Combine(store, "ru/person/lastName.txt"), "somebody else\n");

        Assert.Contains(
            "collide",
            Assert.Throws<PackRegistry.PackException>(() => PackStore.Migrate(store, cfg)).Message);

        // The old tree is untouched, so the user can look and decide.
        Assert.True(File.Exists(Path.Combine(store, "ru/packs/ru/person/lastName.txt")));
        Assert.Equal(
            "somebody else\n", File.ReadAllText(Path.Combine(store, "ru/person/lastName.txt")));
        Assert.Equal(
            new[] { "./tdcv2-packs/ru/packs", "./tdcv2-packs/russia/packs" }, DataPaths(cfg));
    }

    [Fact]
    public void MigratesBeforeItDoesAnythingElseAndReportsOnStderr()
    {
        (string dir, string cfg, string store) = OldProject();
        var stdout = new StringWriter();
        var stderr = new StringWriter();

        Assert.Equal(0, Cli.Pack.Run(new[] { "remove", "russia" }, dir, stdout, stderr));

        string err = stderr.ToString();
        Assert.Contains("used the old per-bundle layout", err);
        Assert.Contains("ru: ru/packs → ru (3 files)", err);
        Assert.Contains("dropped 2 per-bundle dataPaths entries", err);

        // And the removal that followed acted on the migrated store.
        Assert.False(Directory.Exists(Path.Combine(store, "countries")));
        Assert.True(File.Exists(Path.Combine(store, "ru/person/lastName.txt")));
        Assert.Equal(new[] { "ru" }, PackStore.Read(store).Bundles.Select(b => b.Id));
        Assert.Equal(new[] { "./tdcv2-packs" }, DataPaths(cfg));
    }
}
