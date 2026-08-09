using Tdcv2.Expr;

namespace Tdcv2.Sequence;

using Tdcv2.Prng;

/// <summary>
/// <c>&lt;pool&gt;</c> — a small table computed once, before the rows.
///
/// Twenty doctors for two thousand patients. The problem an ordinary sequence cannot solve: a
/// doctor is not a VALUE, he is a RECORD, and his gender, first name and last name have to agree
/// with each other.
///
/// A pool is not read directly — <c>${{Doctors.lastName}}</c> would give the dot a second meaning
/// next to <c>${{Sequence.Field}}</c>. A sequence draws from it instead, and that hands us the
/// hardest rule for free: one sequence holds one value per row, so every field read from the same
/// reference in the same row comes from the same member.
/// </summary>
public static class Pool
{
    /// <summary>Measured on the reference: ~320 bytes a member with four fields.</summary>
    public const long WarnMembers = 100_000;

    public const long MaxMembers = 1_000_000;

    /// <summary>
    /// The seed a pool's own values are drawn from. Part of the cross-language contract.
    ///
    /// Derived rather than taken off the main stream, so adding a pool to a config leaves every
    /// other column exactly where it was and an old snapshot still matches.
    /// </summary>
    public static string PoolSeed(string seed, string poolName) => $"{seed}#pool:{poolName}";

    /// <summary>The PRNG stream a reference draws its member from. Seekable by row.</summary>
    public static string RefStream(string refName) => $"pool-ref:{refName}";

    public static int PickMember(string seed, string refName, PoolTable table, int row) =>
        Seekable.NextInt(seed, RefStream(refName), row, table.Count);

    /// <summary>
    /// <c>field == Column</c>, recognised only when BOTH sides are what they look like.
    ///
    /// Without the column test, <c>filter="clinic == North"</c> — where North is a bare word,
    /// which the expression language has always allowed and which is the obvious way to write
    /// "northern doctors only" — reads as a comparison against a column named North, finds
    /// nothing, and refuses the run.
    /// </summary>
    public static (string Field, string Column)? ParseEqualityFilter(
        string expression,
        PoolTable table,
        Func<string, bool> isColumn)
    {
        string[] parts = expression.Split("==");
        if (parts.Length != 2)
        {
            return null;
        }

        string left = parts[0].Trim();
        string right = parts[1].Trim();
        if (!Plain(left) || !Plain(right))
        {
            return null;
        }

        if (table.Fields.Contains(left) && isColumn(right))
        {
            return (left, right);
        }

        return table.Fields.Contains(right) && isColumn(left) ? (right, left) : null;
    }

    /// <summary>member value → the members holding it. Built once per reference.</summary>
    public static Dictionary<string, List<int>> BucketByField(PoolTable table, string field)
    {
        var buckets = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        IReadOnlyList<string> column = table.Columns.TryGetValue(field, out IReadOnlyList<string>? c)
            ? c
            : Array.Empty<string>();
        for (int m = 0; m < table.Count; m++)
        {
            // Keyed by MatchKey rather than by the raw text, so the bucket answers the same
            // question `==` would: a member holding "01" is found by a row producing "1",
            // exactly as the general expression path finds it.
            string key = MatchKey.Of(m < column.Count ? column[m] : "");
            if (!buckets.TryGetValue(key, out List<int>? bucket))
            {
                bucket = new List<int>();
                buckets[key] = bucket;
            }

            bucket.Add(m);
        }

        return buckets;
    }

    /// <summary>The refusal a row gets when the filter leaves it with no member at all.</summary>
    /// <summary>
    /// <c>(Clinic="North", Budget="40")</c> — what the row held, for the refusal below.
    /// </summary>
    /// <remarks>
    /// The bucketed <c>field == Column</c> path always named the value a row was looking for; the
    /// general one named nothing, so the reader could not tell a pool missing a member from a
    /// filter that is wrong. What the evaluator ASKED for is what the filter reads, so the names
    /// are recorded during the scan rather than parsed back out of the expression.
    /// </remarks>
    public static string RowValuesDetail(IReadOnlyDictionary<string, string> values)
    {
        if (values.Count == 0)
        {
            return "";
        }

        return " (" + string.Join(", ", values.Select(v => $"{v.Key}=\"{v.Value}\"")) + ")";
    }

    public static string NoCandidateMessage(
        string poolName,
        string expression,
        int row,
        string detail) =>
        $"pool \"{poolName}\": no member satisfies filter=\"{expression}\" for row {row + 1}"
        + $"{detail}. A filter narrows the members a row may draw from; when it narrows them to "
        + "none there is nothing to substitute. Add a member that matches, or widen the filter.";

    private static bool Plain(string text) =>
        text.Length > 0
        && (IsLetter(text[0]) || text[0] == '_')
        && text.All(c => IsLetter(c) || (c >= '0' && c <= '9') || c == '_');

    private static bool IsLetter(char c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/// <summary>
/// A computed pool: <c>Count</c> members, each a set of named fields.
///
/// Column-first because that is how a member is read — a row asks for one field of one member,
/// never for a whole member at once.
/// </summary>
public sealed class PoolTable
{
    public PoolTable(
        string name,
        int count,
        IReadOnlyList<string> fields,
        IReadOnlyDictionary<string, IReadOnlyList<string>> columns)
    {
        Name = name;
        Count = count;
        Fields = fields;
        Columns = columns;
    }

    public string Name { get; }

    public int Count { get; }

    /// <summary>Field names in declaration order.</summary>
    public IReadOnlyList<string> Fields { get; }

    /// <summary>field → one value per member.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Columns { get; }
}
