using System.Globalization;

namespace Tdcv2.Packs;

/// <summary>
/// Reads data packs off disk.
/// </summary>
/// <remarks>
/// A pack is a text file: an optional <c>---</c> header, then one value per line. With
/// <c>weighted: true</c> each line is <c>value,count</c> instead, and the counts become exact
/// proportions rather than probabilities — the same machinery <c>percent=</c> uses. That is why a run
/// of 30,000 rows from the SSA name file contains precisely as many Jameses as the census says, not
/// approximately.
/// </remarks>
public sealed class DataPacks
{
    /// <summary>
    /// A loaded pack.
    /// </summary>
    /// <remarks>
    /// <c>Percents</c> is null unless the pack is weighted. <c>Generator</c> is null unless the pack
    /// is a generator rather than a list — some packs describe how to build a value instead of
    /// listing values, because listing every UUID is not a thing anyone can do.
    /// </remarks>
    public sealed record Entry(
        IReadOnlyList<string> Values, double[]? Percents, string? Generator)
    {
        public bool Weighted => Percents is not null;

        public bool IsGenerator => Generator is not null;
    }

    /// <summary>
    /// Where the files come from.
    /// </summary>
    /// <remarks>
    /// Exposed so a caller can layer another folder on top without losing this one — replacing the
    /// source would silently drop every bundled locale.
    /// </remarks>
    public IPackSource Source { get; }
    private readonly Dictionary<string, Entry> _cache = new(StringComparer.Ordinal);

    /// <summary>address -&gt; relative file path, built on the first miss and kept.</summary>
    /// <remarks>
    /// Null until then: most runs resolve every address straight from its path and never pay for
    /// the scan.
    /// </remarks>
    private Dictionary<string, string>? _addressIndex;

    /// <summary>
    /// Folders searched by <c>src="@data/…"</c>, and by a relative <c>src=</c> the config's own
    /// folder does not hold. Highest priority last, as the layers are.
    /// </summary>
    public IReadOnlyList<string> DataRoots { get; }

    public DataPacks(IPackSource source, IReadOnlyList<string>? dataRoots = null)
    {
        Source = source;
        DataRoots = dataRoots?.ToArray() ?? Array.Empty<string>();
    }

    public DataPacks(string root)
        : this(new DirectorySource(root), new[] { root })
    {
    }

