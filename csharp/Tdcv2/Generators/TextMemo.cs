using System.Collections.Concurrent;

namespace Tdcv2.Generators;

/// <summary>
/// A bounded cache for a parse whose answer depends on its text alone.
/// </summary>
/// <remarks>
/// The streaming engine draws one value at a time, and for every row it asks a generator to read
/// its own attributes again — a regex pattern, a number range. Those are config constants, and
/// nothing changes a parsed tree after it is built, so parsing each text once gives the same
/// values. Measured: the pattern parse was a third of a regex-heavy run in the other four.
///
/// Cleared wholesale when full rather than tracking recency: a run holds a handful of keys, and the
/// limit only stops a long-lived process that builds many configs from growing without bound. A
/// parse that throws is not kept, so a bad pattern reports the same error every time. Safe to share
/// between the threads of a parallel run.
/// </remarks>
internal sealed class TextMemo<T> where T : class
{
    private const int Limit = 256;

    private readonly ConcurrentDictionary<string, T> _entries = new(StringComparer.Ordinal);
    private readonly Func<string, T> _parse;

    public TextMemo(Func<string, T> parse) => _parse = parse;

    public T Get(string text)
    {
        if (_entries.TryGetValue(text, out T? hit))
        {
            return hit;
        }
        T value = _parse(text);
        if (_entries.Count >= Limit)
        {
            _entries.Clear();
        }
        _entries[text] = value;
        return value;
    }
}
