using System.Globalization;
using System.Text;
using Tdcv2.Expr;
using Tdcv2.Format;
using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Sequence;

namespace Tdcv2.Engine;

/// <summary>
/// <c>each="NAME"</c> on a <c>&lt;line&gt;</c> or a <c>&lt;group&gt;</c> — its output once per
/// element of a list or record of a pool.
/// </summary>
/// <remarks>
/// Shared by the in-memory and the streaming engine, which used to carry a copy each. Both copies
/// asked a <c>&lt;data if=…&gt;</c> once per ROW, so a condition naming the element — <c>_item</c>,
/// or the list itself — saw the row instead; the reference asks it once per element, with the
/// element in scope.
///
/// The walked name is a list (a <c>repeat=</c> sequence) or a pool. A list element overlays the
/// name itself; a pool record overlays every field as <c>Pool.field</c>, nested records included
/// (<c>Doctors.dept.name</c>), since the pool table publishes them under those paths. The
/// <c>if=</c> is asked of each element too, and the positions — <c>Pool._item</c>,
/// <c>Pool._first</c>, <c>Pool._last</c> — are counted over the elements it KEEPS: <c>_last</c>
/// is the last line printed, which is what a JSON array needs to know before its comma, whatever
/// the filter dropped after it.
///
/// A <c>&lt;group&gt;</c> nests: its element is in scope for every line inside it, an inner
/// group's on top of an outer one's.
/// </remarks>
internal static class Each
{
    /// <summary>The output lines of one <c>each</c> line on one row, each with its newline attached.</summary>
    internal static IReadOnlyList<string> Render(
        Line line, string name, int row, string? inject,
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo, Func<string, PoolTable?> pools,
        Interpolate.ILookup baseLookup)
    {
        var result = new List<string>();
        foreach (Dictionary<string, string> overlay in Overlays(name, line.IfExpr, row, eachInfo, pools, baseLookup))
        {
            result.Add(TextOf(line, inject, new Overlay(baseLookup, overlay)));
        }

        return result;
    }

    /// <summary>
    /// <c>&lt;group&gt;</c>: its lines and groups, once per element it walks — or once, or not at all.
    /// </summary>
    /// <remarks>
    /// With <c>each=</c> the items print once per element of a list or record of a pool, with that
    /// element in scope for every one of them, so an inner <c>each</c> can keep the doctors of the
    /// department being printed (<c>Doctors.dept.id == Depts.id</c>). Without it, <c>if=</c> decides
    /// all of them at once, in the scope around the group.
    /// </remarks>
    internal static IReadOnlyList<string> RenderGroup(
        Line group, int row, string? inject,
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo, Func<string, PoolTable?> pools,
        Interpolate.ILookup baseLookup)
    {
        string name = group.Each?.Trim() ?? string.Empty;
        List<Dictionary<string, string>> scopes = name.Length == 0
            ? (Holds(group.IfExpr, new Overlay(baseLookup, Empty))
                ? new List<Dictionary<string, string>> { Empty }
                : new List<Dictionary<string, string>>())
            : Overlays(name, group.IfExpr, row, eachInfo, pools, baseLookup);
        var result = new List<string>();
        foreach (Dictionary<string, string> overlay in scopes)
        {
            var view = new Overlay(baseLookup, overlay);
            foreach (Line item in group.Items ?? Array.Empty<Line>())
            {
                result.AddRange(RenderItem(item, row, inject, eachInfo, pools, view));
            }
        }

        return result;
    }

    private static readonly Dictionary<string, string> Empty = new(StringComparer.Ordinal);

    /// <summary>One line or group inside a group, in the scope the groups around it put in place.</summary>
    private static IReadOnlyList<string> RenderItem(
        Line item, int row, string? inject,
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo, Func<string, PoolTable?> pools,
        Interpolate.ILookup view)
    {
        if (item.IsGroup)
        {
            return RenderGroup(item, row, inject, eachInfo, pools, view);
        }

        string name = item.Each?.Trim() ?? string.Empty;
        if (name.Length > 0)
        {
            return Render(item, name, row, inject, eachInfo, pools, view);
        }

        if (!Holds(item.IfExpr, new Overlay(view, Empty)))
        {
            return Array.Empty<string>();
        }

        return new[] { TextOf(item, inject, view) };
    }

