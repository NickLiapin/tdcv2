package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Random;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="file" src="./products.txt"/>} — values from the user's own file.
 *
 * <p>Two shapes. A plain list is one value per line, blanks skipped. With {@code column=} the
 * file is read as CSV and one column is taken from it — by header name, or by 1-based position
 * when the column is written as a number.
 *
 * <p>This is how a run gets the real thing: the actual product catalogue, the actual list of
 * branch codes. Generated data is only as convincing as the vocabulary it draws from, and no
 * bundled pack knows one particular company's part numbers.
 */
public final class FileGen {

  private FileGen() {}

  public static List<String> generate(
      Map<String, String> attrs, int count, Path baseDir, Prng.Sfc32 prng) {
    return generate(attrs, count, baseDir, prng, List.of());
  }

  public static List<String> generate(
      Map<String, String> attrs, int count, Path baseDir, Prng.Sfc32 prng, List<Path> roots) {
    List<String> values = load(attrs, baseDir, roots);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add(Random.pick(prng, values));
    }
    return out;
  }

  /**
   * Values and their shares, when {@code weight="countColumn"} names a second column.
   *
   * <p>Without it a list is drawn uniformly, so {@code Smith} and {@code Zabrowski} turn up
   * equally often. Real distributions are never flat — the commonest surnames cover a large part
   * of a population and the tail is vanishingly rare — and flattening that is the first thing
   * anyone looking at the data notices.
   *
   * <p>The shares are honoured exactly, through the same apportionment {@code percent=} uses:
   * weights of 20000 and 10000 over 30000 rows give precisely 20000 and 10000, not "about twice
   * as many". A weight is a raw count, not a percentage, because census and registry files
   * publish counts and normalising them by hand is a pointless invitation to arithmetic errors.
   */
  public record Weighted(List<String> values, double[] percents) {}

  /** {@code null} when the generator is not weighted, which is the ordinary case. */
  public static Weighted loadWeighted(Map<String, String> attrs, Path baseDir) {
    return loadWeighted(attrs, baseDir, List.of());
  }

  public static Weighted loadWeighted(
      Map<String, String> attrs, Path baseDir, List<Path> roots) {
    String weightColumn = trimToNull(attrs.get("weight"));
    if (weightColumn == null) {
      return null;
    }
    String column = trimToNull(attrs.get("column"));
    if (column == null) {
      throw new IllegalArgumentException(
          "file generator: weight=\"" + weightColumn + "\" needs a \"column\" to weight");
    }

    Path path = resolve(attrs.get("src").trim(), baseDir, roots);
    char delimiter = parseDelimiter(attrs.get("delimiter"));
    List<List<String>> rows = new ArrayList<>();
    for (List<String> row : parseRows(read(path), delimiter)) {
      boolean allBlank = true;
      for (String cell : row) {
        if (!cell.isBlank()) {
          allBlank = false;
          break;
        }
      }
      if (!allBlank) {
        rows.add(row);
      }
    }
    if (rows.isEmpty()) {
      throw new IllegalArgumentException("file generator: CSV file at \"" + path + "\" is empty");
    }

    List<String> header = rows.get(0);
    int valueIndex = columnIndex(header, column);
    int weightIndex = columnIndex(header, weightColumn);
    if (weightIndex == valueIndex) {
      throw new IllegalArgumentException(
          "file generator: weight column \"" + weightColumn + "\" is the same column as the values");
    }

    List<String> values = new ArrayList<>();
    List<Double> counts = new ArrayList<>();
    double total = 0;
    for (int i = 1; i < rows.size(); i++) {
      List<String> row = rows.get(i);
      String value = valueIndex < row.size() ? row.get(valueIndex).trim() : "";
      // The same refusal the plain path makes, for the same reason.
      if (value.isEmpty()) {
        throw new IllegalArgumentException(
            "file generator: column \"" + column + "\" is empty on value row " + i
                + " — a blank cell would drop that row from the values and quietly change the proportions. Fill it in, remove the row, or point column= at a column that is complete.");
      }
      String raw = weightIndex < row.size() ? row.get(weightIndex).trim() : "";
      // A blank cell must not slide through as a weight of zero, which would delete the value
      // from the run. A product vanishing from a catalogue because one cell of an export was
      // empty is discovered far too late — and missing data and a deliberate zero are different
      // statements, only one of which is actionable.
      if (raw.isEmpty()) {
        throw new IllegalArgumentException(
            "file generator: weight column \""
                + weightColumn
                + "\" is empty for value \""
                + value
                + "\" — write 0 to exclude it, or fill in the count");
      }
      double weight;
      try {
        weight = Double.parseDouble(raw);
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(
            "file generator: weight \"" + raw + "\" for value \"" + value + "\" is not a non-negative number");
      }
      if (!Double.isFinite(weight) || weight < 0) {
        throw new IllegalArgumentException(
            "file generator: weight \"" + raw + "\" for value \"" + value + "\" is not a non-negative number");
      }
      // A zero weight means never drawn, so carrying it costs memory and buys nothing.
      if (weight == 0) {
        continue;
      }
      values.add(value);
      counts.add(weight);
      total += weight;
    }

    if (values.isEmpty()) {
      throw new IllegalArgumentException(
          "file generator: no values with a positive weight in column \"" + weightColumn + "\"");
    }

    double[] percents = new double[counts.size()];
    for (int i = 0; i < counts.size(); i++) {
      percents[i] = counts.get(i) / total * 100;
    }
    return new Weighted(values, percents);
  }

  /**
   * A CSV read as whole rows, for {@code row="key"}.
   *
   * <p>Several sequences naming the same key read different columns of the <em>same</em> row, so
   * a generated city and its postcode come from one real record rather than from two unrelated
   * ones. Without it, drawing a city and a postcode independently produces pairs that no
   * validator and no human would accept.
   */
  public record RowSource(
      List<List<String>> rows, List<String> header, int columnIndex, String sourceKey) {}

  public static RowSource loadRows(Map<String, String> attrs, Path baseDir) {
    return loadRows(attrs, baseDir, List.of());
  }

  public static RowSource loadRows(
      Map<String, String> attrs, Path baseDir, List<Path> roots) {
    String column = trimToNull(attrs.get("column"));
    if (column == null) {
      throw new IllegalArgumentException(
          "sequence: row-linked file generator requires a CSV \"column\" attribute");
    }
    String src = attrs.get("src") == null ? "" : attrs.get("src").trim();
    Path path = resolve(src, baseDir, roots);
    char delimiter = parseDelimiter(attrs.get("delimiter"));

    List<List<String>> all = new ArrayList<>();
    for (List<String> row : parseRows(read(path), delimiter)) {
      boolean allBlank = true;
      for (String cell : row) {
        if (!cell.isBlank()) {
          allBlank = false;
          break;
        }
      }
      if (!allBlank) {
        all.add(row);
      }
    }
    if (all.isEmpty()) {
      throw new IllegalArgumentException("file generator: CSV file at \"" + src + "\" is empty");
    }

    int columnIndex = columnIndex(all.get(0), column);
    boolean numbered = column.matches("^[1-9][0-9]*$");
    boolean skipHeader = parseHeaderFlag(attrs.get("header")) || !numbered;
    List<List<String>> rows = skipHeader ? all.subList(1, all.size()) : all;

    if (rows.isEmpty()) {
      throw new IllegalArgumentException(
          "file generator: CSV file at \"" + src + "\" has no data rows");
    }
    boolean any = false;
    for (List<String> row : rows) {
      if (columnIndex < row.size() && !row.get(columnIndex).trim().isEmpty()) {
        any = true;
        break;
      }
    }
    if (!any) {
      throw new IllegalArgumentException(
          "file generator: CSV column \"" + column + "\" at \"" + src + "\" has no values");
    }
    // The header is kept: `rows` may have had it stripped, so a second column named later —
    // a weight column — has to be resolved against the original.
    //
    // Two sequences on one key must be reading one file; sourceKey identifies which.
    return new RowSource(
        rows, all.get(0), columnIndex, path + "|" + delimiter + "|" + skipHeader);
  }

  /** One row's cell in the linked column, trimmed and never null. */
  public static String cellAt(RowSource source, int rowIndex) {
    List<String> row = source.rows().get(rowIndex);
    return source.columnIndex() < row.size() ? row.get(source.columnIndex()).trim() : "";
  }

  /**
   * Row indexes drawn to the exact quota of a weight column — the row-linked counterpart of
   * {@link #loadWeighted}, so every field on the link follows the same weighted rows.
   */
  public static Weighted weightedRows(Map<String, String> attrs, RowSource source) {
    String weightColumn = trimToNull(attrs.get("weight"));
    if (weightColumn == null) {
      return null;
    }
    int weightIndex = columnIndex(source.header(), weightColumn);
    if (weightIndex == source.columnIndex()) {
      throw new IllegalArgumentException(
          "file generator: weight column \"" + weightColumn + "\" is the same column as the values");
    }

    List<String> indexes = new ArrayList<>();
    List<Double> counts = new ArrayList<>();
    double total = 0;
    for (int i = 0; i < source.rows().size(); i++) {
      String value = cellAt(source, i);
      if (value.isEmpty()) {
        continue;
      }
      List<String> row = source.rows().get(i);
      String raw = weightIndex < row.size() ? row.get(weightIndex).trim() : "";
      if (raw.isEmpty()) {
        throw new IllegalArgumentException(
            "file generator: weight column \""
                + weightColumn
                + "\" is empty for value \""
                + value
                + "\" — write 0 to exclude it, or fill in the count");
      }
      double weight;
      try {
        weight = Double.parseDouble(raw);
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(
            "file generator: weight \"" + raw + "\" for value \"" + value + "\" is not a non-negative number");
      }
      if (!Double.isFinite(weight) || weight < 0) {
        throw new IllegalArgumentException(
            "file generator: weight \"" + raw + "\" for value \"" + value + "\" is not a non-negative number");
      }
      if (weight == 0) {
        continue;
      }
      indexes.add(String.valueOf(i));
      counts.add(weight);
      total += weight;
    }
    if (indexes.isEmpty()) {
      throw new IllegalArgumentException(
          "file generator: weight column \"" + weightColumn + "\" has no rows with a positive weight");
    }
    double[] percents = new double[counts.size()];
    for (int i = 0; i < counts.size(); i++) {
      percents[i] = counts.get(i) / total * 100;
    }
    return new Weighted(indexes, percents);
  }

  /** The file's values in file order — what {@code order="sequential"} reads. */
  public static List<String> load(Map<String, String> attrs, Path baseDir) {
    return load(attrs, baseDir, List.of());
  }

  public static List<String> load(
      Map<String, String> attrs, Path baseDir, List<Path> roots) {
    String src = attrs.get("src");
    if (src == null || src.isBlank()) {
      throw new IllegalArgumentException("file generator: \"src\" is required");
    }
    Path path = resolve(src.trim(), baseDir, roots);
    String content = read(path);

    String column = trimToNull(attrs.get("column"));
    if (attrs.containsKey("column") && column == null) {
      throw new IllegalArgumentException("file generator: column must not be empty");
    }

    List<String> values =
        column == null ? listValues(content) : csvColumn(content, column, attrs, path);
    if (values.isEmpty()) {
      throw new IllegalArgumentException("file generator: list at \"" + path + "\" is empty");
    }
    return values;
  }

  /**
   * Relative to the config file's own folder.
   *
   * <p>A config that says {@code src="./codes.txt"} means the file next to itself, not next to
   * whatever directory the program happened to be started from — otherwise the same config would
   * work from one shell and fail from another.
   */
  /** The prefix that says "look in the configured data folders, not next to the config". */
  public static final String DATA_ALIAS = "@data/";

  /**
   * Where a {@code src=} points, in the order the reference implementation looks.
   *
   * <p>A plain relative path means the file next to the CONFIG, not next to whatever directory the
   * program happened to be started from — otherwise the same config would work from one shell and
   * fail from another. When it is not there, the configured data folders are tried, so a config
   * can be moved without rewriting every source.
   *
   * <p>{@code @data/x.txt} skips the config's folder entirely and names the data folders outright.
   * That is what makes a config portable between machines whose data lives in different places:
   * the path in the config stays the same and only {@code --data-path} (or {@code dataPaths} in
   * the project config) differs. With no data folder configured at all the alias cannot mean
   * anything, and saying so is better than reporting a missing file.
   */
  public static Path resolve(String src, Path baseDir, List<Path> roots) {
    String text = src.trim();
    // HIGHEST priority first. `roots` arrives low to high — global config, project config,
    // data-path flags — because that is the order the pack loader needs, where a later root
    // shadows an earlier one. A file lookup takes the FIRST readable candidate, so reading the
    // list as given hands the answer to the LOWEST priority root: a data-path flag pointing at
    // private data exited 0 and generated from the checked-in file, silently.
    List<Path> candidates = new ArrayList<>(roots == null ? List.of() : roots);
    Collections.reverse(candidates);

    if (text.startsWith("file://")) {
      return Path.of(URI.create(text));
    }

    if (text.startsWith(DATA_ALIAS)) {
      String alias = text.substring(DATA_ALIAS.length()).trim();
      if (alias.isEmpty()) {
        throw new IllegalArgumentException("file generator: @data source path must not be empty");
      }
      if (candidates.isEmpty()) {
        throw new IllegalArgumentException(
            "file generator: \"@data/...\" needs at least one data folder — "
                + "pass --data-path, or name one in tdcv2.config.json");
      }
      List<Path> attempts = new ArrayList<>();
      for (Path root : candidates) {
        attempts.add(root.resolve(alias).normalize());
      }
      return firstReadable(attempts);
    }

    Path path = Path.of(text);
    if (path.isAbsolute()) {
      return path;
    }

    Path beside = baseDir == null ? path : baseDir.resolve(path).normalize();
    if (Files.isRegularFile(beside) || candidates.isEmpty()) {
      return beside;
    }
    List<Path> attempts = new ArrayList<>();
    attempts.add(beside);
    for (Path root : candidates) {
      attempts.add(root.resolve(path).normalize());
    }
    return firstReadable(attempts);
  }

  /** The first candidate that exists, or the first tried so the error names something real. */
  private static Path firstReadable(List<Path> attempts) {
    for (Path candidate : attempts) {
      if (Files.isRegularFile(candidate)) {
        return candidate;
      }
    }
    return attempts.get(0);
  }

  private static String read(Path path) {
    try {
      return Files.readString(path, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException("file generator: cannot read \"" + path + "\"", e);
    }
  }

  private static List<String> listValues(String content) {
    List<String> out = new ArrayList<>();
    for (String raw : content.split("\r?\n", -1)) {
      String trimmed = raw.trim();
      if (!trimmed.isEmpty()) {
        out.add(trimmed);
      }
    }
    return out;
  }

  private static List<String> csvColumn(
      String content, String column, Map<String, String> attrs, Path path) {
    char delimiter = parseDelimiter(attrs.get("delimiter"));
    List<List<String>> rows = new ArrayList<>();
    for (List<String> row : parseRows(content, delimiter)) {
      boolean allBlank = true;
      for (String cell : row) {
        if (!cell.isBlank()) {
          allBlank = false;
          break;
        }
      }
      if (!allBlank) {
        rows.add(row);
      }
    }
    if (rows.isEmpty()) {
      throw new IllegalArgumentException("file generator: CSV file at \"" + path + "\" is empty");
    }

    int columnIndex = columnIndex(rows.get(0), column);
    boolean numbered = column.matches("^[1-9][0-9]*$");
    // A named column implies a header row; a numbered one only skips it when told to, because
    // a file of pure data has no header to skip.
    boolean skipHeader = parseHeaderFlag(attrs.get("header")) || !numbered;

    // A blank cell is REFUSED, not skipped. Dropping it takes the row out of the pool, so the
    // file's own proportions stop being the run's: measured on a three-person CSV with one
    // empty email, 60 rows produced 28 and 32 of the other two and no sign of the third. The
    // weighted path refuses the same shape one column over.
    List<String> values = new ArrayList<>();
    for (int i = skipHeader ? 1 : 0; i < rows.size(); i++) {
      List<String> row = rows.get(i);
      String cell = columnIndex < row.size() ? row.get(columnIndex).trim() : "";
      if (cell.isEmpty()) {
        throw new IllegalArgumentException(
            "file generator: column \"" + column + "\" is empty on value row "
                + (values.size() + 1) + " of \"" + path + "\" — a blank cell would drop that row from the values and quietly change the proportions. Fill it in, remove the row, or point column= at a column that is complete.");
      }
      values.add(cell);
    }
    if (values.isEmpty()) {
      throw new IllegalArgumentException(
          "file generator: CSV column \"" + column + "\" at \"" + path + "\" has no values");
    }
    return values;
  }

  private static int columnIndex(List<String> headerRow, String column) {
    if (column.matches("^[1-9][0-9]*$")) {
      int index = Integer.parseInt(column) - 1;
      // A number past the last column used to be accepted here, and every cell then read as
      // empty — so the failure arrived as the BLANK CELL error, advising "fill it in, remove
      // the row, or point column= at a column that is complete" for a column that does not
      // exist. Say what is actually wrong, and how many columns there are.
      if (index >= headerRow.size()) {
        throw new IllegalArgumentException(
            "file generator: CSV column \"" + column + "\" is past the last column — the file has "
                + headerRow.size());
      }
      return index;
    }
    for (int i = 0; i < headerRow.size(); i++) {
      // Stripping the byte-order mark matters more than the stray spaces: Excel writes one
      // ahead of the first header cell, so without this every "Save as CSV" export would fail
      // to resolve its first column by name and no other.
      if (headerRow.get(i).replace("﻿", "").trim().equals(column)) {
        return i;
      }
    }
    throw new IllegalArgumentException(
        "file generator: CSV column \"" + column + "\" was not found in the header row");
  }

  /** RFC 4180: quoted fields, doubled quotes inside them, and either line ending. */
  static List<List<String>> parseRows(String content, char delimiter) {
    List<List<String>> rows = new ArrayList<>();
    List<String> row = new ArrayList<>();
    StringBuilder field = new StringBuilder();
    boolean inQuotes = false;
    boolean quotedField = false;

    for (int i = 0; i < content.length(); i++) {
      char ch = content.charAt(i);
      if (inQuotes) {
        if (ch == '"') {
          if (i + 1 < content.length() && content.charAt(i + 1) == '"') {
            field.append('"');
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field.append(ch);
        }
        continue;
      }

      if (ch == '"' && field.length() == 0 && !quotedField) {
        inQuotes = true;
        quotedField = true;
        continue;
      }
      if (ch == delimiter) {
        row.add(field.toString());
        field.setLength(0);
        quotedField = false;
        continue;
      }
      if (ch == '\n' || ch == '\r') {
        if (ch == '\r' && i + 1 < content.length() && content.charAt(i + 1) == '\n') {
          i++;
        }
        row.add(field.toString());
        field.setLength(0);
        quotedField = false;
        rows.add(row);
        row = new ArrayList<>();
        continue;
      }
      field.append(ch);
    }

    if (inQuotes) {
      throw new IllegalArgumentException("file generator: unterminated quoted CSV field");
    }
    if (field.length() > 0 || !row.isEmpty() || !content.endsWith("\n")) {
      row.add(field.toString());
      rows.add(row);
    }
    return rows;
  }

  static char parseDelimiter(String value) {
    if (value == null) {
      return ',';
    }
    // A single character is taken as written, tab included, so that resolving twice is
    // harmless: trimming a real tab would leave nothing and fall back to a comma.
    if (value.length() == 1) {
      return value.charAt(0);
    }
    String normalized = value.trim();
    if (normalized.isEmpty()) {
      return ',';
    }
    String resolved =
        switch (normalized.toLowerCase()) {
          case "comma" -> ",";
          case "semicolon" -> ";";
          case "tab", "\\t" -> "\t";
          case "pipe" -> "|";
          default -> normalized;
        };
    if (resolved.length() != 1) {
      throw new IllegalArgumentException("file generator: delimiter must be one character");
    }
    return resolved.charAt(0);
  }

  private static boolean parseHeaderFlag(String value) {
    if (value == null) {
      return false;
    }
    String normalized = value.trim().toLowerCase();
    return switch (normalized) {
      case "true", "1" -> true;
      case "false", "0" -> false;
      default -> throw new IllegalArgumentException("file generator: header must be true or false");
    };
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
