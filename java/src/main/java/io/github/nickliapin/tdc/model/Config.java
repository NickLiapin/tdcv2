package io.github.nickliapin.tdc.model;

import java.util.List;
import java.util.Map;

/**
 * The parts of a config the engine works from.
 *
 * <p>A deliberately small model: only what the golden fixtures exercise. Growing it one
 * verified fixture at a time is the point — a wider model with nothing checking it would just
 * be a guess about the reference implementation's behaviour.
 */
public final class Config {

  /** A single {@code <gen>}: its type plus every attribute, unparsed. */
  public record Gen(String type, Map<String, String> attrs) {
    public String attr(String name, String fallback) {
      return attrs.getOrDefault(name, fallback);
    }
  }

  /**
   * One piece of a {@code <case>} body: literal text, a generator, or a nested mix.
   *
   * <p>A case concatenates its pieces, which is what lets a branch read as {@code A-} followed
   * by a pattern rather than as a separate prefix column.
   */
  public record CasePart(String text, Gen gen, Mix mix) {}

  /**
   * One branch of a {@code <mix>} or {@code <switch>}.
   *
   * @param anomaly {@code <case anomaly="true">} — a label only. It injects nothing; the
   *     branch's own generator produces the outlier, and the flag column marks who chose it.
   */
  public record Case(List<CasePart> parts, boolean anomaly) {}

  /**
   * {@code <mix name="X" percent="80,20">} — several ways to build one value, apportioned
   * exactly.
   *
   * <p>Different from a conditional sequence: a conditional asks about another column, a mix
   * asks for a share of the run. It is how a column gets a rare shape — 2% malformed addresses,
   * 5% legacy-format ids — in a stated proportion rather than an approximate one.
   *
   * @param flag the name of a companion column marking the rows that took an anomalous case.
   */
  public record Mix(String percent, String flag, List<Case> cases) {}

  /** One {@code <switch>} entry: keys, and how to build the value when one of them matches. */
  public record SwitchEntry(List<String> keys, Case value) {}

  /**
   * {@code <switch name="X" on="Subject">} — a lookup table.
   *
   * <p>A pure function of the subject's value, so unlike everything else here it consumes no
   * randomness of its own beyond what its cases' generators use. Currency from country, tax rate
   * from region: the pairing is a fact, not a choice.
   */
  public record Switch(String on, List<SwitchEntry> entries, Case fallback) {}

  /** One field of a compound sequence: a {@code <gen name="X">} inside a {@code <sequence>}. */
  public record Field(String name, Gen gen) {}

  /**
   * One item of a composed sequence's body, in source order.
   *
   * <p>A named {@code <gen>} or {@code <data>} is a field; an unnamed one is part of the
   * sequence's own value. Exactly one of the three is set — and {@code constantName} beside
   * {@code text} makes a named {@code <data>}, the only field that costs no draw.
   */
  public record Item(Field field, Gen gen, String text, String constantName) {

    public static Item ofField(Field field) {
      return new Item(field, null, null, null);
    }

    public static Item ofGen(Gen gen) {
      return new Item(null, gen, null, null);
    }

    public static Item ofText(String text) {
      return new Item(null, null, text, null);
    }

    public static Item ofConstant(String name, String text) {
      return new Item(null, null, text, name);
    }
  }

  /** One branch of a conditional sequence; {@code ifExpr} is null on the fallback branch. */
  public record Branch(String ifExpr, Gen gen) {}

