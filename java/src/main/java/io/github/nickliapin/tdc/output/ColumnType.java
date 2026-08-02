package io.github.nickliapin.tdc.output;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The declared type of an output column: {@code type="int64"}, {@code type="double|null"},
 * {@code type="decimal(18,2)|null"} on a named {@code <data>}.
 *
 * <p>Every text output is a string, which means whoever reads the file has to guess all over
 * again which column is a number and which only looks like one — and guesses wrong, turning
 * {@code 007} into {@code 7}. A declared type says it once, in the config, where the person who
 * knows the answer is already writing.
 *
 * <p>Only parsing lives here. What a type becomes on disk belongs to the writer, so a second
 * format could reuse this without inheriting Parquet's opinions.
 */
public final class ColumnType {

  /** Everything a column may be declared as. */
  public enum Kind {
    BOOL,
    INT32,
    INT64,
    // Unsigned integers store the same bytes and are annotated so a reader knows the top bit is
    // magnitude rather than sign.
    UINT8,
    UINT16,
    UINT32,
    UINT64,
    FLOAT,
    FLOAT16,
    DOUBLE,
    STRING,
    ENUM,
    DATE,
    TIMESTAMP,
    DECIMAL,
    UUID,
    JSON,
    /** A list of the element type — {@code type="[]int64"}. */
    LIST;

    String lower() {
      return name().toLowerCase(java.util.Locale.ROOT);
    }
  }

  /** The widest decimal an int64 can hold; 10^19 overflows a signed 64-bit integer. */
  private static final int MAX_DECIMAL_PRECISION = 18;

  private static final Pattern HEAD = Pattern.compile("^([a-zA-Z0-9_]+)\\s*(?:\\(([^)]*)\\))?$");

  private final Kind kind;
  private final boolean nullable;
  private final int precision;
  private final int scale;
  private final ColumnType element;

  private ColumnType(Kind kind, boolean nullable, int precision, int scale, ColumnType element) {
    this.kind = kind;
    this.nullable = nullable;
    this.precision = precision;
    this.scale = scale;
    this.element = element;
  }

  public Kind kind() {
    return kind;
  }

  /** {@code |null} — the column may hold a real NULL rather than an empty string. */
  public boolean nullable() {
    return nullable;
  }

  /** decimal only: total digits. */
  public int precision() {
    return precision;
  }

  /** decimal only: digits after the point. */
  public int scale() {
    return scale;
  }

  /** A list's element type, or {@code null} when this is not a list. */
  public ColumnType element() {
    return element;
  }

  public boolean isList() {
    return kind == Kind.LIST;
  }

  /**
   * Parse a {@code type="…"} that may be a list.
   *
   * <p>In {@code []int64|null} the {@code |null} binds to the ELEMENT — read left to right, "a
   * list of (int64 or nothing)". That is what {@code missing=} on a repeating generator needs: it
   * blanks individual elements, never the list itself. There is no nullable list, because an
   * empty cell is an empty list and there is no way to say "no list at all".
   */
  public static ColumnType parseOutput(String raw) {
    String text = raw.trim();
    if (!text.startsWith("[]")) {
      return parse(text);
    }
    String inner = text.substring(2).trim();
    if (inner.isEmpty()) {
      throw new IllegalArgumentException("list type needs an element type, e.g. []int64");
    }
    if (inner.startsWith("[]")) {
      throw new IllegalArgumentException("nested lists are not supported, got \"" + text + "\"");
    }
    return new ColumnType(Kind.LIST, false, 0, 0, parse(inner));
  }

  /** Parse a scalar {@code type="…"}. Throws with a message meant for whoever wrote it. */
  public static ColumnType parse(String raw) {
    List<String> segments = List.of(raw.split("\\|", -1));
    String head = segments.get(0).trim();
    if (head.isEmpty()) {
      throw new IllegalArgumentException("column type must not be empty");
    }

    boolean nullable = false;
    for (String segment : segments.subList(1, segments.size())) {
      String modifier = segment.trim().toLowerCase(java.util.Locale.ROOT);
      if ("null".equals(modifier)) {
        nullable = true;
      } else {
        throw new IllegalArgumentException(
            "unknown type modifier \"" + segment.trim() + "\" (only \"null\" is supported)");
      }
    }

    Matcher match = HEAD.matcher(head);
    Kind kind = match.matches() ? kindOf(match.group(1)) : null;
    if (kind == null || kind == Kind.LIST) {
      throw new IllegalArgumentException("unknown column type \"" + head + "\"");
    }
    String params = match.group(2);

    if (kind != Kind.DECIMAL) {
      if (params != null) {
        throw new IllegalArgumentException("only decimal takes parameters, got \"" + head + "\"");
      }
      return new ColumnType(kind, nullable, 0, 0, null);
    }

    if (params == null) {
      throw new IllegalArgumentException("decimal requires (precision,scale), e.g. decimal(18,2)");
    }
    String[] parts = params.split(",", -1);
    if (parts.length != 2) {
      throw new IllegalArgumentException("decimal requires (precision,scale), got \"" + head + "\"");
    }
    int precision = integerOr(parts[0].trim(), Integer.MIN_VALUE);
    int scale = integerOr(parts[1].trim(), Integer.MIN_VALUE);
    if (precision < 1 || precision > MAX_DECIMAL_PRECISION) {
      throw new IllegalArgumentException(
          "decimal precision must be an integer 1.."
              + MAX_DECIMAL_PRECISION
              + ", got \""
              + parts[0].trim()
              + "\"");
    }
    if (scale < 0 || scale > precision) {
      throw new IllegalArgumentException(
          "decimal scale must be an integer 0..precision ("
              + precision
              + "), got \""
              + parts[1].trim()
              + "\"");
    }
    return new ColumnType(kind, nullable, precision, scale, null);
  }

  private static Kind kindOf(String name) {
    for (Kind kind : Kind.values()) {
      if (kind != Kind.LIST && kind.lower().equals(name.toLowerCase(java.util.Locale.ROOT))) {
        return kind;
      }
    }
    return null;
  }

  private static int integerOr(String text, int fallback) {
    try {
      return Integer.parseInt(text);
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  @Override
  public String toString() {
    if (kind == Kind.LIST) {
      return "[]" + element;
    }
    String base =
        kind == Kind.DECIMAL ? "decimal(" + precision + "," + scale + ")" : kind.lower();
    return nullable ? base + "|null" : base;
  }
}
