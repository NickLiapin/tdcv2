namespace Tdcv2.Engine;

/// <summary>
/// A finished run, seen from the outside: how many records, what they are called, what a given
/// record holds.
/// </summary>
/// <remarks>
/// What the public API needs, and the only thing the engines have to agree on. One holds every
/// column in memory and answers instantly; another computes the value when asked and forgets it
/// again. A caller iterating rows cannot tell which it has, which is the point — the engine is a
/// performance decision, not a difference in the data.
/// </remarks>
public interface IRowSource
{
    /// <summary>The number of records.</summary>
    int Count { get; }

    /// <summary>The declared sequences, in declaration order; the built-in <c>_</c>-names are left out.</summary>
    IReadOnlyList<string> SequenceNames { get; }

    /// <summary>One value, or <c>null</c> when the sequence does not apply to that record.</summary>
    string? Value(string column, int row);

    /// <summary>The whole run as text — what the config's <c>&lt;data&gt;</c> block produces.</summary>
    string Text();

    /// <summary>
    /// The same output, written out rather than returned.
    /// </summary>
    /// <remarks>
    /// The default builds the string first, which is right for a source that already holds the whole
    /// run. A streaming source overrides it to write record by record — otherwise the one call that
    /// most needs bounded memory would be the one that assembles the entire output first.
    /// </remarks>
    void WriteTo(TextWriter output) => output.Write(Text());
}