  /**
   * One declared column.
   *
   * <p>Three shapes, and exactly one of the three is set:
   *
   * <ul>
   *   <li>{@code gen} — a single value per row.
   *   <li>{@code fields} — a compound: several named values that belong together, each
   *       registered under {@code Name.Field}. A generated address is one thing, not four
   *       unrelated columns that happen to sit next to each other.
   *   <li>{@code branches} — a conditional: the first branch whose condition holds produces the
   *       value, so a column can depend on another column's value.
   * </ul>
   *
   * @param parent {@code null}, {@code "Name"} or {@code "Name.value"} — the rows this column
   *     applies to. Declaration order matters: a child may only name a parent declared before
   *     it.
   */
  public record SequenceSpec(
      String name,
      String parent,
      Gen gen,
      List<Field> fields,
      /**
       * A body read as ONE ordered list: unnamed items concatenate into the sequence's own value,
       * named ones are fields beside it.
       *
       * <p>One list rather than two, because a sequence's gens draw in declaration order and that
       * order is part of the cross-language contract. Splitting the body into "fields" and "parts"
       * would make the draw order something to remember instead of something the shape guarantees.
       */
      List<Item> items,
      List<Branch> branches,
      Object compute,
      Mix mix,
      Switch switchSpec,
      List<List<String>> distinctGroups,
      boolean uniq) {

    public SequenceSpec(String name, String parent, Gen gen) {
      this(name, parent, gen, null, null, null, null, null, null, null, false);
    }

    public SequenceSpec(String name, String parent, Gen gen, List<Field> fields, List<Branch> branches) {
      this(name, parent, gen, fields, null, branches, null, null, null, null, false);
    }

    public SequenceSpec(
        String name, String parent, Gen gen, List<Field> fields, List<Branch> branches, Object compute) {
      this(name, parent, gen, fields, null, branches, compute, null, null, null, false);
    }

    /** A composed body: the items in source order. */
    public static SequenceSpec composed(
        String name, String parent, List<Item> items, List<List<String>> distinctGroups, boolean uniq) {
      return new SequenceSpec(name, parent, null, null, items, null, null, null, null, distinctGroups, uniq);
    }

    public boolean isComposed() {
      return items != null;
    }

    public boolean isMix() {
      return mix != null;
    }

    public boolean isSwitch() {
      return switchSpec != null;
    }

    /**
     * A sequence whose value is derived rather than drawn: a {@code <compute>} tree instead of a
     * {@code <gen>}. Held as {@code Object} so the model does not depend on the parser's
     * generated classes.
     */
    public boolean isComputed() {
      return compute != null;
    }

    public boolean isCompound() {
      return fields != null;
    }

    public boolean isConditional() {
      return branches != null;
    }
  }

  /**
   * One {@code <data>} inside a line.
   *
   * @param ifExpr the {@code if} attribute, or {@code null}. A part whose condition is false
   *     contributes nothing — which is how a trailing comma is omitted on the last record.
   */
  /**
   * One {@code <data>} piece of a line.
   *
   * @param name {@code name="…"} — present when the piece is a COLUMN rather than decoration.
   *     Text output ignores it; a columnar format uses it as the column's name.
   * @param type {@code type="…"} — a declared column type, or {@code null} to let the generator
   *     feeding it decide.
   */
  public record DataPart(String text, String ifExpr, String name, String type) {

    public DataPart(String text, String ifExpr) {
      this(text, ifExpr, null, null);
    }
  }

  /**
   * One {@code <line>} of output: its {@code <data>} children, in order.
   *
   * @param ifExpr the {@code if} attribute, or {@code null}. A line whose condition is false is
   *     dropped whole — and it is dropped before the delimiters are placed, so the line above it
   *     does not keep a separator pointing at nothing.
   */
  public record Line(List<DataPart> parts, String ifExpr, String each) {

    public Line(List<DataPart> parts, String ifExpr) {
      this(parts, ifExpr, null);
    }
  }

  /**
   * Text emitted around the repeating body.
   *
   * <p>Each is a list of lines, empty when the config does not declare that block. The three
   * scopes nest: the {@code *Block} pair wraps one record, the {@code *Line} pair wraps every
   * line inside it, and the two delimiters go only <em>between</em> records and between lines,
   * never after the last one. That last distinction is the whole reason a JSON config can be
   * written at all — it is what keeps a trailing comma off the final record.
   */
  public record Fixtures(
      List<Line> before,
      List<Line> after,
      List<Line> beforeBlock,
      List<Line> afterBlock,
      List<Line> delimiterBlock,
      List<Line> beforeLine,
      List<Line> afterLine,
      List<Line> delimiterLine) {}

  private final int count;
  private final String seed;
  private final String locale;
  private final String inject;
  private final int regexMaxLength;
  private final List<SequenceSpec> sequences;
  private final List<Line> block;
  private final Fixtures fixtures;
  private final String mode;
  private final String engine;
  private final List<List<String>> envUniqGroups;
  private final List<List<String>> envDistinctGroups;
  private final List<PoolSpec> pools;

  /**
   * A {@code <pool>}: a small table computed once, before the rows.
   *
   * <p>A pool is a miniature {@code <env>} — its body holds the same {@code <sequence>},
   * {@code <mix>}, {@code <switch>}, {@code <uniq>} and {@code <distinct>}, and means the same
   * thing by them. So it carries the fields an {@code <env>} does, and the engine builds it with
   * the ordinary machinery, handed the member count where it usually gets the row count.
   */
  public record PoolSpec(
      String name,
      int count,
      List<SequenceSpec> sequences,
      List<List<String>> uniqGroups,
      List<List<String>> distinctGroups) {}

  public Config(
      int count,
      String seed,
      String locale,
      String inject,
      int regexMaxLength,
      List<SequenceSpec> sequences,
      List<Line> block,
      Fixtures fixtures) {
    this(
        count, seed, locale, inject, regexMaxLength, sequences, block, fixtures, null, null,
        List.of(), List.of(), List.of());
  }