    /// <summary>One printed line: the parts whose condition holds, interpolated, newline attached.</summary>
    private static string TextOf(Line line, string? inject, Interpolate.ILookup view)
    {
        var scope = new Overlay(view, Empty);
        var template = new StringBuilder();
        foreach (DataPart part in line.Parts)
        {
            if (Holds(part.IfExpr, scope))
            {
                template.Append(part.Text);
            }
        }

        return Interpolate.Apply(template.ToString(), inject, scope) + "\n";
    }

    /// <summary>One overlay per element printed, positions included, after <c>keep</c> dropped some.</summary>
    private static List<Dictionary<string, string>> Overlays(
        string name, string? keep, int row,
        IReadOnlyDictionary<string, Repeat.Spec> eachInfo, Func<string, PoolTable?> pools,
        Interpolate.ILookup baseLookup)
    {
        var candidates = new List<Dictionary<string, string>>();

        // A sequence of the same name wins over a pool, as it does everywhere a name is read.
        PoolTable? table = baseLookup.Has(name) ? null : pools(name);
        if (table is not null)
        {
            for (int m = 0; m < table.Count; m++)
            {
                string position = (m + 1).ToString(CultureInfo.InvariantCulture);
                var overlay = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["_item"] = position,
                    ["_item_id"] = position,
                };
                foreach (string field in table.Fields)
                {
                    overlay[name + "." + field] =
                        table.Columns.TryGetValue(field, out IReadOnlyList<string>? column)
                            ? column[m]
                            : "";
                }

                candidates.Add(overlay);
            }
        }
        else
        {
            Repeat.Spec? spec = eachInfo.TryGetValue(name, out Repeat.Spec found) ? found : null;
            string cell = baseLookup.Has(name) ? baseLookup.Value(name) ?? "" : "";
            IReadOnlyList<string> elements =
                Repeat.Split(cell, spec?.Separator ?? Repeat.DefaultSeparator);

            // Lanes: two repeating sequences write into the same child table, so each gets its
            // own slice of every card's key block rather than sharing one counter.
            int lane = 0;
            int stride = 0;
            foreach (KeyValuePair<string, Repeat.Spec> entry in eachInfo)
            {
                if (entry.Key == name)
                {
                    lane = stride;
                }

                stride += entry.Value.Max;
            }

            if (stride == 0)
            {
                stride = elements.Count;
            }

            for (int k = 0; k < elements.Count; k++)
            {
                candidates.Add(new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [name] = elements[k],
                    ["_item"] = (k + 1).ToString(CultureInfo.InvariantCulture),
                    ["_item_id"] = Repeat.ItemKey(row + 1, k + 1, lane, stride)
                        .ToString(CultureInfo.InvariantCulture),
                });
            }
        }

        var kept = candidates.Where(overlay => Holds(keep, new Overlay(baseLookup, overlay))).ToList();
        for (int k = 0; k < kept.Count; k++)
        {
            Dictionary<string, string> overlay = kept[k];
            overlay[name + "._item"] = (k + 1).ToString(CultureInfo.InvariantCulture);
            overlay[name + "._first"] = k == 0 ? "true" : "false";
            overlay[name + "._last"] = k == kept.Count - 1 ? "true" : "false";
        }

        return kept;
    }

    private static bool Holds(string? expression, Overlay view) =>
        expression is null || Evaluate.AsCondition(expression, view);

    /// <summary>The scope around, with one element's names laid over it.</summary>
    /// <remarks>
    /// Shallow on purpose: every other column still resolves per record, which is exactly what
    /// makes a foreign key on the repeated line point at the right parent on every emitted row.
    /// The same view serves the expression layer, so <c>${{X}}</c> and <c>if="X"</c> can never
    /// disagree about what a name means on a line.
    /// </remarks>
    private sealed class Overlay : Interpolate.ILookup, Evaluate.IScope
    {
        private readonly Interpolate.ILookup _base;
        private readonly Dictionary<string, string> _values;

        internal Overlay(Interpolate.ILookup baseLookup, Dictionary<string, string> values)
        {
            _base = baseLookup;
            _values = values;
        }

        public bool Has(string name) => _values.ContainsKey(name) || _base.Has(name);

        public string Value(string name) =>
            _values.TryGetValue(name, out string? value)
                ? value
                : _base.Has(name) ? _base.Value(name) ?? "" : "";
    }
}
