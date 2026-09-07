using System.Text.Json;

namespace Tdcv2.Packs;

/// <summary>
/// <c>_pack.json</c> — who wrote a folder of packs, under what licence, at what version.
/// </summary>
/// <remarks>
/// <para>
/// The pack format is otherwise all content and no provenance: a folder of <c>.txt</c> lists and
/// <c>.tdc</c> generators says what it produces and nothing about where it came from. That is fine
/// while the only packs are the bundled ones, and stops being fine the moment somebody downloads a
/// folder from a colleague, a registry or a company share and has to answer "may we ship data
/// built from this?".
/// </para>
/// <para>
/// Everything here is OPTIONAL and nothing here reaches the generated data. A manifest cannot
/// change a single value: it describes the folder it sits in, and <c>tdcv2 pack info</c> is what
/// reads it back. A run never mentions it — the same seed gives the same bytes whether it parses
/// or not, so halting a generation over it would punish the run for something it does not depend
/// on.
/// </para>
/// </remarks>
public static class PackManifest
{
    public const string Filename = "_pack.json";

    /// <summary>The fields read back, in the order <c>pack info</c> prints them.</summary>
    public static readonly IReadOnlyList<string> Fields = new[]
    {
        "name", "version", "license", "author", "homepage", "description",
    };

    /// <summary>One folder's manifest, and where it was found. Fields keep <see cref="Fields"/> order.</summary>
    public sealed record Found(string Folder, IReadOnlyList<KeyValuePair<string, string>> Manifest);

    /// <summary>What a sweep of the configured folders turned up.</summary>
    public sealed record Sweep(IReadOnlyList<Found> FoundEntries, IReadOnlyList<string> Broken);

    /// <summary>A manifest that would not parse, carried back rather than thrown.</summary>
    public sealed record Parsed(
        IReadOnlyList<KeyValuePair<string, string>>? Manifest, string? Complaint);

    /// <summary>Parse a <c>_pack.json</c>: either the fields, or the complaint to raise.</summary>
    /// <remarks>
    /// Unknown keys are kept quietly: a manifest is metadata, and a folder written for a newer TDC
    /// — or for a company's own tooling beside it — must not stop working here because it carries
    /// a field this version has no use for. What is refused is a field that IS known and holds the
    /// wrong kind of thing, because that one was meant for this reader and will not arrive.
    /// </remarks>
    public static Parsed Parse(string content, string folder)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(content);
        }
        catch (JsonException e)
        {
            return new Parsed(
                null,
                $"{Filename} in \"{folder}\" is not valid JSON ({e.Message}); "
                + "nothing in this folder is described until it is fixed");
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return new Parsed(
                    null,
                    $"{Filename} in \"{folder}\" must be a JSON object, e.g. {{\"license\": \"MIT\"}}");
            }

            var manifest = new List<KeyValuePair<string, string>>();
            foreach (string field in Fields)
            {
                if (!document.RootElement.TryGetProperty(field, out JsonElement value))
                {
                    continue;
                }

                if (value.ValueKind != JsonValueKind.String)
                {
                    string kind = value.ValueKind switch
                    {
                        JsonValueKind.Array => "a list",
                        JsonValueKind.Object => "an object",
                        JsonValueKind.Number => "a number",
                        JsonValueKind.Null => "null",
                        _ => "a boolean",
                    };
                    return new Parsed(
                        null,
                        $"{Filename} in \"{folder}\" has \"{field}\" as {kind}, and it must be text");
                }

                string text = value.GetString() ?? string.Empty;
                if (text.Trim().Length > 0)
                {
                    manifest.Add(new KeyValuePair<string, string>(field, text));
                }
            }

            return new Parsed(manifest, null);
        }
    }

    /// <summary>Look for <c>_pack.json</c> in each root and in each of its top-level folders.</summary>
    /// <remarks>
    /// Two depths rather than a full walk, and deliberately: a manifest describes a FOLDER OF
    /// PACKS, which is either a data path somebody configured or one locale inside it. Walking
    /// deeper would invite a manifest per <c>.txt</c> file, and the question this answers — who
    /// wrote this data, and under what licence — is not one a single list of city names has its
    /// own answer to.
    /// </remarks>
    public static Sweep DoSweep(
        IReadOnlyList<string> roots,
        Func<string, string?> read,
        Func<string, IReadOnlyList<string>> folders,
        Func<string, string, string> join)
    {
        var found = new List<Found>();
        var broken = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (string root in roots)
        {
            var candidates = new List<string> { root };
            foreach (string name in folders(root))
            {
                candidates.Add(join(root, name));
            }

            foreach (string folder in candidates)
            {
                if (!seen.Add(folder))
                {
                    continue; // a root listed twice describes itself once
                }

                string? content = read(join(folder, Filename));
                if (content is null)
                {
                    continue;
                }

                Parsed parsed = Parse(content, folder);
                if (parsed.Complaint is not null)
                {
                    broken.Add(parsed.Complaint);
                }
                else
                {
                    found.Add(new Found(folder, parsed.Manifest!));
                }
            }
        }

        return new Sweep(found, broken);
    }

    /// <summary>
    /// How a found folder is printed: relative to where the command was run when it sits inside,
    /// absolute otherwise.
    /// </summary>
    /// <remarks>
    /// A project's own packs live under the project, so the reader sees <c>mypacks/en</c> rather
    /// than sixty characters of temp path — and a store somewhere else in the filesystem still
    /// says where it really is.
    /// </remarks>
    public static string DisplayFolder(string folder, string cwd)
    {
        if (!folder.StartsWith(cwd, StringComparison.Ordinal))
        {
            return folder;
        }

        string rest = folder.Substring(cwd.Length).TrimStart('/');
        return rest.Length == 0 ? "." : rest;
    }
}