  public Config(
      int count,
      String seed,
      String locale,
      String inject,
      int regexMaxLength,
      List<SequenceSpec> sequences,
      List<Line> block,
      Fixtures fixtures,
      String mode,
      String engine,
      List<List<String>> envUniqGroups,
      List<List<String>> envDistinctGroups) {
    this(
        count, seed, locale, inject, regexMaxLength, sequences, block, fixtures, mode, engine,
        envUniqGroups, envDistinctGroups, List.of());
  }

  public Config(
      int count,
      String seed,
      String locale,
      String inject,
      int regexMaxLength,
      List<SequenceSpec> sequences,
      List<Line> block,
      Fixtures fixtures,
      String mode,
      String engine,
      List<List<String>> envUniqGroups,
      List<List<String>> envDistinctGroups,
      List<PoolSpec> pools) {
    this.pools = List.copyOf(pools);
    this.mode = mode;
    this.engine = engine;
    this.envUniqGroups = deepCopy(envUniqGroups);
    this.envDistinctGroups = deepCopy(envDistinctGroups);
    this.count = count;
    this.seed = seed;
    this.locale = locale;
    this.inject = inject;
    this.regexMaxLength = regexMaxLength;
    this.sequences = List.copyOf(sequences);
    this.block = List.copyOf(block);
    this.fixtures = fixtures;
  }

  /**
   * A copy with the runtime parameters replaced; a {@code null} argument keeps what {@code <env>}
   * declared.
   *
   * <p>Code wins over the file. A test that pins {@code seed} needs that value to hold even when
   * the config it borrowed carries a seed of its own — otherwise the override would be advice
   * rather than a setting.
   */
  public Config override(Integer newCount, String newSeed, String newLocale) {
    return new Config(
        newCount == null ? count : newCount,
        newSeed == null ? seed : newSeed,
        newLocale == null ? locale : newLocale,
        inject,
        regexMaxLength,
        sequences,
        block,
        fixtures,
        mode,
        engine,
        envUniqGroups,
        envDistinctGroups,
        pools);
  }

  /** Every {@code <pool>} declared in {@code <env>}. */
  public List<PoolSpec> pools() {
    return pools;
  }

  /**
   * {@code <env mode="memory"|"disk">} — how much of a run may be held at once, or {@code null}
   * when the config does not say.
   *
   * <p>Not a choice of engine: it states the constraint and lets the router pick the fastest
   * engine that can honour it. A config asking for disk mode and using something only the
   * in-memory engine can do still produces the right data.
   */
  public String mode() {
    return mode;
  }

  /** {@code <env engine="1"|"2"|"3">} — one engine by name, overriding the router. */
  public String engine() {
    return engine;
  }

  /** A copy pinned to one engine — what the library's {@code engine()} option sets. */
  public Config withEngine(String newEngine) {
    return new Config(
        count, seed, locale, inject, regexMaxLength, sequences, block, fixtures, mode, newEngine,
        envUniqGroups, envDistinctGroups, pools);
  }

  /**
   * Env-level {@code <uniq>} groups: the TUPLE of the named sequences is unique across rows.
   *
   * <p>The across-rows twin of {@link #envDistinctGroups()}, and the across-sequences twin of
   * {@code uniq="true"} on one compound. Every (first name, last name) pair distinct, say.
   */
  public List<List<String>> envUniqGroups() {
    return envUniqGroups;
  }

  /**
   * Env-level {@code <distinct>} groups: the named sequences differ from each other on each row.
   *
   * <p>Birth city and current city, drawn from the same list and meant not to coincide.
   */
  public List<List<String>> envDistinctGroups() {
    return envDistinctGroups;
  }

  private static List<List<String>> deepCopy(List<List<String>> groups) {
    if (groups == null) {
      return List.of();
    }
    List<List<String>> out = new java.util.ArrayList<>(groups.size());
    for (List<String> group : groups) {
      out.add(List.copyOf(group));
    }
    return List.copyOf(out);
  }

  public int count() {
    return count;
  }

  public String seed() {
    return seed;
  }

  public String locale() {
    return locale;
  }

  /** The {@code ${{%}}}-style marker this document uses to name a sequence inside text. */
  public String inject() {
    return inject;
  }

  /** The longest string a {@code <gen type="regex">} in this document is allowed to produce. */
  public int regexMaxLength() {
    return regexMaxLength;
  }

  public List<SequenceSpec> sequences() {
    return sequences;
  }

  public List<Line> block() {
    return block;
  }

  public Fixtures fixtures() {
    return fixtures;
  }
}
