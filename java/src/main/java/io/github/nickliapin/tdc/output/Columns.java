package io.github.nickliapin.tdc.output;

import io.github.nickliapin.tdc.model.Config;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The typed columns a {@code <block>} declares, and the types they carry.
 *
 * <p>A {@code <data>} with a {@code name} is a column; one without is decorative text and
 * columnar output ignores it. Which {@code <line>} it sits on does not matter — the columns are
 * every named {@code <data>} in document order. That keeps the text block and the schema the same
 * construct, so a config gains typed output without learning a second way to describe itself.
 *
 * <p>A column's type is resolved in one order, and the order is the point: an explicit
 * {@code type=} wins; failing that, the generator feeding the column is asked; failing that, it
 * is text. Nothing is ever guessed from the rendered values, because that is exactly how
 * {@code 007} turns into {@code 7}.
 */
public final class Columns {

  /** One declared column: its name, the text it renders from, and its type if it declared one. */
  public record Declared(String name, String template, ColumnType type) {}

  private Columns() {}

  /**
   * A column's type, resolved. {@code null} for a column with no declared type whose source
   * cannot be told confidently — the caller falls back to text, which never corrupts anything.
   */
  public static ColumnType resolve(Declared column, Config config) {
    if (column.type() != null) {
      return column.type();
    }
    String source = soleReference(column.template(), config.inject());
    return source == null ? null : deriveOutput(source, config);
  }