    /// <summary>
    /// The packs found without being told where they are.
    /// </summary>
    /// <remarks>
    /// <c>TDCV2_PACKS</c> when it is set, otherwise a <c>packs</c> folder beside the assembly, and
    /// failing that the repository's own <c>data/packs</c> found by walking upward. The walk is what
    /// lets the tests here read the very same files the other three implementations read, rather
    /// than a copy that could drift from them.
    /// </remarks>
    public static DataPacks Discover()
    {
        string? fromEnv = Environment.GetEnvironmentVariable("TDCV2_PACKS");
        if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv))
        {
            return new DataPacks(fromEnv);
        }

        string beside = Path.Combine(AppContext.BaseDirectory, "packs");
        if (Directory.Exists(beside))
        {
            return new DataPacks(beside);
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "data", "packs");
            if (Directory.Exists(candidate))
            {
                return new DataPacks(candidate);
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "no data packs found; set TDCV2_PACKS to a pack folder");
    }

    /// <summary>
    /// The discovered packs plus whatever <c>tdcv2.config.json</c> adds, searched from here upward.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A pack downloaded into a project belongs to the project, not to whichever runtime happens to
    /// read it. Honouring the same config file the command-line tool writes is what keeps a config
    /// that uses a downloaded pack working in every implementation rather than only in the one that
    /// fetched it.
    /// </para>
    /// <para>
    /// <paramref name="extraRoots"/> are named at the call site — the command line's
    /// <c>--data-path</c> — and go on last, so they shadow both the config's roots and the
    /// discovered packs. Something typed for this one run should beat something written down for
    /// every run.
    /// </para>
    /// <para>
    /// The pack STORE is deliberately not a scan root. Bundles land in <c>&lt;store&gt;/&lt;id&gt;/</c>
    /// and each registers its own <c>packs</c> folder in <c>dataPaths</c>; scanning the store as
    /// well would make every installed bundle's id look like a top-level namespace, so
    /// <c>france.docs.nir</c> would be looked up as <c>france/docs/nir.txt</c> instead of
    /// <c>countries/france/docs/nir.txt</c> and a country pack would stop resolving the moment it
    /// was installed.
    /// </para>
    /// </remarks>
    public static DataPacks ForProject(string? searchFrom, IReadOnlyList<string>? extraRoots = null)
    {
        DataPacks discovered = Discover();
        ProjectConfig.Resolved config = ProjectConfig.Load(searchFrom);

        var layers = new List<IPackSource> { discovered.Source };
        var roots = new List<string>(discovered.DataRoots);
        foreach (string dir in config.DataPaths.Concat(extraRoots ?? Array.Empty<string>()))
        {
            if (Directory.Exists(dir))
            {
                layers.Add(new DirectorySource(dir));
            }

            roots.Add(dir);
        }

        return layers.Count == 1
            ? new DataPacks(discovered.Source, roots)
            : new DataPacks(new LayeredSource(layers), roots);
    }

    /// <summary>Whether an address resolves, without loading it.</summary>
    public bool Exists(string dottedPath, string? locale)
    {
        try
        {
            Load(dottedPath, locale);
            return true;
        }
        catch (Exception e) when (e is ArgumentException or IOException)
        {
            return false;
        }
    }

    /// <summary>
    /// Whether a pack generator apportions a share over the whole column.
    /// </summary>
    /// <remarks>
    /// A <c>percent=</c> anywhere in a generator's body — on its <c>&lt;mix&gt;</c>, on a
    /// <c>&lt;gen&gt;</c>, on a compound field — makes its quota a property of the run rather than of
    /// a row. The router asks this before sending a config to an engine that resolves one row at a
    /// time.
    /// </remarks>
    public bool NeedsWholeColumn(string dottedPath, string? locale)
    {
        Entry entry = Load(dottedPath, locale);
        if (!entry.IsGenerator)
        {
            return false;
        }

        string body = entry.Generator!;
        Parser.ConfigBuilder.PackGenerator composed;
        try
        {
            composed = Parser.ConfigBuilder.ParsePackBody(body);
        }
        catch (ArgumentException)
        {
            // A single bare <gen>: it declares a share only through its own percent=.
            return body.Contains("percent=");
        }

        foreach (Model.SequenceSpec spec in composed.Sequences)
        {
            if (spec.IsMix && Declares(spec.Mix!.Percent))
            {
                return true;
            }

            if (spec.Gen is not null && Declares(spec.Gen.Attrs.GetValueOrDefault("percent")))
            {
                return true;
            }

            if (spec.IsCompound
                && spec.Fields!.Any(f => Declares(f.Gen.Attrs.GetValueOrDefault("percent"))))
            {
                return true;
            }
        }

        return false;
    }

    private static bool Declares(string? percent) => !string.IsNullOrWhiteSpace(percent);

    /// <summary>
    /// Resolve a dotted path against a locale and load it.
    /// </summary>
    /// <remarks>
    /// The rule the reference uses: if the first segment names a locale, a country, or a reserved
    /// bucket, the path is already absolute; otherwise the active locale is prepended, so
    /// <c>person.lastName</c> under <c>en</c> is <c>en/person/lastName.txt</c>.
    /// </remarks>
    public Entry Load(string dottedPath, string? locale)
    {
        string key = dottedPath + "|" + locale;
        if (_cache.TryGetValue(key, out Entry? cached))
        {
            return cached;
        }

        string first = dottedPath.Split('.', 2)[0];
        string file;
        if (Source.HasTopLevel(first))
        {
            // A locale or a reserved bucket: the address is already absolute.
            file = dottedPath.Replace('.', '/') + ".txt";
        }
        else if (Source.HasCountry(first))
        {
            // A country: absolute too, but its files live under the countries/ grouping, which is
            // not part of the address anyone writes.
            file = "countries/" + dottedPath.Replace('.', '/') + ".txt";
        }
        else
        {
            // Relative to the active locale, so `person.lastName` under `ru` is a Russian surname.
            file = (locale + "." + dottedPath).Replace('.', '/') + ".txt";
        }

        if (!Source.Has(file))
        {
            // The path did not answer, so ask the headers: a file may declare its own `address:`
            // and then live anywhere at all — which is how someone keeps a flat folder of their
            // own lists.
            if (!Addresses().TryGetValue(AbsoluteAddress(dottedPath, locale), out string? placed)
                || !Source.Has(placed))
            {
                throw new ArgumentException(
                    $"unknown template path \"{dottedPath}\" (looked for {file} in {Source})");
            }

            Entry placedEntry = Parse(Source.ReadLines(placed), placed);
            _cache[key] = placedEntry;
            return placedEntry;
        }

        Entry entry = Parse(Source.ReadLines(file), file);
        _cache[key] = entry;
        return entry;
    }

    /// <summary>The address as the index holds it: locale-prefixed unless already absolute.</summary>
    private string AbsoluteAddress(string dottedPath, string? locale)
    {
        string first = dottedPath.Split('.', 2)[0];
        return Source.HasTopLevel(first) || Source.HasCountry(first)
            ? dottedPath
            : locale + "." + dottedPath;
    }

    /// <summary>Every pack file's address, read from its header — built once, kept.</summary>
    /// <remarks>
    /// A header may carry <c>address:</c> (authoritative) and <c>locale:</c> (used only when the
    /// path-derived address has no locale of its own). A file that resolves to neither a locale, a
    /// country nor a reserved bucket is not addressable and is left out, which is the rule the
    /// reference applies.
    /// </remarks>
    private Dictionary<string, string> Addresses()
    {
        if (_addressIndex is not null)
        {
            return _addressIndex;
        }

        var index = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Source.ListFiles())
        {
            Dictionary<string, string> header = HeaderOf(Source.ReadLines(file));
            string address;
            if (header.TryGetValue("address", out string? declared)
                && !string.IsNullOrWhiteSpace(declared))
            {
                address = declared.Trim();
            }
            else
            {
                string derived = file[..^".txt".Length].Replace('/', '.');
                if (derived.StartsWith("countries.", StringComparison.Ordinal))
                {
                    derived = derived["countries.".Length..];
                }

                string head = derived.Split('.', 2)[0];
                if (Source.HasTopLevel(head) || Source.HasCountry(head))
                {
                    address = derived;
                }
                else if (header.TryGetValue("locale", out string? declaredLocale)
                    && !string.IsNullOrWhiteSpace(declaredLocale))
                {
                    // Not under a locale folder: the header's own `locale:` is the only thing that
                    // can say where this belongs.
                    address = declaredLocale.Trim() + "." + derived;
                }
                else
                {
                    continue;
                }
            }

            index[address] = file;
        }

        _addressIndex = index;
        return index;
    }

    /// <summary>Just the <c>---</c> fenced header, for the address scan: no body, no validation.</summary>
    private static Dictionary<string, string> HeaderOf(IReadOnlyList<string> lines)
    {
        var header = new Dictionary<string, string>(StringComparer.Ordinal);
        if (lines.Count == 0 || lines[0].Trim() != "---")
        {
            return header;
        }

        for (int i = 1; i < lines.Count; i++)
        {
            string line = lines[i].Trim();
            if (line == "---")
            {
                break;
            }

            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            int colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                header[line[..colon].Trim().ToLowerInvariant()] = line[(colon + 1)..].Trim();
            }
        }

        return header;
    }

    private static Entry Parse(IReadOnlyList<string> lines, string file)
    {
        var header = new Dictionary<string, string>(StringComparer.Ordinal);
        int start = 0;
        if (lines.Count > 0 && lines[0].Trim() == "---")
        {
            int end = 1;
            while (end < lines.Count && lines[end].Trim() != "---")
            {
                string line = lines[end];
                int colon = line.IndexOf(':');
                if (colon > 0)
                {
                    header[line[..colon].Trim()] = line[(colon + 1)..].Trim();
                }

                end++;
            }

            start = end + 1;
        }

        var body = new List<string>();
        for (int i = start; i < lines.Count; i++)
        {
            if (!string.IsNullOrWhiteSpace(lines[i]))
            {
                body.Add(lines[i]);
            }
        }

        // `generator: tdc` marks a pack whose body is a <gen> tag rather than a list of values.
        // Some things cannot be listed — a UUID, an account number — so the pack ships the rule.
        if (header.GetValueOrDefault("generator") == "tdc")
        {
            return new Entry(Array.Empty<string>(), null, string.Join("\n", body));
        }

        if (header.GetValueOrDefault("weighted") != "true")
        {
            return new Entry(body, null, null);
        }

        string delimiter = header.GetValueOrDefault("delimiter", ",");
        var values = new List<string>(body.Count);
        var counts = new List<double>(body.Count);
        double total = 0;
        foreach (string line in body)
        {
            int at = line.LastIndexOf(delimiter, StringComparison.Ordinal);
            if (at < 0)
            {
                throw new ArgumentException(
                    $"weighted pack {file}: line \"{line}\" has no count");
            }

            double weight = double.Parse(
                line[(at + delimiter.Length)..].Trim(), NumberStyles.Float,
                CultureInfo.InvariantCulture);

            // A zero weight means "never drawn". Dropping it rather than carrying it at zero
            // probability is what the reference does, and census files are full of them.
            if (weight == 0)
            {
                continue;
            }

            values.Add(line[..at]);
            counts.Add(weight);
            total += weight;
        }

        if (values.Count == 0)
        {
            throw new ArgumentException($"weighted pack {file} has no positive counts");
        }

        var percents = new double[counts.Count];
        for (int i = 0; i < counts.Count; i++)
        {
            // Written exactly as the reference computes it. Reordering these operations changes the
            // last bits of the double, which changes a Hamilton remainder, which changes which row
            // gets a leftover — and the output stops matching.
            percents[i] = counts[i] / total * 100;
        }

        return new Entry(values, percents, null);
    }
}
