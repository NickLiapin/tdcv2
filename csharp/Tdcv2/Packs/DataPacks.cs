using System.Globalization;
using Tdcv2.Errors;

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
    /// <summary>The extensions a dotted address is tried against, in order.</summary>
    /// <remarks>
    /// Nearly every pack is a <c>.txt</c> list; a COMPOSED pack — one whose value a generator body
    /// builds rather than a line of the file — is a <c>.tdc</c>. The reference ignores the
    /// extension altogether, and so does the address index below; this list is only the fast path
    /// that spares an ordinary run the scan.
    /// </remarks>
    private static readonly string[] PackExtensions = { ".txt", ".tdc" };

    /// <summary>
    /// A relative path without its final extension, the way the reference derives an address from
    /// one. Only the last segment is considered, so <c>nl-be/person/name</c> keeps the dot in its
    /// folder.
    /// </summary>
    private static string StripExtension(string path)
    {
        int start = path.LastIndexOf('/') + 1;
        int dot = path.LastIndexOf('.');
        return dot > start ? path[..dot] : path;
    }

    /// <summary>
    /// A loaded pack.
    /// </summary>
    /// <remarks>
    /// <c>Percents</c> is null unless the pack is weighted. <c>Generator</c> is null unless the pack
    /// is a generator rather than a list — some packs describe how to build a value instead of
    /// listing values, because listing every UUID is not a thing anyone can do.
    /// </remarks>
    /// <summary>The address found a file, and the file cannot be used.</summary>
    /// <remarks>
    /// Its own type because <see cref="Exists"/> has to tell it apart from "no such address". The
    /// address RESOLVES; reporting it as a misspelling sends the reader hunting for a typo that is
    /// not there, while the file it should be looking at sits in the folder.
    /// </remarks>
    internal sealed class EmptyPackException : ArgumentException
    {
        internal EmptyPackException(string message)
            : base(message)
        {
        }
    }

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

    /// <summary>The files the index build read and could not place — TDC171.</summary>
    /// <remarks>
    /// Filled by the same pass, so saying so costs nothing over dropping them silently.
    /// </remarks>
    private IReadOnlyList<Diagnostic> _unaddressable = Array.Empty<Diagnostic>();

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
    /// The same three questions, in the same order, in all five implementations:
    /// <c>TDCV2_PACKS</c> when it names a folder, then the source checkout this build came from
    /// (see <see cref="SourceCheckoutPacks"/>), then the starter set shipped inside the package.
    /// </remarks>
    public static DataPacks Discover()
    {
        string? fromEnv = Environment.GetEnvironmentVariable("TDCV2_PACKS");
        if (!string.IsNullOrWhiteSpace(fromEnv) && Directory.Exists(fromEnv))
        {
            return new DataPacks(fromEnv);
        }

        string? checkout = SourceCheckoutPacks(AppContext.BaseDirectory);
        if (checkout is not null)
        {
            return new DataPacks(checkout);
        }

        string beside = Path.Combine(AppContext.BaseDirectory, "packs");
        if (Directory.Exists(beside))
        {
            return new DataPacks(beside);
        }

        // The starter set compiled into this assembly, which is what a package installed from
        // NuGet has: there is nothing above ~/.nuget/packages to walk up to, and without this
        // every type="template" answered "no data packs found".
        if (!EmbeddedSource.IsEmpty)
        {
            return new DataPacks(new EmbeddedSource());
        }

        throw new DirectoryNotFoundException(
            "no data packs found; set TDCV2_PACKS to a pack folder");
    }

    /// <summary>
    /// <c>&lt;repo&gt;/data/packs</c>, if this code is running out of a TDC source checkout.
    /// </summary>
    /// <remarks>
    /// In a checkout that folder is the copy every implementation reads and the one a contributor
    /// edits, so finding it is what keeps all five seeing the same data rather than five copies
    /// free to drift.
    /// <para>
    /// Walking up for a bare <c>data/packs</c> is not enough: the name is ordinary enough that an
    /// unrelated folder above an installed package could answer, and then the same config would
    /// read different data depending on where the user happened to install it. A directory only
    /// counts when it ALSO holds <c>fixtures/cross-language</c> — the folder holding the contract
    /// all five implementations are tested against, which exists in this repository and nowhere
    /// else.
    /// </para>
    /// </remarks>
    public static string? SourceCheckoutPacks(string startFrom)
    {
        var dir = new DirectoryInfo(startFrom);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "cross-language")))
            {
                string candidate = Path.Combine(dir.FullName, "data", "packs");
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
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
        // A duplicate address RESOLVES — twice, which is the whole complaint, and Load is what
        // reports it. Answering "no" here would report the collision as a misspelled address and
        // send the reader hunting for a typo that is not there.
        if (Candidates(BasePath(dottedPath, locale)).Count > 1)
        {
            return true;
        }

        try
        {
            Load(dottedPath, locale);
            return true;
        }
        catch (EmptyPackException)
        {
            // It resolves — to nothing at all, which IS the complaint. Load is what reports it.
            return true;
        }
        catch (Exception e) when (e is ArgumentException or IOException)
        {
            return false;
        }
    }

    /// <summary>A pack that lists nothing is refused here rather than drawn from later.</summary>
    /// <remarks>
    /// A file with a header and no lines under it parses perfectly well and yields an empty list.
    /// Nothing downstream expects one: the generator picks <c>values[floor(random * count)]</c>
    /// and every implementation but the reference crashed on the index — an out-of-range here, an
    /// IndexError in Python, a panic in Rust — none of them naming the file. Said the way the
    /// reference has always said it, so the sentence is one sentence in five implementations.
    /// </remarks>
    private Entry Checked(Entry entry, string dottedPath, string? locale, string file)
    {
        if (entry.Generator is null && entry.Values.Count == 0)
        {
            throw new EmptyPackException(
                $"data-pack address \"{AbsoluteAddress(dottedPath, locale)}\" "
                    + $"({LocateOr(file)}) has no values");
        }

        // A `generator: tdc` pack ships a rule instead of a list, and a header with nothing under
        // it ships neither. This used to answer "pack generator body has no <gen> tag:" without
        // naming the file, which leaves the author a folder to search by hand.
        if (entry.Generator is not null && string.IsNullOrWhiteSpace(entry.Generator))
        {
            throw new EmptyPackException(
                $"generator \"{AbsoluteAddress(dottedPath, locale)}\" "
                    + $"({LocateOr(file)}) has an empty body");
        }

        return entry;
    }

    /// <summary>Where this address's files sit, extension aside.</summary>
    private string BasePath(string dottedPath, string? locale)
    {
        string first = dottedPath.Split('.', 2)[0];
        if (Source.HasTopLevel(first))
        {
            // A locale or a reserved bucket: the address is already absolute.
            return dottedPath.Replace('.', '/');
        }

        if (Source.HasCountry(first))
        {
            // A country: absolute too, but its files live under the countries/ grouping, which is
            // not part of the address anyone writes.
            return "countries/" + dottedPath.Replace('.', '/');
        }

        // Relative to the active locale, so `person.lastName` under `ru` is a Russian surname.
        return (locale + "." + dottedPath).Replace('.', '/');
    }

    /// <summary>
    /// The files this address's path resolves to, one per extension that exists. More than one is
    /// a collision, because the extension is not part of an address.
    /// </summary>
    private List<string> Candidates(string @base) =>
        PackExtensions.Select(extension => @base + extension).Where(Source.Has).ToList();

    /// <summary>
    /// Where a file is on disk when the source can say, and its relative path when it cannot.
    /// </summary>
    private string LocateOr(string relativePath) => Source.Locate(relativePath) ?? relativePath;

    /// <summary>
    /// Whether a pack generator apportions a share over the whole column.
    /// </summary>
    /// <remarks>
    /// <para>Two ways to earn it.</para>
    /// <para>
    /// A <c>percent=</c> anywhere in a generator's body — on its <c>&lt;mix&gt;</c>, on a
    /// <c>&lt;gen&gt;</c>, on a compound field — makes its quota a property of the run rather than of
    /// a row.
    /// </para>
    /// <para>
    /// And a body that merely DRAWS from a weighted list, which the body does not say. A weighted
    /// list is laid out to an exact Hamilton quota over the run, so each value takes its measured
    /// share of the rows; asked for ONE row that plan is computed over a column of one and the row
    /// goes to the largest share, every time, for every seed. Twelve shipped full-name packs were in
    /// that state — eight rows of <c>hu.person.male.fullName</c> came back as eight copies of
    /// "Nagy László" — because the body says <c>value="hu.person.lastName"</c> and nothing in that
    /// line says the list on the other end carries weights. German and Polish full names were fine,
    /// and the only difference is that their name lists carry no weights.
    /// </para>
    /// <para>
    /// The router asks this before sending a config to an engine that resolves one row at a time,
    /// and so does the row-at-a-time path inside the engine itself.
    /// </para>
    /// <para>
    /// A plain LIST answers false even when it is weighted: whoever draws one lays its quota out
    /// over the rows already, and marking it here would cost every weighted draw the streaming
    /// engines for nothing. Only a GENERATOR over such a list is stuck.
    /// </para>
    /// </remarks>
    public bool NeedsWholeColumn(string dottedPath, string? locale)
    {
        Entry entry = Load(dottedPath, locale);
        return entry.IsGenerator
            && BodyNeedsWholeColumn(
                entry.Generator!,
                locale,
                new HashSet<string>(StringComparer.Ordinal) { CacheKey(dottedPath, locale) });
    }

    /// <summary>
    /// The same question about an address reached from INSIDE another pack's body.
    /// </summary>
    /// <remarks>
    /// Here a weighted list is the answer rather than a plain no: it is the leaf this walk is
    /// looking for, and the generator that drew it inherits its quota.
    /// </remarks>
    /// <param name="visiting">
    /// The addresses already on this walk. A generator that references itself, directly or round a
    /// ring, is reported by the pack loader as its own error; this walk just stops instead of
    /// recursing until the stack runs out.
    /// </param>
    private bool DrawsWholeColumn(string dottedPath, string? locale, HashSet<string> visiting)
    {
        if (!visiting.Add(CacheKey(dottedPath, locale)))
        {
            return false;
        }

        Entry entry;
        try
        {
            entry = Load(dottedPath, locale);
        }
        catch (Exception e) when (e is ArgumentException or IOException)
        {
            // An address that does not resolve is the validator's problem, not this walk's.
            return false;
        }

        return entry.Weighted
            || (entry.IsGenerator && BodyNeedsWholeColumn(entry.Generator!, locale, visiting));
    }

    private bool BodyNeedsWholeColumn(string body, string? locale, HashSet<string> visiting)
    {
        Parser.ConfigBuilder.PackGenerator composed;
        try
        {
            composed = Parser.ConfigBuilder.ParsePackBody(body);
        }
        catch (ArgumentException)
        {
            // A single bare <gen>: it declares a share only through its own percent=, and a bare
            // <gen> may not be a template, so there is no list behind it to inherit one from.
            return body.Contains("percent=");
        }

        foreach (Model.SequenceSpec spec in composed.Sequences)
        {
            if (spec.IsMix && Declares(spec.Mix!.Percent))
            {
                return true;
            }

            foreach (Model.Gen gen in GensOf(spec))
            {
                if (Declares(gen.Attrs.GetValueOrDefault("percent"))
                    || DrawsWeights(gen, locale, visiting))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Does this <c>&lt;gen&gt;</c> inside a pack body reach a weighted list, directly or through
    /// another pack generator?
    /// </summary>
    private bool DrawsWeights(Model.Gen gen, string? locale, HashSet<string> visiting)
    {
        if (gen.Type != "template")
        {
            return false;
        }

        string target = gen.Attrs.GetValueOrDefault("value") ?? "";

        // `common.vehicle.model.${{Brand}}` — an address that is not known until the row is, so
        // there is no list here to ask about.
        if (target.Length == 0 || target.Contains("${{"))
        {
            return false;
        }

        string? inner = gen.Attrs.GetValueOrDefault("local");
        return DrawsWholeColumn(
            target, string.IsNullOrWhiteSpace(inner) ? locale : inner, visiting);
    }

    /// <summary>Every <c>&lt;gen&gt;</c> a pack body's sequence holds, whichever shape it took.</summary>
    /// <remarks>
    /// The compound shape is the one the full-name packs use — two NAMED gens, which is a compound
    /// and not a lone <c>Gen</c> — while a composed body keeps its gens in <c>Items</c> and a
    /// conditional keeps them in <c>Branches</c>. Reading one of the shapes and not the others is
    /// how the weighted draw stayed invisible in the first place.
    /// </remarks>
    private static IEnumerable<Model.Gen> GensOf(Model.SequenceSpec spec)
    {
        if (spec.Gen is not null)
        {
            yield return spec.Gen;
        }

        foreach (Model.Field field in spec.Fields ?? Enumerable.Empty<Model.Field>())
        {
            yield return field.Gen;
        }

        foreach (Model.Item item in spec.Items ?? Enumerable.Empty<Model.Item>())
        {
            if (item.Gen is not null)
            {
                yield return item.Gen;
            }

            if (item.Field is not null)
            {
                yield return item.Field.Gen;
            }
        }

        foreach (Model.Branch branch in spec.Branches ?? Enumerable.Empty<Model.Branch>())
        {
            yield return branch.Gen;
        }
    }

    private static bool Declares(string? percent) => !string.IsNullOrWhiteSpace(percent);

    /// <summary>One address as it is asked for: a dotted path under two locales is two packs.</summary>
    private static string CacheKey(string dottedPath, string? locale) => dottedPath + "|" + locale;

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
        string key = CacheKey(dottedPath, locale);
        if (_cache.TryGetValue(key, out Entry? cached))
        {
            return cached;
        }

        string @base = BasePath(dottedPath, locale);

        List<string> candidates = Candidates(@base);
        if (candidates.Count > 1)
        {
            // The extension is not part of an address, so two files that differ only by it claim
            // the SAME one. Picking the first silently would make the other dead weight its author
            // cannot see — the run keeps working and reads the same file forever.
            throw new ArgumentException(
                $"duplicate data-pack address \"{AbsoluteAddress(dottedPath, locale)}\" declared "
                    + $"by both \"{LocateOr(candidates[1])}\" and \"{LocateOr(candidates[0])}\""
                    + " — rename or move one");
        }

        string? file = candidates.Count == 0 ? null : candidates[0];

        if (file is null)
        {
            // The path did not answer, so ask the headers: a file may declare its own `address:`
            // and then live anywhere at all — which is how someone keeps a flat folder of their
            // own lists.
            if (!Addresses().TryGetValue(AbsoluteAddress(dottedPath, locale), out string? placed)
                || !Source.Has(placed))
            {
                throw new ArgumentException(
                    $"unknown template path \"{dottedPath}\" (looked for {@base}.txt in {Source})");
            }

            Entry placedEntry = Checked(
                Parse(Source.ReadLines(placed), placed), dottedPath, locale, placed);
            _cache[key] = placedEntry;
            return placedEntry;
        }

        Entry entry = Checked(Parse(Source.ReadLines(file), file), dottedPath, locale, file);
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

    /// <summary>The parameters a generator pack accepts, or <c>null</c> when it is not one.</summary>
    /// <remarks>
    /// A pack's parameters ARE its local <c>&lt;sequence&gt;</c> names: writing
    /// <c>domain="example.test"</c> on the calling <c>&lt;gen&gt;</c> replaces the sequence called
    /// <c>domain</c> with that constant. A single-<c>&lt;gen&gt;</c> pack declares none, and a
    /// plain list of values is not a generator at all — passing anything to either is always a
    /// no-op, so both return an empty set rather than <c>null</c>.
    /// <para>
    /// Read by scanning for <c>&lt;sequence name="…"&gt;</c> rather than by parsing the body: the
    /// validator asks before anything is built, and parsing here would report a pack author's
    /// syntax error at the caller's line.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string>? ParameterNames(string dottedPath, string? locale)
    {
        Entry entry;
        try
        {
            entry = Load(dottedPath, locale);
        }
        catch (Exception)
        {
            return null;
        }

        // DECLARATION order: the names go into a refusal that lists them, and a pack declaring `user` then `domain` was reported as "domain, user".
        var names = new List<string>();
        if (entry.Generator is null)
        {
            // A plain list of values has no parameters at all, which is not the same as
            // "unknown": an attribute aimed at one does nothing, and an attribute that does
            // nothing is indistinguishable from a typo.
            return names;
        }

        foreach (System.Text.RegularExpressions.Match m in SequenceName.Matches(entry.Generator))
        {
            if (!names.Contains(m.Groups[1].Value, StringComparer.Ordinal))
            {
                names.Add(m.Groups[1].Value);
            }
        }

        return names;
    }

    /// <summary>
    /// How many characters each parameter's own sequence produces, where that is a FACT.
    /// </summary>
    /// <remarks>
    /// A pinned parameter replaces the pack's own sequence for the run, and the packs that
    /// carry a check digit compute it over a fixed layout — see <see cref="ParamWidth"/> for
    /// what counts as provable.
    /// </remarks>
    public IReadOnlyDictionary<string, int> ParameterWidths(string dottedPath, string? locale)
    {
        Entry entry;
        try
        {
            entry = Load(dottedPath, locale);
        }
        catch (Exception)
        {
            return new Dictionary<string, int>(StringComparer.Ordinal);
        }

        return entry.Generator is null
            ? new Dictionary<string, int>(StringComparer.Ordinal)
            : ParamWidth.ParameterWidths(entry.Generator);
    }

    private static readonly System.Text.RegularExpressions.Regex SequenceName =
        new("<sequence\\s+[^>]*name\\s*=\\s*\"([^\"]+)\"",
            System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Every address these packs can answer to, in no particular order.</summary>
    /// <remarks>
    /// The quick API needs the whole list rather than a yes-or-no about one address: to say "did
    /// you mean" it has to compare what was typed against all of them. Building the index is the
    /// cost of the first call only.
    /// </remarks>
    public IReadOnlyCollection<string> AddressList() => Addresses().Keys;

    /// <summary>Every pack file's address, read from its header — built once, kept.</summary>
    /// <remarks>
    /// A header may carry <c>address:</c> (authoritative) and <c>locale:</c> (used only when the
    /// path-derived address has no locale of its own). A file that resolves to neither a locale, a
    /// country nor a folder of its own is not addressable and is left out, which is the rule the
    /// reference applies.
    /// </remarks>
    private Dictionary<string, string> Addresses()
    {
        if (_addressIndex is not null)
        {
            return _addressIndex;
        }

        var index = new Dictionary<string, string>(StringComparer.Ordinal);
        var dropped = new List<Diagnostic>();
        foreach (string file in Source.ListFiles())
        {
            IReadOnlyList<string> lines = Source.ReadLines(file);
            Dictionary<string, string> header = HeaderOf(lines);
            string address;
            if (header.TryGetValue("address", out string? declared)
                && !string.IsNullOrWhiteSpace(declared))
            {
                address = declared.Trim();
            }
            else
            {
                string derived = StripExtension(file).Replace('/', '.');
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
                    if (HasHeader(lines))
                    {
                        dropped.Add(UnaddressableWarning(Source.Locate(file) ?? file, derived));
                    }

                    continue;
                }
            }

            index[address] = file;
        }

        _addressIndex = index;
        _unaddressable = dropped;
        return index;
    }

    /// <summary>Every pack file the address scan read and could not place — TDC171.</summary>
    /// <remarks>
    /// Empty until something has looked an address up and missed, because that is when the scan
    /// runs. The reference walks every pack root before it starts and can therefore say this about
    /// a file no config mentions; here the walk is the fallback path, and a run that resolves
    /// everything by path never pays for it. The author who wrote the unplaceable file always
    /// takes the fallback — their own address is the one that misses — so the file gets named at
    /// the moment it matters. <c>fixtures/cross-language/cli.json</c> records the difference.
    /// </remarks>
    public IReadOnlyList<Diagnostic> HeaderWarnings() => _unaddressable;

    /// <summary>A pack file the scan read and could not address.</summary>
    /// <remarks>
    /// A warning rather than an error: the run continues on everything else, and the author hears
    /// about the file instead of meeting it later as "unknown template path" with nothing to
    /// connect the two.
    /// </remarks>
    private static Diagnostic UnaddressableWarning(string file, string address) =>
        Diagnostic.Warning(
            "TDC171",
            $"data-pack file \"{file}\" is not addressable: \"{address}\" does not match where "
            + "the file is, and its first segment is not a known locale. A folder opens a "
            + "namespace of its own — move the file into one, or give it an `address:` or a "
            + "`locale:` that says where it belongs.",
            $"Data pack file: {file}",
            1,
            0);

    /// <summary>Whether the file opens with the <c>---</c> fence.</summary>
    /// <remarks>
    /// A file with no header at all stays silent when it cannot be placed: it is probably a raw
    /// <c>@data</c> source that happens to sit in a pack folder, not a pack somebody meant to
    /// publish.
    /// </remarks>
    private static bool HasHeader(IReadOnlyList<string> lines) =>
        lines.Count > 0 && lines[0].Trim() == "---";

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