  /**
   * The single sequence a template refers to, when it is exactly one substitution and nothing
   * else ({@code ${{Id}}}).
   *
   * <p>Composite text has no single source type: {@code ${{First}} ${{Last}}} is a sentence, not
   * a number that happens to be spelled with a space in it.
   */
  public static String soleReference(String template, String inject) {
    int marker = inject.indexOf('%');
    if (marker < 0) {
      return null;
    }
    String prefix = inject.substring(0, marker);
    String suffix = inject.substring(marker + 1);
    String text = template.trim();
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
      return null;
    }
    String inner = text.substring(prefix.length(), text.length() - suffix.length());
    // A second marker means more than one substitution, or literal text between them.
    if (inner.isEmpty() || inner.contains(prefix) || inner.contains("|")) {
      return null;
    }
    return inner.trim();
  }

  /**
   * The type of a column fed by {@code name}, as a LIST when its generator repeats.
   *
   * <p>A repeating generator puts several values in one cell, so the column is a list of whatever
   * one value would have been. When the element cannot be typed the list survives anyway — {@code
   * repeat} says this IS a list, and flattening it back into comma-joined text would throw away
   * structure that is known for certain.
   */
  public static ColumnType deriveOutput(String name, Config config) {
    ColumnType element = derive(name, config);
    if (separatorOf(name, config) == null) {
      return element;
    }
    return ColumnType.parseOutput(
        "[]" + (element != null ? element : ColumnType.parse(elementFallback(name, config))));
  }

  /**
   * A column's type from the generator that feeds it, or {@code null} when it cannot be told.
   *
   * <p>The reliable middle step: a column that came from {@code type="number"} with no decimals
   * is an int64, which is knowledge rather than inference. Everything uncertain returns nothing
   * and becomes text.
   */
  public static ColumnType derive(String name, Config config) {
    // A ground-truth flag column is minted by a gen's anomaly_flag or a <mix flag=>, and is
    // never declared as a <sequence> of its own — so it has to be found by looking.
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.isMix() && name.equals(trim(spec.mix().flag()))) {
        return ColumnType.parse("bool");
      }
      for (Config.Gen gen : gensOf(spec)) {
        if (name.equals(trim(gen.attrs().get("anomaly_flag")))) {
          return ColumnType.parse("bool");
        }
      }
    }

    Config.SequenceSpec spec = specNamed(name, config);
    if (spec != null && spec.isMix()) {
      return deriveMix(spec.mix(), config);
    }
    Config.Gen gen = spec == null ? null : spec.gen();
    if (gen == null) {
      return null;
    }
    return deriveGen(gen, config);
  }

  /** The rules for one generator, shared between a plain sequence and a mix's cases. */
  private static ColumnType deriveGen(Config.Gen gen, Config config) {
    // Output formatting rewrites the text, so the value is no longer of its raw type.
    if (gen.attrs().get("mask") != null || gen.attrs().get("case") != null) {
      return null;
    }
    String missing = gen.attrs().get("missing");
    boolean nullable = missing != null && !missing.trim().isEmpty() && positive(missing);

    switch (gen.type()) {
      case "number":
        return withNullable(decimals(gen) > 0 ? "double" : "int64", nullable);
      case "increment":
      case "decrement":
        return withNullable("int64", nullable);
      case "timeseries":
      // A pattern draws a NUMBER from a shape — `y_range="1..30"` is a range of numbers whatever
      // the curve looks like — so it types exactly like a timeseries.
      case "pattern":
        return withNullable(decimals(gen) > 0 ? "double" : "int64", nullable);
      case "running":
        // A running total is the arithmetic of the column it reads, so its type is that column's
        // — recursively, since `of=` may name another derived one. `decimals=` on the running gen
        // itself makes it fractional whatever the source was.
        return decimals(gen) > 0
            ? withNullable("double", nullable)
            : numericSource(gen.attrs().getOrDefault("of", ""), config, nullable);
      case "stat": {
        // A statistic's type follows the OPERATION, which is declared. Counting is whole by
        // definition; a mean, a median and a standard deviation are not, whatever they are
        // computed from; a sum, a minimum and a maximum keep the source column's type.
        if (decimals(gen) > 0) {
          return withNullable("double", nullable);
        }
        String op = gen.attrs().getOrDefault("op", "").trim();
        if ("count".equals(op)) {
          return withNullable("int64", nullable);
        }
        if ("mean".equals(op) || "median".equals(op) || "stddev".equals(op)) {
          return withNullable("double", nullable);
        }
        if ("sum".equals(op) || "min".equals(op) || "max".equals(op)) {
          return numericSource(gen.attrs().getOrDefault("of", ""), config, nullable);
        }
        return null;
      }
      case "formula": {
        // A formula's type is knowable exactly when the config declared how many digits it wants,
        // and not otherwise: `expr="A + 1"` is a whole number, `expr="A / 2"` is not, and
        // `expr="A > 5 ? over : under"` is a WORD. So `decimals=` is the one honest signal, and
        // without it the column stays text.
        Integer places = declaredDecimals(gen);
        return places == null ? null : withNullable(places > 0 ? "double" : "int64", nullable);
      }
      case "file": {
        // A file is a bag of whatever the file holds, so an ordinary read stays text.
        // `read="quantile"` is the exception, and not by inspection of the values: the file MUST
        // be numeric or the run refuses, so the column is a number by construction.
        //
        // Which number is decided by the config alone, because this layer never opens the file.
        // `decimals="0"` is the one declaration that promises whole values; without it the
        // precision comes from the source and may be fractional, so the safe answer is a double.
        if (!"quantile".equals(gen.attrs().getOrDefault("read", "").trim())) {
          return null;
        }
        Integer places = declaredDecimals(gen);
        return withNullable(places != null && places == 0 ? "int64" : "double", nullable);
      }
      case "date":
        // The default rendering is locale-shaped (05/25/1996), not ISO, so a date column is only
        // safe to infer when the config asked for ISO. Otherwise it stays text, and the author
        // can still say type="date" if they mean it.
        return "YYYY-MM-DD".equals(gen.attrs().get("format"))
            ? withNullable("date", nullable)
            : null;
      case "template":
        return gen.attrs().getOrDefault("value", "").endsWith(".uuid")
            ? withNullable("uuid", nullable)
            : null;
      default:
        return null;
    }
  }

  /**
   * A {@code <mix>} column's type, when every branch agrees on one.
   *
   * <p>Deliberately strict: each case must be exactly one generator, and all of them must derive
   * to the same type. A mix of a number and a word is text, and any doubt falls back to text —
   * the rule that keeps a leading zero from being optimised away.
   */
  private static ColumnType deriveMix(Config.Mix mix, Config config) {
    if (mix.cases().isEmpty()) {
      return null;
    }
    ColumnType agreed = null;
    for (Config.Case caseSpec : mix.cases()) {
      if (caseSpec.parts().size() != 1 || caseSpec.parts().get(0).gen() == null) {
        return null;
      }
      ColumnType type = deriveGen(caseSpec.parts().get(0).gen(), config);
      if (type == null) {
        return null;
      }
      if (agreed == null) {
        agreed = type;
      } else if (agreed.kind() != type.kind() || agreed.nullable() != type.nullable()) {
        return null;
      }
    }
    return agreed;
  }

  /**
   * The separator of the generator feeding {@code name}, or {@code null} when it does not repeat.
   *
   * <p>A list column splits its rendered text on exactly this, so the text view and the typed
   * view can never disagree about where one value ends and the next begins.
   */
  public static String separatorOf(String name, Config config) {
    Config.SequenceSpec spec = specNamed(name, config);
    Config.Gen gen = spec == null ? null : spec.gen();
    if (gen == null) {
      return null;
    }
    String repeat = gen.attrs().get("repeat");
    if (repeat == null || repeat.trim().isEmpty()) {
      return null;
    }
    return gen.attrs().getOrDefault("separator", ",");
  }

  /**
   * The element type for a repeating generator whose values cannot be typed.
   *
   * <p>Text stays text, but {@code missing=} still makes the ELEMENT nullable — that is what it
   * blanks.
   */
  private static String elementFallback(String name, Config config) {
    Config.SequenceSpec spec = specNamed(name, config);
    String missing = spec == null || spec.gen() == null ? null : spec.gen().attrs().get("missing");
    boolean nullable = missing != null && !missing.trim().isEmpty() && positive(missing);
    return nullable ? "string|null" : "string";
  }

  /** Refuse a duplicate name before anything is written — two columns cannot share one. */
  public static void checkUnique(List<Declared> columns) {
    Set<String> seen = new LinkedHashSet<>();
    for (Declared column : columns) {
      if (!seen.add(column.name())) {
        throw new IllegalArgumentException("duplicate column name \"" + column.name() + "\"");
      }
    }
  }

  private static Config.SequenceSpec specNamed(String name, Config config) {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (name.equals(spec.name())) {
        return spec;
      }
    }
    return null;
  }

  private static List<Config.Gen> gensOf(Config.SequenceSpec spec) {
    List<Config.Gen> out = new ArrayList<>();
    if (spec.gen() != null) {
      out.add(spec.gen());
    }
    if (spec.isCompound()) {
      for (Config.Field field : spec.fields()) {
        if (field.gen() != null) {
          out.add(field.gen());
        }
      }
    }
    return out;
  }

  private static ColumnType withNullable(String type, boolean nullable) {
    return ColumnType.parse(nullable ? type + "|null" : type);
  }

  /**
   * {@code decimals=} as the config WROTE it — {@code null} when it said nothing at all.
   *
   * <p>Different from {@link #decimals}, which reads an absent attribute as zero. Two generators
   * need the difference: a formula is typed only when the config declared one, and a quantile read
   * is whole only when it declared zero.
   */
  private static Integer declaredDecimals(Config.Gen gen) {
    String raw = gen.attrs().getOrDefault("decimals", "").trim();
    if (raw.isEmpty()) {
      return null;
    }
    try {
      return (int) Double.parseDouble(raw);
    } catch (NumberFormatException e) {
      return null;
    }
  }

  /**
   * The type of the column {@code of=} names, when it is a number.
   *
   * <p>Anything else — or a source this file cannot type — stays text rather than guessing: only a
   * numeric source gives a numeric total.
   */
  private static ColumnType numericSource(String of, Config config, boolean nullable) {
    String source = of == null ? "" : of.trim();
    if (source.isEmpty()) {
      return null;
    }
    ColumnType from = derive(source, config);
    if (from == null) {
      return null;
    }
    if (from.kind() == ColumnType.Kind.INT64) {
      return withNullable("int64", nullable);
    }
    return from.kind() == ColumnType.Kind.DOUBLE ? withNullable("double", nullable) : null;
  }

  private static int decimals(Config.Gen gen) {
    try {
      return (int) Double.parseDouble(gen.attrs().getOrDefault("decimals", "0"));
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  private static boolean positive(String raw) {
    try {
      return Double.parseDouble(raw.trim()) > 0;
    } catch (NumberFormatException e) {
      return false;
    }
  }

  private static String trim(String value) {
    return value == null ? null : value.trim();
  }
}
