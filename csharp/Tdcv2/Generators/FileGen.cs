using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Tdcv2.Prng;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="file" src="./products.txt"/&gt;</c> — values from the user's own file.
/// </summary>
/// <remarks>
/// <para>
/// Two shapes. A plain list is one value per line, blanks skipped. With <c>column=</c> the file is
/// read as CSV and one column is taken from it — by header name, or by 1-based position when the
/// column is written as a number.
/// </para>
/// <para>
/// This is how a run gets the real thing: the actual product catalogue, the actual list of branch
/// codes. Generated data is only as convincing as the vocabulary it draws from, and no bundled pack
/// knows one particular company's part numbers.
/// </para>
/// </remarks>
public static class FileGen
{
    /// <summary>The prefix that says "look in the configured data folders, not next to the config".</summary>
    public const string DataAlias = "@data/";

    private static readonly Regex Numbered = new("^[1-9][0-9]*$", RegexOptions.Compiled);

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, string? baseDir, Sfc32 prng,
        IReadOnlyList<string>? roots = null)
    {
        IReadOnlyList<string> values = Load(attrs, baseDir, roots);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            result.Add(Rand.Pick(prng, values));
        }

        return result;
    }

    /// <summary>
    /// Values and their shares, when <c>weight="countColumn"</c> names a second column.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Without it a list is drawn uniformly, so <c>Smith</c> and <c>Zabrowski</c> turn up equally
    /// often. Real distributions are never flat — the commonest surnames cover a large part of a
    /// population and the tail is vanishingly rare — and flattening that is the first thing anyone
    /// looking at the data notices.
    /// </para>
    /// <para>
    /// The shares are honoured exactly, through the same apportionment <c>percent=</c> uses: weights
    /// of 20000 and 10000 over 30000 rows give precisely 20000 and 10000, not "about twice as many".
    /// A weight is a raw count, not a percentage, because census and registry files publish counts
    /// and normalising them by hand is a pointless invitation to arithmetic errors.
    /// </para>
    /// </remarks>
    public sealed record Weighted(IReadOnlyList<string> Values, double[] Percents);

    /// <summary><c>null</c> when the generator is not weighted, which is the ordinary case.</summary>
    public static Weighted? LoadWeighted(
        IReadOnlyDictionary<string, string> attrs, string? baseDir,
        IReadOnlyList<string>? roots = null)
    {
        string? weightColumn = TrimToNull(attrs.GetValueOrDefault("weight"));
        if (weightColumn is null)
        {
            return null;
        }

        string column = TrimToNull(attrs.GetValueOrDefault("column"))
            ?? throw new ArgumentException(
                $"file generator: weight=\"{weightColumn}\" needs a \"column\" to weight");

        string path = Resolve(attrs.GetValueOrDefault("src", "").Trim(), baseDir, roots);
        char delimiter = ParseDelimiter(attrs.GetValueOrDefault("delimiter"));
        List<List<string>> rows = NonBlankRows(Read(path), delimiter);
        if (rows.Count == 0)
        {
            throw new ArgumentException($"file generator: CSV file at \"{path}\" is empty");
        }

        List<string> header = rows[0];
        int valueIndex = ColumnIndex(header, column);
        int weightIndex = ColumnIndex(header, weightColumn);
        if (weightIndex == valueIndex)
        {
            throw new ArgumentException(
                $"file generator: weight column \"{weightColumn}\" is the same column as the values");
        }

        var values = new List<string>();
        var counts = new List<double>();
        double total = 0;
        for (int i = 1; i < rows.Count; i++)
        {
            List<string> row = rows[i];
            string value = valueIndex < row.Count ? row[valueIndex].Trim() : "";
            if (value.Length == 0)
            {
                continue;
            }

            double weight = ParseWeight(
                weightIndex < row.Count ? row[weightIndex].Trim() : "", value, weightColumn);

            // A zero weight means never drawn, so carrying it costs memory and buys nothing.
            if (weight == 0)
            {
                continue;
            }

            values.Add(value);
            counts.Add(weight);
            total += weight;
        }

        if (values.Count == 0)
        {
            throw new ArgumentException(
                $"file generator: no values with a positive weight in column \"{weightColumn}\"");
        }

        return new Weighted(values, counts.Select(c => c / total * 100).ToArray());
    }

    /// <summary>
    /// A CSV read as whole rows, for <c>row="key"</c>.
    /// </summary>
    /// <remarks>
    /// Several sequences naming the same key read different columns of the <em>same</em> row, so a
    /// generated city and its postcode come from one real record rather than from two unrelated
    /// ones. Without it, drawing a city and a postcode independently produces pairs that no
    /// validator and no human would accept.
    /// </remarks>
    public sealed record RowSource(
        IReadOnlyList<List<string>> Rows, List<string> Header, int ColumnIndex, string SourceKey);

    public static RowSource LoadRows(
        IReadOnlyDictionary<string, string> attrs, string? baseDir,
        IReadOnlyList<string>? roots = null)
    {
        string column = TrimToNull(attrs.GetValueOrDefault("column"))
            ?? throw new ArgumentException(
                "sequence: row-linked file generator requires a CSV \"column\" attribute");

        string src = attrs.GetValueOrDefault("src", "").Trim();
        string path = Resolve(src, baseDir, roots);
        char delimiter = ParseDelimiter(attrs.GetValueOrDefault("delimiter"));

        List<List<string>> all = NonBlankRows(Read(path), delimiter);
        if (all.Count == 0)
        {
            throw new ArgumentException($"file generator: CSV file at \"{src}\" is empty");
        }

        int columnIndex = ColumnIndex(all[0], column);
        bool numbered = Numbered.IsMatch(column);
        bool skipHeader = ParseHeaderFlag(attrs.GetValueOrDefault("header")) || !numbered;
        List<List<string>> rows = skipHeader ? all.Skip(1).ToList() : all;

        if (rows.Count == 0)
        {
            throw new ArgumentException(
                $"file generator: CSV file at \"{src}\" has no data rows");
        }

        if (!rows.Any(row => columnIndex < row.Count && row[columnIndex].Trim().Length > 0))
        {
            throw new ArgumentException(
                $"file generator: CSV column \"{column}\" at \"{src}\" has no values");
        }

        // The header is kept: `rows` may have had it stripped, so a second column named later — a
        // weight column — has to be resolved against the original.
        //
        // Two sequences on one key must be reading one file; SourceKey identifies which.
        return new RowSource(rows, all[0], columnIndex, $"{path}|{delimiter}|{skipHeader}");
    }

    /// <summary>One row's cell in the linked column, trimmed and never null.</summary>
    public static string CellAt(RowSource source, int rowIndex)
    {
        List<string> row = source.Rows[rowIndex];
        return source.ColumnIndex < row.Count ? row[source.ColumnIndex].Trim() : "";
    }

    /// <summary>
    /// Row indexes drawn to the exact quota of a weight column — the row-linked counterpart of
    /// <see cref="LoadWeighted"/>, so every field on the link follows the same weighted rows.
    /// </summary>
    public static Weighted? WeightedRows(
        IReadOnlyDictionary<string, string> attrs, RowSource source)
    {
        string? weightColumn = TrimToNull(attrs.GetValueOrDefault("weight"));
        if (weightColumn is null)
        {
            return null;
        }

        int weightIndex = ColumnIndex(source.Header, weightColumn);
        if (weightIndex == source.ColumnIndex)
        {
            throw new ArgumentException(
                $"file generator: weight column \"{weightColumn}\" is the same column as the values");
        }

        var indexes = new List<string>();
        var counts = new List<double>();
        double total = 0;
        for (int i = 0; i < source.Rows.Count; i++)
        {
            string value = CellAt(source, i);
            if (value.Length == 0)
            {
                continue;
            }

            List<string> row = source.Rows[i];
            double weight = ParseWeight(
                weightIndex < row.Count ? row[weightIndex].Trim() : "", value, weightColumn);
            if (weight == 0)
            {
                continue;
            }

            indexes.Add(i.ToString(CultureInfo.InvariantCulture));
            counts.Add(weight);
            total += weight;
        }

        if (indexes.Count == 0)
        {
            throw new ArgumentException(
                $"file generator: weight column \"{weightColumn}\" has no rows with a positive weight");
        }

        return new Weighted(indexes, counts.Select(c => c / total * 100).ToArray());
    }

    /// <summary>The file's values in file order — what <c>order="sequential"</c> reads.</summary>
    public static IReadOnlyList<string> Load(
        IReadOnlyDictionary<string, string> attrs, string? baseDir,
        IReadOnlyList<string>? roots = null)
    {
        string? src = attrs.GetValueOrDefault("src");
        if (string.IsNullOrWhiteSpace(src))
        {
            throw new ArgumentException("file generator: \"src\" is required");
        }

        string path = Resolve(src.Trim(), baseDir, roots);
        string content = Read(path);

        string? column = TrimToNull(attrs.GetValueOrDefault("column"));
        if (attrs.ContainsKey("column") && column is null)
        {
            throw new ArgumentException("file generator: column must not be empty");
        }

        IReadOnlyList<string> values =
            column is null ? ListValues(content) : CsvColumn(content, column, attrs, path);
        if (values.Count == 0)
        {
            throw new ArgumentException($"file generator: list at \"{path}\" is empty");
        }

        return values;
    }

    /// <summary>
    /// Where a <c>src=</c> points, in the order the reference implementation looks.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A plain relative path means the file next to the CONFIG, not next to whatever directory the
    /// program happened to be started from — otherwise the same config would work from one shell and
    /// fail from another. When it is not there, the configured data folders are tried, so a config
    /// can be moved without rewriting every source.
    /// </para>
    /// <para>
    /// <c>@data/x.txt</c> skips the config's folder entirely and names the data folders outright.
    /// That is what makes a config portable between machines whose data lives in different places:
    /// the path in the config stays the same and only the configured data folders differ. With no
    /// data folder configured at all the alias cannot mean anything, and saying so is better than
    /// reporting a missing file.
    /// </para>
    /// </remarks>
    public static string Resolve(string src, string? baseDir, IReadOnlyList<string>? roots)
    {
        string text = src.Trim();
        IReadOnlyList<string> candidates = roots ?? Array.Empty<string>();

        if (text.StartsWith("file://", StringComparison.Ordinal))
        {
            return new Uri(text).LocalPath;
        }

        if (text.StartsWith(DataAlias, StringComparison.Ordinal))
        {
            string alias = text[DataAlias.Length..].Trim();
            if (alias.Length == 0)
            {
                throw new ArgumentException(
                    "file generator: @data source path must not be empty");
            }

            if (candidates.Count == 0)
            {
                throw new ArgumentException(
                    "file generator: \"@data/...\" needs at least one data folder — "
                    + "pass a data path, or name one in tdcv2.config.json");
            }

            return FirstReadable(
                candidates.Select(root => Normalize(Path.Combine(root, alias))).ToList());
        }

        if (Path.IsPathRooted(text))
        {
            return text;
        }

        string beside = baseDir is null ? text : Normalize(Path.Combine(baseDir, text));
        if (File.Exists(beside) || candidates.Count == 0)
        {
            return beside;
        }

        var attempts = new List<string> { beside };
        attempts.AddRange(candidates.Select(root => Normalize(Path.Combine(root, text))));
        return FirstReadable(attempts);
    }

    private static string Normalize(string path) => Path.GetFullPath(path);

    /// <summary>The first candidate that exists, or the first tried so the error names something real.</summary>
    private static string FirstReadable(IReadOnlyList<string> attempts) =>
        attempts.FirstOrDefault(File.Exists) ?? attempts[0];

    private static string Read(string path)
    {
        try
        {
            return File.ReadAllText(path, Encoding.UTF8);
        }
        catch (IOException e)
        {
            throw new IOException($"file generator: cannot read \"{path}\"", e);
        }
    }

    private static List<string> ListValues(string content) =>
        Regex.Split(content, "\r?\n")
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .ToList();

    private static List<List<string>> NonBlankRows(string content, char delimiter) =>
        ParseRows(content, delimiter)
            .Where(row => row.Any(cell => !string.IsNullOrWhiteSpace(cell)))
            .ToList();

    private static List<string> CsvColumn(
        string content, string column, IReadOnlyDictionary<string, string> attrs, string path)
    {
        char delimiter = ParseDelimiter(attrs.GetValueOrDefault("delimiter"));
        List<List<string>> rows = NonBlankRows(content, delimiter);
        if (rows.Count == 0)
        {
            throw new ArgumentException($"file generator: CSV file at \"{path}\" is empty");
        }

        int columnIndex = ColumnIndex(rows[0], column);
        // A named column implies a header row; a numbered one only skips it when told to, because a
        // file of pure data has no header to skip.
        bool skipHeader =
            ParseHeaderFlag(attrs.GetValueOrDefault("header")) || !Numbered.IsMatch(column);

        // A blank cell is REFUSED, not skipped. Dropping it takes the row out of the pool, so
        // the file's own proportions stop being the run's: measured on a three-person CSV with
        // one empty email, 60 rows produced 28 and 32 of the other two and no sign of the
        // third. The weighted path refuses the same shape one column over.
        var values = new List<string>();
        for (int i = skipHeader ? 1 : 0; i < rows.Count; i++)
        {
            List<string> row = rows[i];
            string cell = columnIndex < row.Count ? row[columnIndex].Trim() : "";
            if (cell.Length == 0)
            {
                throw new ArgumentException(
                    $"file generator: column \"{column}\" is empty on value row "
                    + $"{values.Count + 1} of \"{path}\" — a blank cell would drop that row from the values and quietly change the proportions. Fill it in, remove the row, or point column= at a column that is complete.");
            }

            values.Add(cell);
        }

        if (values.Count == 0)
        {
            throw new ArgumentException(
                $"file generator: CSV column \"{column}\" at \"{path}\" has no values");
        }

        return values;
    }

    private static int ColumnIndex(IReadOnlyList<string> headerRow, string column)
    {
        if (Numbered.IsMatch(column))
        {
            return int.Parse(column, CultureInfo.InvariantCulture) - 1;
        }

        for (int i = 0; i < headerRow.Count; i++)
        {
            // Stripping the byte-order mark matters more than the stray spaces: Excel writes one
            // ahead of the first header cell, so without this every "Save as CSV" export would fail
            // to resolve its first column by name and no other.
            if (headerRow[i].Replace("﻿", "").Trim() == column)
            {
                return i;
            }
        }

        throw new ArgumentException(
            $"file generator: CSV column \"{column}\" was not found in the header row");
    }

    /// <summary>RFC 4180: quoted fields, doubled quotes inside them, and either line ending.</summary>
    internal static List<List<string>> ParseRows(string content, char delimiter)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        bool inQuotes = false;
        bool quotedField = false;

        for (int i = 0; i < content.Length; i++)
        {
            char ch = content[i];
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (i + 1 < content.Length && content[i + 1] == '"')
                    {
                        field.Append('"');
                        i++;
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    field.Append(ch);
                }

                continue;
            }

            if (ch == '"' && field.Length == 0 && !quotedField)
            {
                inQuotes = true;
                quotedField = true;
                continue;
            }

            if (ch == delimiter)
            {
                row.Add(field.ToString());
                field.Clear();
                quotedField = false;
                continue;
            }

            if (ch == '\n' || ch == '\r')
            {
                if (ch == '\r' && i + 1 < content.Length && content[i + 1] == '\n')
                {
                    i++;
                }

                row.Add(field.ToString());
                field.Clear();
                quotedField = false;
                rows.Add(row);
                row = new List<string>();
                continue;
            }

            field.Append(ch);
        }

        if (inQuotes)
        {
            throw new ArgumentException("file generator: unterminated quoted CSV field");
        }

        if (field.Length > 0 || row.Count > 0 || !content.EndsWith('\n'))
        {
            row.Add(field.ToString());
            rows.Add(row);
        }

        return rows;
    }

    internal static char ParseDelimiter(string? value)
    {
        if (value is null)
        {
            return ',';
        }

        // A single character is taken as written, tab included, so that resolving twice is
        // harmless: trimming a real tab would leave nothing and fall back to a comma.
        if (value.Length == 1)
        {
            return value[0];
        }

        string normalized = value.Trim();
        if (normalized.Length == 0)
        {
            return ',';
        }

        string resolved = normalized.ToLowerInvariant() switch
        {
            "comma" => ",",
            "semicolon" => ";",
            "tab" or "\\t" => "\t",
            "pipe" => "|",
            _ => normalized,
        };

        if (resolved.Length != 1)
        {
            throw new ArgumentException("file generator: delimiter must be one character");
        }

        return resolved[0];
    }

    private static double ParseWeight(string raw, string value, string weightColumn)
    {
        // A blank cell must not slide through as a weight of zero, which would delete the value
        // from the run. A product vanishing from a catalogue because one cell of an export was
        // empty is discovered far too late — and missing data and a deliberate zero are different
        // statements, only one of which is actionable.
        if (raw.Length == 0)
        {
            throw new ArgumentException(
                $"file generator: weight column \"{weightColumn}\" is empty for value \"{value}\" "
                + "— write 0 to exclude it, or fill in the count");
        }

        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double w)
            || !double.IsFinite(w) || w < 0)
        {
            throw new ArgumentException(
                $"file generator: weight \"{raw}\" for value \"{value}\" is not a non-negative number");
        }

        return w;
    }

    private static bool ParseHeaderFlag(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        null => false,
        "true" or "1" => true,
        "false" or "0" => false,
        _ => throw new ArgumentException("file generator: header must be true or false"),
    };

    private static string? TrimToNull(string? value)
    {
        string? trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
