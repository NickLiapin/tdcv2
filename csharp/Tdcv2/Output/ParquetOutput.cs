using Tdcv2.Engine;
using Tdcv2.Format;
using Tdcv2.Model;
// `Convert` is a Parquet class here and a BCL one everywhere else; the alias keeps the
// two apart at the one call site rather than renaming a type to dodge a collision.
using Tdcv2.Output.Parquet;
using ParquetConvert = Tdcv2.Output.Parquet.Convert;

namespace Tdcv2.Output;

/// <summary>
/// A run written as a typed binary file instead of as text.
/// </summary>
/// <remarks>
/// <para>
/// The same preparation as the text renderer — one engine, one registry — so a config exported to
/// Parquet holds exactly the data it would have printed for that seed. Only the serialisation
/// differs: instead of formatting a record, each named <c>&lt;data&gt;</c> becomes a typed column.
/// </para>
/// <para>
/// Rows go out in row groups, each built, written and released before the next one starts, so memory
/// stays bounded however large the run is.
/// </para>
/// </remarks>
public static class ParquetOutput
{
    /// <summary>
    /// Rows per row group.
    /// </summary>
    /// <remarks>
    /// Bounds peak memory and lets a reader skip whole groups. It is also the unit parallel
    /// generation would split on, because a group's bytes do not depend on where it sits in the file.
    /// </remarks>
    public const int RowGroupRows = 50_000;

    /// <summary>An untyped column is text. Never guess from the values — a string never corrupts data.</summary>
    private static readonly ColumnType DefaultType = ColumnType.Parse("string");

    /// <summary>Write the run to a sink as a <c>.parquet</c> file.</summary>
    public static void Write(
        Config config, IRowSource rows, Stream output, Engine.Progress? onProgress = null)
    {
        Plan plan = BuildPlan(config);
        Writer.Write(plan.Columns, Batches(plan, config, rows, onProgress), output);
    }

    /// <summary>The same, in memory — for a small output and for tests.</summary>
    public static byte[] ToBytes(Config config, IRowSource rows)
    {
        var output = new MemoryStream();
        Write(config, rows, output);
        return output.ToArray();
    }

    /// <summary>The resolved schema, for telling the user which types were chosen.</summary>
    public static IReadOnlyList<Writer.Column> SchemaOf(Config config) => BuildPlan(config).Columns;

    /// <summary>Everything decided before a single row is rendered.</summary>
    private sealed record Plan(
        IReadOnlyList<Columns.Declared> Declared,
        IReadOnlyList<Writer.Column> Columns,
        IReadOnlyList<ColumnType> Types,
        IReadOnlyList<string?> Separators);

    private static Plan BuildPlan(Config config)
    {
        var declared = new List<Columns.Declared>();
        foreach (Line line in config.Block)
        {
            foreach (DataPart part in line.Parts)
            {
                string? name = part.Name?.Trim();
                if (string.IsNullOrEmpty(name))
                {
                    continue; // decorative text, not a column
                }

                ColumnType? type = null;
                if (part.Type is not null)
                {
                    try
                    {
                        type = ColumnType.ParseOutput(part.Type);
                    }
                    catch (ArgumentException e)
                    {
                        throw new ArgumentException($"column \"{name}\": {e.Message}", e);
                    }
                }

                declared.Add(new Columns.Declared(name, part.Text, type));
            }
        }

        if (declared.Count == 0)
        {
            throw new ArgumentException(
                "Parquet output needs at least one named column — add name=\"…\" to a <data> in "
                + "the <block>");
        }

        Columns.CheckUnique(declared);

        var types = new List<ColumnType>(declared.Count);
        var separators = new List<string?>(declared.Count);
        var columns = new List<Writer.Column>(declared.Count);
        foreach (Columns.Declared column in declared)
        {
            ColumnType type = Columns.Resolve(column, config) ?? DefaultType;
            types.Add(type);
            // A declared []T needs a separator too; a comma when the column was typed by hand rather
            // than derived from a repeating generator.
            if (type.IsList)
            {
                string? source = Columns.SoleReference(column.Template, config.Inject ?? "${{%}}");
                string? separator = source is null ? null : Columns.SeparatorOf(source, config);
                separators.Add(separator ?? ",");
            }
            else
            {
                separators.Add(null);
            }

            columns.Add(new Writer.Column(column.Name, type));
        }

        return new Plan(declared, columns, types, separators);
    }

    private static Writer.Batches Batches(
        Plan plan, Config config, IRowSource rows, Engine.Progress? onProgress = null)
    {
        int count = rows.Count;
        int start = 0;

        return () =>
        {
            if (start >= count)
            {
                return null;
            }

            // Once per row group, which is fifty thousand rows: coarser than the text path's
            // half-percent, and it has to be — a row group is the unit this writer works in, and
            // there is no moment inside one where a partial group means anything.
            onProgress?.Invoke("render", start, count);
            int end = Math.Min(start + RowGroupRows, count);
            var batch = new List<List<Writer.Cell>>(plan.Columns.Count);
            for (int i = 0; i < plan.Columns.Count; i++)
            {
                batch.Add(new List<Writer.Cell>(end - start));
            }

            for (int row = start; row < end; row++)
            {
                for (int i = 0; i < plan.Declared.Count; i++)
                {
                    Columns.Declared column = plan.Declared[i];
                    string text = Interpolate.Apply(
                        column.Template, config.Inject, new RowLookup(rows, row));
                    ColumnType type = plan.Types[i];
                    try
                    {
                        if (type.IsList)
                        {
                            // An empty cell is an EMPTY LIST, not a list holding one blank —
                            // splitting "" on a comma would otherwise conjure a phantom element.
                            batch[i].Add(new Writer.Cell.Elements(
                                text.Length == 0
                                    ? Array.Empty<string>()
                                    : Split(text, plan.Separators[i]!)));
                        }
                        else
                        {
                            batch[i].Add(new Writer.Cell.Scalar(ParquetConvert.Of(text, type)));
                        }
                    }
                    catch (ArgumentException e)
                    {
                        throw new ArgumentException(
                            $"column \"{column.Name}\", row {row + 1}: {e.Message}", e);
                    }
                }
            }

            start = end;
            return batch;
        };
    }

    private sealed class RowLookup : Interpolate.ILookup
    {
        private readonly IRowSource _rows;
        private readonly int _row;

        internal RowLookup(IRowSource rows, int row)
        {
            _rows = rows;
            _row = row;
        }

        public bool Has(string name) =>
            _rows.Value(name, _row) is not null || _rows.SequenceNames.Contains(name);

        public string Value(string name) => _rows.Value(name, _row) ?? "";
    }

    /// <summary>A literal split, not a regular expression — the separator is a piece of data.</summary>
    private static List<string> Split(string text, string separator)
    {
        var result = new List<string>();
        int at = 0;
        while (true)
        {
            int next = text.IndexOf(separator, at, StringComparison.Ordinal);
            if (next < 0)
            {
                result.Add(text[at..]);
                return result;
            }

            result.Add(text[at..next]);
            at = next + separator.Length;
        }
    }
}
