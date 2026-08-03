using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Tdcv2.Cli;

namespace Tdcv2.Tests;

/// <summary>
/// The command line's contract, as data.
/// </summary>
/// <remarks>
/// <para>
/// Every implementation runs the same file and must agree — exit code first, then what reached
/// stdout and stderr. A CLI is the surface most users touch, and two implementations that generate
/// identical data while disagreeing about an exit code are still not interchangeable in a script.
/// </para>
/// <para>
/// `init` and `pack` act on a working DIRECTORY rather than on a named file, so they are handed the
/// temp directory instead of chdir-ing the whole test process into it — a process-wide cd is a race
/// as soon as two tests run at once.
/// </para>
/// </remarks>
public class CliTest
{
    private static readonly Lazy<JsonDocument> Fixture = new(() =>
        JsonDocument.Parse(
            File.ReadAllText(Path.Combine(PrngVectorsTest.FixturesDir(), "cli.json"))));

    public static TheoryData<string, string> Cases()
    {
        var data = new TheoryData<string, string>();
        foreach (JsonElement node in Fixture.Value.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(node.GetProperty("name").GetString()!, node.GetRawText());
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void BehavesAsTheContractSays(string name, string raw)
    {
        using JsonDocument node = JsonDocument.Parse(raw);
        JsonElement root = node.RootElement;

        string dir = Directory.CreateDirectory(
            Path.Combine(Path.GetTempPath(), "tdcv2-cli-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            string? registry =
                root.TryGetProperty("registry", out JsonElement r) && r.GetBoolean()
                    ? BuildRegistry(Path.Combine(dir, "registry"))
                    : null;

            WriteInputs(root, dir);

            var stdout = new StringWriter();
            var stderr = new StringWriter();
            string[] argv = root.GetProperty("argv").EnumerateArray()
                .Select(a => Resolve(a.GetString()!, dir, registry))
                .ToArray();

            string command = root.TryGetProperty("command", out JsonElement c)
                ? c.GetString()!
                : "main";
            int exit = command switch
            {
                "init" => Init.Run(argv, dir, stdout, stderr),
                "pack" => Pack.Run(argv, dir, stdout, stderr),
                _ => Main.Run(argv, stdout, stderr),
            };

            Assert.Equal(root.GetProperty("exit").GetInt32(), exit);
            Check(root, "stdout", stdout.ToString(), dir, registry);
            Check(root, "stderr", stderr.ToString(), dir, registry);

            if (root.TryGetProperty("wrote", out JsonElement wrote))
            {
                foreach (JsonProperty file in wrote.EnumerateObject())
                {
                    Assert.Equal(
                        Resolve(file.Value.GetString()!, dir, registry),
                        File.ReadAllText(Path.Combine(dir, file.Name)));
                }
            }

            if (root.TryGetProperty("wroteContains", out JsonElement partial))
            {
                foreach (JsonProperty file in partial.EnumerateObject())
                {
                    string written = File.ReadAllText(Path.Combine(dir, file.Name));
                    foreach (JsonElement fragment in file.Value.EnumerateArray())
                    {
                        Assert.Contains(Resolve(fragment.GetString()!, dir, registry), written);
                    }
                }
            }
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>The named configs live once in the fixture; a case refers to one with `@name`.</summary>
    private static void WriteInputs(JsonElement root, string dir)
    {
        if (!root.TryGetProperty("files", out JsonElement files))
        {
            return;
        }

        JsonElement configs = Fixture.Value.RootElement.GetProperty("configs");
        foreach (JsonProperty file in files.EnumerateObject())
        {
            string contents = file.Value.GetString()!;
            if (contents.StartsWith('@'))
            {
                contents = configs.GetProperty(contents[1..]).GetString()!;
            }

            string target = Path.Combine(dir, file.Name);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllText(target, contents.Replace("{dir}", dir));
        }
    }

    private static string Resolve(string text, string dir, string? registry)
    {
        string result = text.Replace("{dir}", dir).Replace("{version}", Tdcv2.Cli.Main.Version);
        return registry is null ? result : result.Replace("{registry}", registry);
    }

    /// <summary>
    /// The demo registry every implementation's runner builds, byte for byte the same.
    /// </summary>
    /// <remarks>
    /// Served over <c>file:</c> rather than a local HTTP server: the layout is what is under test,
    /// not the transport, and a socket in a unit test is a flake waiting for a busy machine.
    /// </remarks>
    private static string BuildRegistry(string root)
    {
        var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            // The zip nests everything under the bundle's own id, so it unpacks into the STORE and
            // lands at <store>/<id>/packs. That layout is the registry's, shared by every
            // implementation, so building it differently here would test the wrong thing.
            ZipArchiveEntry entry =
                archive.CreateEntry("demo/packs/demo/person/lastName.txt");
            using var writer = new StreamWriter(entry.Open());
            writer.Write("Ivanov\nPetrov\n");
        }

        byte[] data = buffer.ToArray();
        string digest = System.Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

        Directory.CreateDirectory(Path.Combine(root, "bundles"));
        File.WriteAllBytes(Path.Combine(root, "bundles", "demo.zip"), data);
        File.WriteAllText(Path.Combine(root, "index.json"), IndexJson(data.Length, digest));

        // A second, deliberately broken registry beside the honest one: the same archive, advertised
        // at a size it does not have. It lives under its own path so the honest catalogue — which
        // cases assert byte for byte — keeps listing exactly one bundle.
        Directory.CreateDirectory(Path.Combine(root, "broken", "bundles"));
        File.WriteAllBytes(Path.Combine(root, "broken", "bundles", "demo.zip"), data);
        File.WriteAllText(
            Path.Combine(root, "broken", "index.json"), IndexJson(data.Length + 999, digest));

        return new Uri(root + Path.DirectorySeparatorChar).AbsoluteUri.TrimEnd('/');
    }

    private static string IndexJson(int bytes, string digest) =>
        "{\"schemaVersion\": 1, \"bundles\": [{\"id\": \"demo\", \"name\": \"Demo pack\", "
        + "\"description\": \"two surnames\", \"file\": \"bundles/demo.zip\", "
        + $"\"bytes\": {bytes}, \"sha256\": \"{digest}\", \"locale\": \"demo\"}}]}}";

    private static void Check(
        JsonElement root, string stream, string actual, string dir, string? registry)
    {
        if (root.TryGetProperty(stream, out JsonElement exact))
        {
            Assert.Equal(Resolve(exact.GetString()!, dir, registry), actual);
        }

        if (root.TryGetProperty(stream + "Contains", out JsonElement contains))
        {
            foreach (JsonElement fragment in contains.EnumerateArray())
            {
                Assert.Contains(Resolve(fragment.GetString()!, dir, registry), actual);
            }
        }

        if (root.TryGetProperty(stream + "Matches", out JsonElement pattern))
        {
            Assert.Matches(pattern.GetString()!, actual);
        }
    }

    /// <summary>How much of the shared CLI contract this port answers to, as a number.</summary>
    [Fact]
    public void ReportsProgress()
    {
        int total = Fixture.Value.RootElement.GetProperty("cases").GetArrayLength();
        Console.WriteLine($"cli: {Cases().Count()} of {total} shared cases run here");
        Assert.Equal(total, Cases().Count());
    }
}
