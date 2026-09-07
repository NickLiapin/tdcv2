namespace Tdcv2.Output.Parquet;

/// <summary>
/// <c>MAP</c> columns: <c>type="{}int64"</c> over a cell that reads <c>alpha:1,beta:2</c>.
/// </summary>
/// <remarks>
/// <para>
/// Parquet stores a map as a repeated group of key/value pairs, so the shape is the LIST shape
/// with two leaves instead of one:
/// </para>
/// <code>
/// required group &lt;name&gt; (MAP) {
///     repeated group key_value {
///         required BYTE_ARRAY key (STRING);
///         required|optional &lt;physical&gt; value;
///     }
/// }
/// </code>
/// <para>
/// Max rep is 1 for both leaves. Max def is 1 for the key — it is REQUIRED, as the format
/// insists, because a pair with no key is not a pair — and 1 or 2 for the value depending on
/// whether it is nullable.
/// </para>
/// <para>
/// The KEY is always text. A cell arrives here as text and Parquet forbids a null key, so a
/// second type parameter would double the syntax to buy a conversion nobody has asked for.
/// </para>
/// <para>
/// Kept apart from the writer so the level streams can be checked against hand-computed ones.
/// Getting them wrong produces a file readers accept and then mis-assemble, which is the worst
/// failure this writer has.
/// </para>
/// </remarks>
public static class MapLevels
{
    /// <summary>The key leaf's max definition level. Always 1: the key is REQUIRED in a pair.</summary>
    public const int KeyMaxDef = 1;

    /// <summary>One pair. A <c>null</c> value is a NULL, which only a nullable map can hold.</summary>
    public sealed record Entry(string Key, string? Value);

    /// <summary>The two leaves' values, and the level streams describing their shape.</summary>
    public sealed record Built(
        IReadOnlyList<string> Keys,
        IReadOnlyList<string> Present,
        int[] RepLevels,
        int[] KeyDefLevels,
        int[] ValueDefLevels,
        int MaxValueDef);

    /// <summary>The max definition level for a map value that is, or is not, nullable.</summary>
    public static int ValueMaxDef(bool valueNullable) => valueNullable ? 2 : 1;

    /// <summary>Split one cell into pairs — <c>alpha:1,beta:2</c> on the column's separator.</summary>
    /// <remarks>
    /// <para>
    /// The key is everything before the FIRST <c>:</c>, the value everything after, so a value may
    /// hold colons (a timestamp does) and a key may not. That asymmetry is the one worth having:
    /// keys are short labels, values are whatever the column generates.
    /// </para>
    /// <para>
    /// Three things are refused rather than guessed at, and each would otherwise produce a map
    /// quietly missing an entry: a piece with no <c>:</c> at all (is it a key with no value, or the
    /// reverse?); an empty key, which Parquet has no way to store; and a key that repeats inside
    /// one row, because readers disagree about which of the two wins and some drop the row's map.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<Entry> ParseCell(string text, string separator, bool valueNullable)
    {
        // An empty cell is an EMPTY MAP, not a map holding one blank pair — the same rule a list
        // follows, for the same reason.
        if (text.Length == 0)
        {
            return Array.Empty<Entry>();
        }

        var entries = new List<Entry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string piece in text.Split(separator))
        {
            int at = piece.IndexOf(':', StringComparison.Ordinal);
            if (at < 0)
            {
                throw new ArgumentException(
                    $"map entry \"{piece}\" has no \":\" — a map cell reads key:value{separator}key:value");
            }

            string key = piece[..at];
            if (key.Length == 0)
            {
                throw new ArgumentException($"map entry \"{piece}\" has an empty key");
            }

            if (!seen.Add(key))
            {
                throw new ArgumentException($"map key \"{key}\" appears twice in one cell");
            }

            string value = piece[(at + 1)..];
            entries.Add(new Entry(key, valueNullable && value.Length == 0 ? null : value));
        }

        return entries;
    }

    /// <summary>The key, value, repetition and definition streams for one map column.</summary>
    /// <remarks>
    /// An empty map still occupies one level slot in BOTH leaves: definition 0 is the statement
    /// "this row has no pairs". Without it the row would vanish from the column, and every row
    /// after it would shift up by one.
    /// </remarks>
    public static Built Build(IReadOnlyList<IReadOnlyList<Entry>> rows, bool valueNullable)
    {
        int deepest = ValueMaxDef(valueNullable);
        var keys = new List<string>();
        var present = new List<string>();
        var repLevels = new List<int>();
        var keyDefLevels = new List<int>();
        var valueDefLevels = new List<int>();

        foreach (IReadOnlyList<Entry> row in rows)
        {
            if (row.Count == 0)
            {
                repLevels.Add(0);
                keyDefLevels.Add(0);
                valueDefLevels.Add(0);
                continue;
            }

            for (int k = 0; k < row.Count; k++)
            {
                Entry entry = row[k];
                repLevels.Add(k == 0 ? 0 : 1);
                keyDefLevels.Add(KeyMaxDef);
                keys.Add(entry.Key);
                if (entry.Value is null)
                {
                    valueDefLevels.Add(deepest - 1); // the pair exists, the value does not
                    continue;
                }

                valueDefLevels.Add(deepest);
                present.Add(entry.Value);
            }
        }

        return new Built(
            keys, present, repLevels.ToArray(), keyDefLevels.ToArray(),
            valueDefLevels.ToArray(), deepest);
    }
}
