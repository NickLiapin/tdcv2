using System.Globalization;
using Tdcv2.Model;

namespace Tdcv2.Engine;

/// <summary>
/// <c>uniq="true"</c> on a <c>&lt;gen type="http"&gt;</c> sequence: a CHECK of the answers.
/// </summary>
/// <remarks>
/// Everywhere else <c>uniq</c> is a property of a draw — take without replacement, or rearrange —
/// and a service's answer is neither: it belongs to the row it was asked for, and the service
/// answers each row once. So the run cannot MAKE the column unique. What it can do is refuse to
/// write a file that claims to be unique and is not: every answer is read once, before the first
/// row goes out, and the first repeat stops the run with the two rows that share it.
/// <para>
/// The hunt is an external sort, so it holds a sort buffer, not the column. A blank answer is no
/// value at all (<c>on_error="empty"</c>, a <c>parent=</c> row the child does not hold, a
/// <c>missing=</c> draw) and repeats freely. Mirrors <c>typescript/src/sequence/http-uniq.ts</c>.
/// </para>
/// </remarks>
internal static class HttpUniq
{
    private const char Sep = '\0';
    private const int IndexWidth = 16;

    /// <summary>The sequences whose <c>uniq="true"</c> is a check of a service's answers.</summary>
    public static List<string> Sequences(Config config) =>
        config.Sequences
            .Where(s => s.Uniq && s.Gen is { Type: "http" })
            .Select(s => s.Name)
            .ToList();

    /// <summary>Throw, naming the first repeated answer, unless every non-blank answer differs.</summary>
    public static void Check(string name, Func<int, string?> value, int count)
    {
        IEnumerable<string> Records()
        {
            for (int row = 0; row < count; row++)
            {
                string? key = value(row);
                if (!string.IsNullOrEmpty(key))
                {
                    yield return key + Sep + row.ToString(CultureInfo.InvariantCulture).PadLeft(IndexWidth, '0');
                }
            }
        }

        // The groups arrive in key order; the one reported is the first a reader of the file would
        // meet — the lowest row that repeats an answer above it.
        (int A, int B)? first = null;
        int repeats = 0;
        string? current = null;
        var group = new List<int>();

        void Close()
        {
            if (group.Count < 2)
            {
                return;
            }

            repeats += group.Count - 1;
            if (first is null || group[1] < first.Value.B)
            {
                first = (group[0], group[1]);
            }
        }

        foreach (string record in ExternalSort.Sort(Records(), 0, Path.GetTempPath()))
        {
            int split = record.LastIndexOf(Sep);
            string key = record.Substring(0, split);
            if (key != current)
            {
                Close();
                group = new List<int>();
                current = key;
            }

            group.Add(int.Parse(record.Substring(split + 1), CultureInfo.InvariantCulture));
        }

        Close();
        if (first is not (int a, int b))
        {
            return;
        }

        string more = repeats > 1 ? $" ({repeats} rows repeat an earlier answer)" : "";
        throw new InvalidOperationException(
            $"uniq=\"true\" on \"{name}\": the service answered \"{value(a) ?? ""}\" on row {a + 1} "
            + $"and again on row {b + 1}{more} — uniq on an http column checks the answers; it "
            + "cannot ask the service for others");
    }
}
