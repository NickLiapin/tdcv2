namespace Tdcv2.Packs;

/// <summary>
/// Where pack files come from.
/// </summary>
/// <remarks>
/// A folder on disk, or several searched in order. That is how this repository's tests read the same
/// packs the other implementations read, and how a project adds its own — a pack downloaded into a
/// project belongs to the project, not to whichever runtime happens to read it.
/// </remarks>
public interface IPackSource
{
    /// <summary>Whether a pack exists at this path, e.g. <c>en/person/lastName.txt</c>.</summary>
    bool Has(string relativePath);

    IReadOnlyList<string> ReadLines(string relativePath);

    /// <summary>Every pack file this source can serve, as relative paths.</summary>
    /// <remarks>
    /// The address index is built from this. A file's header may place it at an address that has
    /// nothing to do with its path, and the only way to know is to look inside every file — which
    /// is why this exists and why the scan is deferred until a path lookup has already missed.
    /// </remarks>
    IReadOnlyList<string> ListFiles();

    /// <summary>
    /// Whether a top-level folder by this name exists — <c>en</c>, <c>usa</c>, <c>common</c>.
    /// </summary>
    /// <remarks>
    /// This is how a dotted address is judged absolute or relative: <c>usa.ssn</c> names a country
    /// pack directly, while <c>person.lastName</c> is relative to the active locale.
    /// </remarks>
    bool HasTopLevel(string name);

    /// <summary>
    /// Whether <c>countries/&lt;name&gt;</c> exists.
    /// </summary>
    /// <remarks>
    /// The <c>countries/</c> folder is a physical grouping, not part of an address: a pack at
    /// <c>countries/usa/finance/aba_routing.txt</c> is addressed as
    /// <c>usa.finance.aba_routing</c>. Without this, every country pack would look like a relative
    /// address and be searched for under the active locale, where it is not.
    /// </remarks>
    bool HasCountry(string name);
}

/// <summary>One folder of packs.</summary>
public sealed class DirectorySource : IPackSource
{
    private readonly string _root;

    public DirectorySource(string root) => _root = root;

    private string Resolve(string relativePath) =>
        Path.Combine(_root, relativePath.Replace('/', Path.DirectorySeparatorChar));

    public bool Has(string relativePath) => File.Exists(Resolve(relativePath));

    public IReadOnlyList<string> ReadLines(string relativePath) =>
        File.ReadAllLines(Resolve(relativePath));

    public IReadOnlyList<string> ListFiles()
    {
        if (!Directory.Exists(_root))
        {
            return Array.Empty<string>();
        }

        string[] found = Directory.GetFiles(_root, "*.txt", SearchOption.AllDirectories);
        var relative = new List<string>(found.Length);
        foreach (string path in found)
        {
            relative.Add(
                Path.GetRelativePath(_root, path).Replace(Path.DirectorySeparatorChar, '/'));
        }

        relative.Sort(StringComparer.Ordinal);
        return relative;
    }

    public bool HasTopLevel(string name) => Directory.Exists(Path.Combine(_root, name));

    public bool HasCountry(string name) =>
        Directory.Exists(Path.Combine(_root, "countries", name));

    public override string ToString() => _root;
}

/// <summary>
/// Several sources searched in order, the last one winning.
/// </summary>
/// <remarks>
/// This is what lets a project's own packs shadow the bundled ones without replacing them: a
/// downloaded or hand-written pack at the same address is found first, and everything else still
/// resolves. The order is low priority to high, so the search runs backwards.
/// </remarks>
public sealed class LayeredSource : IPackSource
{
    private readonly IReadOnlyList<IPackSource> _sources;

    public LayeredSource(IReadOnlyList<IPackSource> sources) => _sources = sources.ToArray();

    private IPackSource? Owning(string relativePath)
    {
        for (int i = _sources.Count - 1; i >= 0; i--)
        {
            if (_sources[i].Has(relativePath))
            {
                return _sources[i];
            }
        }

        return null;
    }

    public bool Has(string relativePath) => Owning(relativePath) is not null;

    public IReadOnlyList<string> ReadLines(string relativePath) =>
        Owning(relativePath)?.ReadLines(relativePath)
        ?? throw new FileNotFoundException($"no pack source holds \"{relativePath}\"");

    public IReadOnlyList<string> ListFiles()
    {
        var out_ = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (IPackSource source in _sources)
        {
            foreach (string path in source.ListFiles())
            {
                if (seen.Add(path))
                {
                    out_.Add(path);
                }
            }
        }

        return out_;
    }

    public bool HasTopLevel(string name) => _sources.Any(s => s.HasTopLevel(name));

    public bool HasCountry(string name) => _sources.Any(s => s.HasCountry(name));

    public override string ToString() => string.Join(", ", _sources);
}
