using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Tdcv2.Engine;
using Tdcv2.Model;
using Tdcv2.Output;
using Tdcv2.Packs;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// Parquet files, checked by length and digest against the reference's own.
/// </summary>
/// <remarks>
/// <para>
/// A digest is the only assertion that means anything here. "It opens in pandas" says the file is
/// valid, not that it is the same file — and this writer exists precisely so four implementations
/// produce identical bytes. Every choice inside it is a function of the data alone, so a single
/// differing byte is a real divergence rather than a permissible one.
/// </para>
/// <para>
/// That also makes a failure hard to read, which is the trade: a wrong byte says nothing about which
/// byte. The length is asserted first, because a size off by a little usually means one field, and a
/// size off by a lot usually means an encoding.
/// </para>
/// </remarks>
public class ParquetTest
{
    public static TheoryData<string, string> Cases()
    {
        string path = Path.Combine(PrngVectorsTest.FixturesDir(), "parquet.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        var data = new TheoryData<string, string>();
        foreach (JsonElement node in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(node.GetProperty("name").GetString()!, node.GetRawText());
        }

        return data;
    }

    private static long Now()
    {
        string path = Path.Combine(PrngVectorsTest.FixturesDir(), "parquet.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        return DateTimeOffset.Parse(
                document.RootElement.GetProperty("now").GetString()!,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal)
            .ToUnixTimeMilliseconds();
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesTheReferenceByteForByte(string name, string raw)
    {
        using JsonDocument node = JsonDocument.Parse(raw);
        JsonElement root = node.RootElement;

        byte[] file = Build(root.GetProperty("config").GetString()!, PrngVectorsTest.BaseDirOf(root));

        // Length first: off by a little is usually one field, off by a lot is usually an encoding.
        Assert.Equal(root.GetProperty("size").GetInt32(), file.Length);
        Assert.Equal(root.GetProperty("sha256").GetString(), Digest(file));
    }

    private static byte[] Build(string config, string baseDir)
    {
        TdcParserFacade.Result parsed = TdcParserFacade.Parse(config);
        Assert.True(parsed.Ok, "does not parse: " + string.Join("; ", parsed.Problems));
        Config built = ConfigBuilder.Build(parsed.Tree);

        // Through the ROUTER, as the reference's own test does. Most of these configs declare no
        // mode, so they belong to the streaming engine — building them in memory would compare
        // against bytes the reference never wrote.
        IRowSource rows = Engines.Run(built, DataPacks.Discover(), Now(), baseDir);
        return ParquetOutput.ToBytes(built, rows);
    }

    private static string Digest(byte[] bytes) =>
        System.Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>How much of the Parquet contract this port answers to, as a number.</summary>
    [Fact]
    public void ReportsProgress()
    {
        int matched = 0;
        var wrong = new List<string>();

        foreach (object[] row in Cases())
        {
            string name = (string)row[0];
            using JsonDocument node = JsonDocument.Parse((string)row[1]);
            JsonElement root = node.RootElement;
            try
            {
                byte[] file = Build(
                    root.GetProperty("config").GetString()!, PrngVectorsTest.BaseDirOf(root));
                if (root.GetProperty("sha256").GetString() == Digest(file))
                {
                    matched++;
                }
                else
                {
                    wrong.Add(
                        $"{name}: {root.GetProperty("size").GetInt32()} bytes wanted, "
                        + $"{file.Length} produced");
                }
            }
            catch (Exception e)
            {
                wrong.Add($"{name}: {e.GetType().Name} {e.Message}");
            }
        }

        Console.WriteLine($"parquet: {matched} match the reference, {wrong.Count} do not");
        foreach (string w in wrong)
        {
            Console.WriteLine("  " + w);
        }

        Assert.Empty(wrong);
    }
}
