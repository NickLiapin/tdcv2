package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.expr.MatchKey;
import io.github.nickliapin.tdc.date.DateGen;
import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.format.Mask;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.generators.DateOffset;
import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.generators.FileGen;
import io.github.nickliapin.tdc.generators.Formula;
import io.github.nickliapin.tdc.generators.Quantile;
import io.github.nickliapin.tdc.generators.Imperfections;
import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.pattern.PatternGen;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Seekable;
import io.github.nickliapin.tdc.sequence.Assertions;
import io.github.nickliapin.tdc.sequence.Pool;
import io.github.nickliapin.tdc.stats.Timeseries;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntFunction;

/**
 * The streaming engine: a row is computed from its own index, and nothing else is kept.
 *
 * <p>The in-memory engine materializes every column before writing a byte, so a run costs memory
 * proportional to its size. That is the right trade for a thousand rows and impossible for a
 * billion. Here each value is a function of the row number, so memory is proportional to the
 * width of one row and a file of any length costs the same.
 *
 * <p>Two things make that possible, and both live in {@code prng}: draws keyed by
 * {@code seed | stream | index} instead of taken in order, and a permutation that can be
 * evaluated at one position. The second is what keeps an exact {@code percent=} exact — the
 * quota is laid out and then shuffled by a bijection nobody has to materialize. The same trick
 * carries everything that divides a column into shares: {@code <mix>}, weighted packs, weighted
 * file columns, {@code repeat=} lengths, and the length groups of a weighted number.
 *
 * <p>What this engine will not do, it refuses by name rather than approximating. A weighted
 * choice inside {@code advanced_regex}, a percent-weighted {@code uniq}, a template address that
 * interpolates a field: each needs the whole column at once, and answering from one row would
 * produce data that looks right and is not. Those configs belong to another engine, and the
 * router sends them there.
 */
public final class StreamEngine {

  /** A column that answers per row. {@code null} means the row is outside a parent filter. */
  public interface Column {
    String valueAt(int row);
  }

  /** What a column has to expose to be a parent: its values, their quotas, and a child's rank. */
  private interface ParentCapable {
    boolean hasValue(String value);

    int quotaOf(String value);

    /** The child's position among the rows this parent value selected, or {@code null}. */
    Integer childRankAt(int row, String value);
  }

  /** The rows a sequence applies to: how many, and where a given row sits among them. */
  private record Domain(int size, IntFunction<Integer> popIndexAt) {}

  /** One generator's contribution: its column, whether a child may filter on it, and its flag. */
  private record Built(Column column, ParentCapable parent, String flagName, Column flag) {
    Built(Column column) {
      this(column, null, null, null);
    }
  }

  /**
   * Raised for a config this engine cannot answer row by row; the router picks another.
   *
   * <p>The message is carried verbatim. A prefix added here would reach the user only because of
   * which package they installed, and would land on refusals that already word themselves fully —
   * which is how one refusal came to read four ways across the five implementations.
   */
  public static final class Unsupported extends RuntimeException {

    private static final long serialVersionUID = 1L;

    Unsupported(String message) {
      super(message);
    }
  }

  /** The one refusal sentence, worded as the reference words it. */
  private static Unsupported unsupported(String feature, String name) {
    return new Unsupported(
        "stream mode: "
            + feature
            + " (\""
            + name
            + "\") is not supported yet — run without mode=\"stream\" "
            + "(the in-memory engine handles it), or remove it.");
  }

  /** Types whose value is built here and whose modifiers therefore apply here too. */
  private static final Set<String> INLINE_TYPES =
      Set.of("text", "increment", "decrement", "timeseries", "pattern");

  /**
   * How many redraws {@code <distinct>} gets before it gives up.
   *
   * <p>A fuse, not a tuning knob. Without one, three fields over a pool of two values would loop
   * for as long as the run lasts and look like a hang rather than the impossible request it is.
   */
  private static final int DISTINCT_FUSE = 64;


  private final Config config;
  private final DataPacks packs;
  private final long nowMillis;
  private final Path baseDir;
  private final String seed;
  private final int count;
  private final Map<String, Column> columns = new LinkedHashMap<>();
  private final Map<String, ParentCapable> parents = new LinkedHashMap<>();
  private final boolean exactUniq;
  private Map<String, Pool.Table> poolTables = Map.of();

  private StreamEngine(
      Config config, DataPacks packs, long nowMillis, Path baseDir, boolean exactUniq) {
    this.config = config;
    this.packs = packs;
    this.nowMillis = nowMillis;
    this.baseDir = baseDir;
    this.seed = config.seed();
    this.count = config.count();
    this.exactUniq = exactUniq;
  }

  /**
   * Render straight to a sink, one record at a time.
   *
   * <p>Nothing accumulates: the caller can hand this a file writer and the run's memory stays
   * flat however many records it produces.
   */
  public static void render(
      Config config, DataPacks packs, long nowMillis, Path baseDir, Appendable out) {
    StreamEngine engine = new StreamEngine(config, packs, nowMillis, baseDir, false);
    engine.buildColumns();
    engine.write(out, 0, engine.count);
  }

  /**
   * Rows {@code [start, stop)} of the same run, and nothing else.
   *
   * <p>This is what lets a run be split across threads. Every value here is a function of its own
   * row number — that is what the seekable generator buys — so a shard needs to know nothing about
   * the rows before it. The opening fixture belongs to whoever owns row zero and the closing one to
   * whoever owns the last row; the between-blocks delimiter is keyed to the GLOBAL row number, so
   * the piece that ends at row k-1 still emits it and the piece that starts at k does not repeat
   * it. Concatenating the pieces in order therefore gives exactly the bytes one thread would have
   * written — a property of this method, not of luck.
   */
  public static void renderRows(
      Config config,
      DataPacks packs,
      long nowMillis,
      Path baseDir,
      Appendable out,
      int start,
      int stop) {
    StreamEngine engine = new StreamEngine(config, packs, nowMillis, baseDir, false);
    engine.buildColumns();
    engine.write(out, start, Math.min(stop, engine.count));
  }



  /** The same run collected into a string — for a result small enough to want one. */
  public static String renderToString(Config config, DataPacks packs, long nowMillis, Path baseDir) {
    StringBuilder out = new StringBuilder();
    render(config, packs, nowMillis, baseDir, out);
    return out.toString();
  }

  /**
   * The run as addressable records, computed on demand.
   *
   * <p>Iterating this holds one row at a time, so a caller can walk a run far larger than memory
   * and read the same values the in-memory engine would have given them.
   */
  public static RowSource rows(Config config, DataPacks packs, long nowMillis, Path baseDir) {
    return rows(config, packs, nowMillis, baseDir, false);
  }

  /**
   * The same, with {@code exactUniq} deciding how a {@code uniq="true"} sequence is built.
   *
   * <p>False gives uniform distinct combinations, which is all this engine can promise on its
   * own. True builds each column to its exact quota instead and verifies the result on disk —
   * what the exact engine asks for, and the one place the two differ.
   */
  static RowSource rows(
      Config config, DataPacks packs, long nowMillis, Path baseDir, boolean exactUniq) {
    StreamEngine engine = new StreamEngine(config, packs, nowMillis, baseDir, exactUniq);
    engine.buildColumns();
    return new RowSource() {
      @Override
      public int count() {
        return config.count();
      }

      @Override
      public List<String> sequenceNames() {
        List<String> out = new ArrayList<>();
        for (String name : engine.columns.keySet()) {
          if (!name.startsWith("_")) {
            out.add(name);
          }
        }
        return out;
      }

      @Override
      public String value(String column, int row) {
        return engine.valueAt(column, row);
      }

      @Override
      public String text() {
        StringBuilder out = new StringBuilder();
        engine.write(out, 0, engine.count);
        return out.toString();
      }

      @Override
      public void writeTo(Appendable out) {
        engine.write(out, 0, engine.count);
      }
    };
  }

  // ── columns ──────────────────────────────────────────────────────────────────────────────

  private void buildColumns() {
    // Pools are computed before anything streams — small, and off a derived seed, so the
    // bounded-memory promise is untouched and no other column moves.
    poolTables = MemoryEngine.buildPoolTables(config, packs, nowMillis, baseDir);

    columns.put("_count", row -> String.valueOf(row + 1));
    columns.put("_first", row -> row == 0 ? "true" : "false");
    columns.put("_last", row -> row == count - 1 ? "true" : "false");
    columns.put("_total", row -> String.valueOf(count));

    Map<String, Config.SequenceSpec> byName = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }
    // An env-level <uniq> builds its members together — their values are digits of one index —
    // so they are done first and skipped in the loop below.
    Set<String> envUniqMembers = new LinkedHashSet<>();
    for (List<String> group : config.envUniqGroups()) {
      envUniqMembers.addAll(buildEnvUniq(group, byName));
    }

    for (Config.SequenceSpec spec : config.sequences()) {
      if (envUniqMembers.contains(spec.name())) {
        continue;
      }
      if (spec.uniq()) {
        buildUniq(spec);
        continue;
      }
      // A reference to a <pool>. The table was computed before the run, so only the per-row PICK
      // happens here — and it is seekable, so it costs the streaming engines nothing. A reference
      // under a parent needs the parent's materialised column to know which rows exist at all, so
      // that one goes to the in-memory engine rather than being guessed at.
      // A running total is the one construct that genuinely cannot be answered from a row
      // index: row 900,000,000 IS the sum of everything before it. That is not a gap in the
      // streaming builder, it is what "running" means — so it is refused by name and the router
      // hands the config to the in-memory engine.
      if (spec.gen() != null && "running".equals(spec.gen().type())) {
        throw new Unsupported(
            "a running total (\"" + spec.name() + "\") is the accumulation of every row before "
                + "it, so it cannot be computed one row at a time; the in-memory engine handles "
                + "it (run without a forced streaming engine)");
      }

      // Arithmetic over the columns beside it. Unlike the two refusals around it, a formula
      // reads only its OWN row, so the streaming engine answers it lazily exactly as it answers
      // a `<compute>`.
      if (spec.gen() != null && "formula".equals(spec.gen().type())) {
        String formulaSource = Formula.expressionOf(spec.gen().attrs());
        Integer formulaDecimals = Formula.decimalsOf(spec.gen().attrs());
        columns.put(
            spec.name(),
            row ->
                Formula.valueAtRow(
                    formulaSource,
                    formulaDecimals,
                    row,
                    columns::containsKey,
                    name -> valueAt(name, row)));
        continue;
      }

      // A statistic over the whole run is the stronger form of the same thing: it is not knowable
      // from the rows SO FAR either, because the rows after this one are part of the answer.
      if (spec.gen() != null && "stat".equals(spec.gen().type())) {
        throw new Unsupported(
            "a statistic (\"" + spec.name() + "\") is computed over every row of the run, "
                + "including the ones after this one, so it cannot be computed one row at a time; "
                + "the in-memory engine handles it (run without a forced streaming engine)");
      }

      // A date measured from another date reads a SIBLING column as the row is built, and the
      // streaming path has no way to do that yet — the same reason a dynamic template defers.
      // Refused by name, and the router hands the config to the in-memory engine.
      if (DateOffset.isOffset(spec.gen())) {
        throw new Unsupported(
            "a date measured from another column (\""
                + spec.name()
                + "\") reads that column as the row is built, and the streaming path has no way "
                + "to do that yet; the in-memory engine handles it (run without a forced "
                + "streaming engine)");
      }

      if (spec.gen() != null && "pool".equals(spec.gen().type())) {
        if (trimToNull(spec.parent()) != null) {
          throw unsupported("a pool reference with parent=", spec.name());
        }
        buildPoolReference(spec);
        continue;
      }
      if (spec.isConditional()) {
        buildConditional(spec);
        continue;
      }
      if (spec.isSwitch()) {
        buildSwitch(spec);
        continue;
      }
      if (spec.isComputed()) {
        // Derived from other columns and nothing else, so it resolves per row for free.
        Config.SequenceSpec computed = spec;
        columns.put(
            spec.name(),
            row ->
                io.github.nickliapin.tdc.compute.Compute.evaluate(
                    (io.github.nickliapin.tdc.parser.generated.TDCParser.OpenCloseElementContext)
                        computed.compute(),
                    name -> valueAt(name, row)));
        continue;
      }
      if (spec.isMix()) {
        // "#switch" is what the reference keys a top-level mix by — the construct was named
        // that before it was named <mix>, and the stream id is part of the seed contract.
        register(spec.name(), buildMix(spec.name() + "#switch", spec.mix(), domainOf(spec)));
        continue;
      }
      if (spec.isComposed()) {
        buildComposed(spec);
        continue;
      }
      if (spec.isCompound()) {
        buildCompound(spec);
        continue;
      }
      register(spec.name(), buildGen(spec.name(), spec.gen(), domainOf(spec)));
    }

    for (List<String> group : config.envDistinctGroups()) {
      applyEnvDistinct(group, byName);
    }

    // The same check the in-memory engine makes, on the same finished run: an assertion that only
    // held on one engine would be a check that depends on how the file was produced.
    Assertions.check(config, this::valueAt, columns::containsKey);
  }

  /**
   * Env-level {@code <uniq>}: the tuple of several sequences is unique across the run.
   *
   * <p>Built exactly like a compound's {@code uniq}, only the digits live in separate sequences.
   * The members cannot be drawn independently and then reconciled — that is the whole-column
   * repair this engine exists to avoid — so they are built together from one index.
   *
   * @return the names this took over, which the ordinary loop must then leave alone
   */
  private Set<String> buildEnvUniq(List<String> group, Map<String, Config.SequenceSpec> byName) {
    // As with a sequence's own `uniq`: a group rearranges finished columns, so it belongs to the
    // in-memory engine and both disk engines refuse rather than answer differently.
    throw unsupported(
        "<uniq> across sequences (a whole-column rearrangement)", String.join(" × ", group));
  }

  /**
   * Env-level {@code <distinct>}: the named sequences differ from each other on every row.
   *
   * <p>Layered over the columns already built rather than folded into them, because the
   * constraint is between sequences that are otherwise independent. A collision redraws on a
   * fresh stream, in a fixed order, so every implementation repairs the same row the same way.
   */
  private void applyEnvDistinct(List<String> group, Map<String, Config.SequenceSpec> byName) {
    List<String> members = new ArrayList<>();
    Map<String, Config.Gen> genByName = new LinkedHashMap<>();
    for (String name : group) {
      Config.SequenceSpec member = byName.get(name);
      if (member == null || !columns.containsKey(name)) {
        continue;
      }
      if (member.isMix()) {
        throw unsupported("<distinct> member \"" + name + "\" is a <mix>", name);
      }
      if (member.isSwitch()) {
        throw unsupported("<distinct> member \"" + name + "\" is a <switch>", name);
      }
      if (member.gen() == null) {
        throw unsupported("<distinct> member \"" + name + "\" (must be a simple sequence)", name);
      }
      members.add(name);
      genByName.put(name, member.gen());
    }
    if (members.size() < 2) {
      return;
    }

    Map<String, Column> base = new LinkedHashMap<>();
    for (String name : members) {
      base.put(name, columns.get(name));
    }

    RowRepair repair =
        new RowRepair(
            row -> {
              Map<String, String> values = new LinkedHashMap<>();
              for (String name : members) {
                values.put(name, base.get(name).valueAt(row));
              }
              Set<String> seen = new LinkedHashSet<>();
              for (String name : members) {
                String value = values.get(name);
                if (value == null) {
                  continue; // an inactive row, filtered out by its parent
                }
                int attempt = 0;
                while (seen.contains(value)) {
                  attempt++;
                  if (attempt > DISTINCT_FUSE) {
                    throw new IllegalStateException(
                        "stream mode: <distinct> across sequences: could not find a value for "
                            + "sequence \""
                            + name
                            + "\" different from the others after "
                            + DISTINCT_FUSE
                            + " attempts — its source likely has too few distinct values.");
                  }
                  value =
                      first(
                          genValues(
                              genByName.get(name),
                              Seekable.generator(seed, name + "#ed" + attempt, row),
                              null,
                              row));
                }
                values.put(name, value);
                seen.add(value);
              }
              return values;
            });

    for (String name : members) {
      columns.put(name, row -> repair.at(row).get(name));
    }
  }

  /**
   * A pool reference as LAZY columns.
   *
   * <p>A pool is small and computed before the run starts, so it never threatens the streaming
   * engines' bounded memory: what streams is the two thousand patients, not the thirty doctors.
   * And because the member pick is seekable by row, row 900,000 gets its doctor without the
   * 899,999 before it existing.
   */
  private void buildPoolReference(Config.SequenceSpec spec) {
    String poolName = spec.gen().attr("value", "").trim();
    Pool.Table table = poolTables.get(poolName);
    if (table == null || table.count() < 1) {
      return; // unknown pool — the validator reports it
    }

    String expression = spec.gen().attr("filter", "").trim();
    String[] equality =
        expression.isEmpty()
            ? null
            : Pool.parseEqualityFilter(expression, table, columns::containsKey);
    Map<String, List<Integer>> buckets =
        equality == null ? null : Pool.bucketByField(table, equality[0]);

    IntFunction<Integer> memberAt =
        row -> {
          if (expression.isEmpty()) {
            return Pool.pickMember(seed, spec.name(), table, row);
          }
          List<Integer> eligible;
          String detail = "";
          if (equality != null) {
            String wanted = valueAt(equality[1], row);
            if (wanted == null) {
              wanted = "";
            }
            eligible = buckets.getOrDefault(MatchKey.of(wanted), List.of());
            detail = " (" + equality[1] + "=\"" + wanted + "\")";
          } else {
            eligible = new ArrayList<>();
            Map<String, String> read = new java.util.LinkedHashMap<>();
            for (int m = 0; m < table.count(); m++) {
              if (Evaluate.asCondition(expression, new StreamMemberScope(table, m, row, read))) {
                eligible.add(m);
              }
            }
            detail = Pool.rowValuesDetail(read);
          }
          if (eligible.isEmpty()) {
            throw new IllegalStateException(
                Pool.noCandidateMessage(poolName, expression, row, detail));
          }
          return eligible.get(
              Seekable.nextInt(seed, Pool.refStream(spec.name()), row, eligible.size()));
        };

    for (String field : table.fields()) {
      List<String> column = table.columns().getOrDefault(field, List.of());
      columns.put(
          spec.name() + "." + field,
          row -> {
            int m = memberAt.apply(row);
            return m < column.size() ? column.get(m) : "";
          });
    }
  }

  /** A candidate member's fields first, then the row's columns. */
  private final class StreamMemberScope implements Evaluate.Scope {

    private final Pool.Table table;
    private final int member;
    private final int row;
    /** The ROW columns the filter read, and what they held — see Pool.rowValuesDetail. */
    private final Map<String, String> read;

    StreamMemberScope(Pool.Table table, int member, int row, Map<String, String> read) {
      this.table = table;
      this.member = member;
      this.row = row;
      this.read = read;
    }

    @Override
    public boolean has(String name) {
      return field(name) != null || columns.containsKey(name);
    }

    @Override
    public String value(String name) {
      String found = field(name);
      if (found != null) {
        return found;
      }
      String value = valueAt(name, row);
      String text = value == null ? "" : value;
      if (columns.containsKey(name)) {
        read.put(name, text);
      }
      return text;
    }

    private String field(String name) {
      String prefix = table.name() + ".";
      String key = name.startsWith(prefix) ? name.substring(prefix.length()) : name;
      List<String> column = table.columns().get(key);
      if (column == null) {
        return null;
      }
      return member < column.size() ? column.get(member) : "";
    }
  }

  private void register(String name, Built built) {
    columns.put(name, built.column());
    if (built.parent() != null) {
      parents.put(name, built.parent());
    }
    if (built.flagName() != null && built.flag() != null) {
      columns.put(built.flagName(), built.flag());
    }
  }

  /**
   * A composed sequence: the body in declaration order, each part on a stream of its own.
   *
   * <p>Parts are numbered among the UNNAMED ones ({@code #p0}, {@code #p1}, …), so adding a
   * literal between two gens moves nothing. A row outside the parent's filter has no value in any
   * part, and the composed cell is absent rather than a string of bare literals.
   */
  private void buildComposed(Config.SequenceSpec spec) {
    Domain domain = domainOf(spec);
    List<Object> parts = new ArrayList<>();
    Map<String, Column> fields = new LinkedHashMap<>();
    int unnamed = 0;
    // A named field that draws, read only when no unnamed part does. It answers the one question
    // the literals cannot — whether this row is inside the parent's filter — so the ordinary path
    // costs nothing.
    Column witness = null;

    for (Config.Item item : spec.items()) {
      if (item.constantName() != null) {
        String constant = item.text() == null ? "" : item.text();
        columns.put(
            spec.name() + "." + item.constantName(),
            row -> domain.popIndexAt().apply(row) == null ? null : constant);
        continue;
      }
      if (item.text() != null) {
        parts.add(item.text());
        continue;
      }
      if (item.field() != null) {
        String fieldId = spec.name() + "." + item.field().name();
        Built built = buildGen(fieldId, item.field().gen(), domain);
        columns.put(fieldId, built.column());
        fields.put(item.field().name(), built.column());
        if (witness == null) {
          witness = built.column();
        }
        continue;
      }
      parts.add(buildGen(spec.name() + "#p" + unnamed++, item.gen(), domain).column());
    }

    applyDistinct(MemoryEngine.withFieldsOf(spec), fields);

    if (!MemoryEngine.composesOwnValue(spec.items())) {
      return;
    }

    int drawn = unnamed;
    Column applicable = witness;
    columns.put(
        spec.name(),
        row -> {
          StringBuilder text = new StringBuilder();
          boolean active = false;
          for (Object part : parts) {
            if (part instanceof String literal) {
              text.append(literal);
              continue;
            }
            String value = ((Column) part).valueAt(row);
            if (value == null) {
              continue;
            }
            active = true;
            text.append(value);
          }
          if (drawn > 0) {
            return active ? text.toString() : null;
          }
          // Nothing unnamed draws here, so the value is the literals alone — constant, but still
          // absent on a row this sequence does not apply to. A named field draws for exactly those
          // rows and is asked instead.
          if (applicable != null && applicable.valueAt(row) == null) {
            return null;
          }
          return text.toString();
        });
  }

  private void buildCompound(Config.SequenceSpec spec) {
    Domain domain = domainOf(spec);
    Map<String, Column> fields = new LinkedHashMap<>();
    for (Config.Field field : spec.fields()) {
      // A field's column only: the fields of a compound are parts of one thing, and a `parent=`
      // or an `anomaly_flag=` pointing at one is not something the reference offers.
      Built built = buildGen(spec.name() + "." + field.name(), field.gen(), domain);
      columns.put(spec.name() + "." + field.name(), built.column());
      fields.put(field.name(), built.column());
    }
    applyDistinct(spec, fields);
  }

  /**
   * The rows a sequence covers.
   *
   * <p>A child of {@code parent="Gender.Male"} exists only on the male rows, and its own draws
   * are numbered within that subset — otherwise the values it produces would depend on how many
   * rows the parent happened to give it, which is not knowable one row at a time.
   */
  private Domain domainOf(Config.SequenceSpec spec) {
    String reference = trimToNull(spec.parent());
    if (reference == null) {
      return new Domain(count, row -> row);
    }
    int dot = reference.indexOf('.');
    if (dot < 0) {
      throw unsupported(
          "bare parent=\"" + reference + "\" (use parent=\"Name.Value\")", spec.name());
    }
    String parentName = reference.substring(0, dot);
    String parentValue = reference.substring(dot + 1);

    ParentCapable parent = parents.get(parentName);
    if (parent == null) {
      throw unsupported(
          "parent \"" + parentName + "\" (the parent must be a finite-value <sequence> declared earlier)",
          spec.name());
    }
    if (!parent.hasValue(parentValue)) {
      throw new IllegalStateException(
          "sequence \""
              + spec.name()
              + "\" filters on parent value \""
              + reference
              + "\", which the parent never produces.");
    }
    return new Domain(parent.quotaOf(parentValue), row -> parent.childRankAt(row, parentValue));
  }

  // ── one generator ────────────────────────────────────────────────────────────────────────

  private Built buildGen(String streamId, Config.Gen gen, Domain domain) {
    Map<String, String> attrs = gen.attrs();
    String type = gen.type();

    if ("advanced_regex".equals(type)
        && AdvancedRegexGen.hasWeightedChoice(attrs.getOrDefault("value", ""))) {
      // Its shares are exact over a whole column; a per-row draw would send every row to the
      // largest branch and look plausible doing it.
      throw unsupported("advanced_regex weighted choice \"(?%{…})\"", streamId);
    }
    if ("http".equals(type)) {
      // A network call is not a draw: neither reproducible from a row index nor
      // answerable synchronously, which is what a lazy per-row resolver needs.
      throw new Unsupported(
          "<gen type=\"http\"> (\"" + streamId + "\") is a network call, so it is neither reproducible nor answerable one row at a time; the in-memory engine handles it (run without a forced streaming engine)");
    }
    if ("template".equals(type) && attrs.getOrDefault("value", "").contains("${{")) {
      throw new Unsupported(
          "template value \""
              + attrs.getOrDefault("value", "")
              + "\" interpolates a field; the in-memory engine resolves it per row");
    }

    // An empty subset — a parent value with no rows of its own. Always inactive.
    if (domain.size() == 0) {
      return new Built(row -> null);
    }

    String weightColumn = "file".equals(type) ? trimToNull(attrs.get("weight")) : null;
    if (weightColumn != null && trimToNull(attrs.get("row")) != null) {
      throw new Unsupported(
          "weight= combined with row= needs an exact quota over the whole file; the in-memory "
              + "engine handles it (run without a forced streaming engine)");
    }
    FileGen.Weighted weightedPack = weightedTemplatePack(gen);

    Repeat.Spec repeat = Repeat.parse(attrs);
    Modifier mod = modifierFor(streamId, attrs, repeat == null ? 1 : repeat.max());

    // The lengths of a repeating cell are themselves an exact quota, planned before any value
    // exists so a row's slice follows from its own position rather than from its predecessors.
    Repeat.Plan repeatPlan =
        repeat == null
            ? null
            : Repeat.plan(
                repeat,
                domain.size(),
                Hamilton.countsPerValue(
                    domain.size(),
                    Repeat.lengthPercents(repeat),
                    Prng.create(seed + "|" + streamId + "|replen")));
    int repeatKey = Permute.key(seed, streamId + "#replen");
    IntFunction<Integer> repeatPosAt =
        row -> {
          Integer r = domain.popIndexAt().apply(row);
          return r == null ? null : Permute.permute(r, domain.size(), repeatKey);
        };

    // order="sequential": row r takes element r mod N. Index-based, so it needs no draw.
    if (("text".equals(type) || "file".equals(type))
        && "sequential".equals(attrs.get("order"))
        && weightColumn == null) {
      List<String> list =
          "file".equals(type)
              ? FileGen.load(attrs, baseDir, packs.dataRoots())
              : splitText(attrs.getOrDefault("value", ""));
      boolean cycle = !"false".equals(attrs.get("cycle"));
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                return r == null ? null : pickSequential(list, r, cycle);
              },
          streamId,
          gen,
          domain);
    }

    // The same rule over a date range. The axis is arithmetic rather than a list, which is what
    // lets this stay seekable and bounded however long the range is.
    if ("date".equals(type) && "sequential".equals(attrs.get("order"))) {
      DateGen.Axis axis =
          DateGen.dateAxis(attrs, localeOf(attrs), nowMillis);
      boolean cycle = !"false".equals(attrs.get("cycle"));
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                if (r == null) {
                  return null;
                }
                // An OPEN axis has no size and never wraps: row r is simply the r-th step.
                return axis.size() == null
                    ? axis.at(r)
                    : axis.at(MemoryEngine.sequentialIndex(axis.size(), r, cycle));
              },
          streamId,
          gen,
          domain);
    }

    if ("increment".equals(type) || "decrement".equals(type)) {
      long start = longAttr(attrs.get("value"), 0);
      long step = longAttr(attrs.get("step"), 1);
      boolean up = "increment".equals(type);
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                return r == null ? null : String.valueOf(up ? start + step * r : start - step * r);
              },
          streamId,
          gen,
          domain);
    }

    if ("timeseries".equals(type)) {
      Timeseries.Spec spec = Timeseries.parse(attrs);
      boolean noisy = spec.hasNoise();
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                if (r == null) {
                  return null;
                }
                double z = 0;
                if (noisy) {
                  double[] u = Seekable.uniforms(seed, streamId + ":ts", row, 2);
                  z = Timeseries.standardNormal(u[0], u[1]);
                }
                return format(Timeseries.valueAt(spec, r, z), spec.decimals());
              },
          streamId,
          gen,
          domain);
    }

    if ("pattern".equals(type)) {
      PatternGen drawing = PatternGen.of(attrs, baseDir, packs.dataRoots());
      double denom = domain.size() > 1 ? domain.size() - 1 : 1;
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                if (r == null) {
                  return null;
                }
                double u =
                    drawing.draws() ? Seekable.uniforms(seed, streamId + ":pat", row, 1)[0] : 0;
                return drawing.valueAt(r / denom, u);
              },
          streamId,
          gen,
          domain);
    }

    // `sample="exact"` on a quantile read: the row's point on the sorted sample comes from a
    // scatter over the WHOLE column, so it cannot go down the generic per-row path, which is
    // handed a count of one and would give every row the median. The file is read and sorted
    // ONCE, here, so a run of any length costs the sample and nothing more.
    if ("file".equals(type)
        && Quantile.isQuantile(attrs)
        && Quantile.isExactSample(attrs)) {
      Quantile.Source quantileSource =
          Quantile.read(
              FileGen.load(attrs, baseDir, packs.dataRoots()),
              attrs.getOrDefault("src", "").trim());
      int quantileDecimals = Quantile.decimalsFor(attrs, quantileSource);
      int sweepKey = Permute.key(seed, streamId);
      int sweepCount = domain.size();
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                // Over the rows this column HAS, which for a filtered one is its domain rather
                // than the run — the same count the in-memory engine sweeps.
                return r == null
                    ? null
                    : Quantile.exactAt(
                        quantileSource, quantileDecimals, sweepCount, sweepKey, r);
              },
          streamId,
          gen,
          domain);
    }

    // A row-linked file: every field on the key must land on the same record for a given row,
    // and a different one per row. The in-memory engine plans that for the whole column; here
    // the index is re-derived from a stream keyed by the LINK, so the fields agree without one.
    if ("file".equals(type) && weightColumn == null && trimToNull(attrs.get("row")) != null) {
      String rowKey = trimToNull(attrs.get("row"));
      FileGen.RowSource source = FileGen.loadRows(attrs, baseDir, packs.dataRoots());
      String linkStream = "filerowlink|" + rowKey;
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                if (r == null) {
                  return null;
                }
                int index = Seekable.nextInt(seed, linkStream, row, source.rows().size());
                return FileGen.cellAt(source, index);
              },
          streamId,
          gen,
          domain);
    }

    // An exact quota: text, a weighted file column, or a weighted pack. All three say what
    // share of the run each value takes, and all three honour it the same way.
    if ("text".equals(type) || weightColumn != null || weightedPack != null) {
      List<String> values;
      double[] percents;
      if (weightColumn != null) {
        FileGen.Weighted weighted = FileGen.loadWeighted(attrs, baseDir, packs.dataRoots());
        values = weighted.values();
        percents = weighted.percents();
      } else if (weightedPack != null) {
        values = weightedPack.values();
        percents = weightedPack.percents();
      } else {
        values = splitText(attrs.getOrDefault("value", ""));
        String percentAttr = attrs.get("percent");
        percents =
            percentAttr != null && !percentAttr.isEmpty()
                ? PercentMask.expand(percentAttr, values.size())
                : evenly(values.size());
      }
      return quotaColumn(
          streamId, values, percents, domain, repeat, repeatPlan, repeatPosAt, mod, attrs);
    }

    // `length="2,10-12" percent="85,15"`: which length group a row gets is an exact quota over
    // the column, so it cannot come from the row's own draw — an apportionment over a single
    // cell always awards it to the largest share, turning 85/15 into 100/0. Plan the groups,
    // map the row into one, and let the digits still come from its own seekable draw.
    List<NumberGen.LengthChoice> lengthChoices = NumberGen.weightedLengthChoices(attrs);
    if (lengthChoices != null) {
      double[] percents =
          PercentMask.expand(attrs.getOrDefault("percent", ""), lengthChoices.size());
      int[] cumHi =
          cumulative(
              Hamilton.countsPerValue(
                  domain.size(), percents, Prng.create(seed + "|" + streamId + "|lenpct")));
      int key = Permute.key(seed, streamId + "#lenpct");
      return inlineBuilt(
          mod,
              row -> {
                Integer r = domain.popIndexAt().apply(row);
                if (r == null) {
                  return null;
                }
                NumberGen.LengthChoice group =
                    lengthChoices.get(runFor(cumHi, Permute.permute(r, domain.size(), key)));
                Config.Gen pinned = new Config.Gen(type, NumberGen.pinLength(attrs, group));
                return first(genValues(pinned, Seekable.generator(seed, streamId, row), null, row));
              },
          streamId,
          gen,
          domain);
    }

    // With `repeat`, each element of the cell is an independent draw on a stream of its own, so
    // the cell is reproducible without the row ever knowing what its neighbours produced.
    if (repeat != null) {
      Config.Gen single = new Config.Gen(type, Repeat.without(attrs));
      Repeat.Plan plan = repeatPlan;
      Column column =
          row -> {
            Integer p = repeatPosAt.apply(row);
            if (p == null) {
              return null;
            }
            List<String> parts = new ArrayList<>();
            for (int k = 0; k < plan.lengthAt(p); k++) {
              final int at = k;
              // A drawn generator has no pool to draw down, so `distinct` is rejection sampling
              // on fresh sub-streams — the same ids the reference uses, so the two agree value
              // for value.
              java.util.function.Function<String, String> drawAt =
                  suffix ->
                      first(
                          genValues(
                              single,
                              Seekable.generator(seed, streamId + "#e" + at + suffix, row),
                              null,
                              row));
              parts.add(
                  repeat.distinct()
                      ? Repeat.redrawUntilFresh(parts, gen.type(), drawAt)
                      : drawAt.apply(""));
            }
            return Repeat.join(parts, repeat);
          };
      String flagName = trimToNull(attrs.get("anomaly_flag"));
      if (flagName == null || Imperfections.parseAnomaly(attrs) == null) {
        return new Built(column);
      }
      // With `repeat` the flag is a LIST parallel to the values: one boolean could not say
      // which element of the batch was the one that spiked.
      return new Built(
          column,
          null,
          flagName,
          row -> {
            Integer p = repeatPosAt.apply(row);
            if (p == null) {
              return null;
            }
            // Under `distinct` the surviving value may have come off `#e{k}r3` rather than
            // the first attempt, so the flag has to be resolved on the SAME sub-stream.
            // Replaying the draw is what finds out which one won; asking the first attempt
            // would flag a value that was thrown away.
            List<String> flags = new ArrayList<>();
            List<String> seen = new ArrayList<>();
            for (int k = 0; k < plan.lengthAt(p); k++) {
              String suffix = "";
              if (repeat.distinct()) {
                final int at = k;
                java.util.function.Function<String, String> drawAt =
                    s2 ->
                        first(
                            genValues(
                                single,
                                Seekable.generator(seed, streamId + "#e" + at + s2, row),
                                null,
                                row));
                String[] won = Repeat.redrawUntilFreshAt(seen, gen.type(), drawAt);
                seen.add(won[0]);
                suffix = won[1];
              }
              boolean[] spiked = new boolean[1];
              genValues(
                  single, Seekable.generator(seed, streamId + "#e" + k + suffix, row), spiked,
                  row);
              flags.add(String.valueOf(spiked[0]));
            }
            return String.join(repeat.separator(), flags);
          });
    }

    // Everything else draws independently, from a generator private to the row. Those types
    // apply their own modifiers inside, so this path must not wrap them again.
    Column column =
        row -> {
          Integer r = domain.popIndexAt().apply(row);
          return r == null ? null : first(genValues(gen, Seekable.generator(seed, streamId, row), null, row));
        };
    return new Built(
        column, null, anomalyFlagName(attrs), anomalyFlagColumn(streamId, gen, domain));
  }

  /** The companion column named by {@code anomaly_flag=}, or {@code null} when there is none. */
  private static String anomalyFlagName(Map<String, String> attrs) {
    return Imperfections.parseAnomaly(attrs) == null ? null : trimToNull(attrs.get("anomaly_flag"));
  }

  /**
   * The flag that marks which rows were spiked.
   *
   * <p>It has to agree with the value on every row, so it is decided exactly the way the value's
   * own outlier was: the seekable draw for the types built here, and a re-run of the row's own
   * build for the types that draw independently. Deciding it any other way would give a flag
   * that is right on average and wrong per row, which is worse than no flag at all.
   */
  private Column anomalyFlagColumn(String streamId, Config.Gen gen, Domain domain) {
    return anomalyFlagColumn(streamId, gen, domain, null);
  }

  private Column anomalyFlagColumn(
      String streamId, Config.Gen gen, Domain domain, Column raw) {
    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(gen.attrs());
    if (anomaly == null || trimToNull(gen.attrs().get("anomaly_flag")) == null) {
      return null;
    }
    boolean inline = INLINE_TYPES.contains(gen.type());
    double p = anomaly.probability();
    Imperfections.Missing missing = Imperfections.parseMissing(gen.attrs());
    double missP = missing == null ? 0.0 : missing.probability();
    return row -> {
      if (domain.popIndexAt().apply(row) == null) {
        return null;
      }
      if (inline) {
        // A cell `missing=` blanked has no spike left to label.
        if (missP > 0 && Seekable.uniforms(seed, streamId + "#miss", row, 1)[0] < missP) {
          return "false";
        }
        // Selection is only half of it: a spike replaces a NUMBER, so a selected word is left
        // exactly as it was. `raw` is the value BEFORE the modifiers ran, because once
        // `missing=` has blanked a cell a word and a spiked number look alike.
        return String.valueOf(
            Seekable.uniforms(seed, streamId + "#anom", row, 1)[0] < p && isNumber(raw, row));
      }
      boolean[] spiked = new boolean[1];
      genValues(gen, Seekable.generator(seed, streamId, row), spiked, row);
      return String.valueOf(spiked[0]);
    };
  }

  /** Whether a spike could have landed on this row — only a number can be multiplied. */
  private static boolean isNumber(Column raw, int row) {
    if (raw == null) {
      return false;
    }
    String text = raw.valueAt(row);
    if (text == null) {
      return false;
    }
    try {
      double value = Double.parseDouble(text.trim());
      return !Double.isNaN(value) && !Double.isInfinite(value);
    } catch (NumberFormatException e) {
      return false;
    }
  }

  /**
   * An inline column, plus the {@code anomaly_flag} column beside it when one is declared.
   *
   * <p>The types built here never route through the per-row builder, so the flag they would
   * otherwise inherit from it has to be attached explicitly. Leaving it off did not fail loudly:
   * the column simply did not exist, and the interpolation reached the output as literal text.
   */
  private Built inlineBuilt(
      Modifier mod, Column raw, String streamId, Config.Gen gen, Domain domain) {
    return new Built(
        wrap(mod, raw),
        null,
        anomalyFlagName(gen.attrs()),
        anomalyFlagColumn(streamId, gen, domain, raw));
  }

  /**
   * One row's worth of an independently-drawn generator.
   *
   * <p>The values and the modifiers come off the same generator, in that order, because that is
   * the order the in-memory engine takes them in. Splitting them across two streams would give a
   * different column for the same seed, which is the one thing neither engine may do.
   */
  private List<String> genValues(Config.Gen gen, Prng.Sfc32 prng, boolean[] flagsOut) {
    return genValues(gen, prng, flagsOut, 0);
  }

  /**
   * The same, told which row the value belongs to.
   *
   * <p>Only a distribution parameter written as an expression looks at it, and it reads the
   * columns beside it through the lazy registry — the streaming half of the seam the in-memory
   * engine fills from its finished columns. A forward reference cannot arrive here: TDC240 refuses
   * a parameter naming a column declared below it.
   */
  private List<String> genValues(Config.Gen gen, Prng.Sfc32 prng, boolean[] flagsOut, int row) {
    MemoryEngine.Siblings siblings =
        new MemoryEngine.Siblings(columns::containsKey, (name, at) -> valueAt(name, at));
    Repeat.Spec repeat = Repeat.parse(gen.attrs());
    if (repeat == null) {
      return MemoryEngine.finish(
          MemoryEngine.generate(
              gen, 1, prng, packs, config, nowMillis, baseDir, new LinkedHashMap<>(), null,
              siblings, position -> row),
          gen.attrs(),
          prng,
          flagsOut == null ? new boolean[1] : flagsOut);
    }
    return Repeat.build(
        repeat,
        1,
        prng,
        slots ->
            MemoryEngine.finish(
                MemoryEngine.generate(
                    gen, slots, prng, packs, config, nowMillis, baseDir, new LinkedHashMap<>(),
                    null, siblings, position -> row),
                gen.attrs(),
                prng,
                new boolean[slots]));
  }

  /** A {@code <gen type="template">} pointing at a pack that carries its own shares. */
  private FileGen.Weighted weightedTemplatePack(Config.Gen gen) {
    if (!"template".equals(gen.type())) {
      return null;
    }
    String address = gen.attrs().getOrDefault("value", "");
    String locale = localeOf(gen.attrs());
    // A synthetic address (person.b_day and its kind) is resolved inside the generator and has
    // no pack file behind it, so asking the registry for it would throw rather than answer.
    if (address.isEmpty() || !packs.exists(address, locale)) {
      return null;
    }
    DataPacks.Entry entry = packs.load(address, locale);
    return entry.weighted() ? new FileGen.Weighted(entry.values(), entry.percents()) : null;
  }

  /**
   * A column whose values are apportioned exactly, resolved one row at a time.
   *
   * <p>The counts are computed once — the same apportionment the in-memory engine uses — and laid
   * out as contiguous runs of slots. A row asks the permutation which slot it owns and looks up
   * the run that contains it. No row needs to know about any other, and the totals still come out
   * exactly as declared.
   *
   * <p>With {@code repeat=} the quota is planned over ELEMENTS rather than rows, because a row
   * holding three values consumes three of them.
   */
  private Built quotaColumn(
      String streamId,
      List<String> values,
      double[] percents,
      Domain domain,
      Repeat.Spec repeat,
      Repeat.Plan repeatPlan,
      IntFunction<Integer> repeatPosAt,
      Modifier mod,
      Map<String, String> attrs) {
    int slotCount = repeatPlan != null ? repeatPlan.totalSlots() : domain.size();
    int[] counts =
        Hamilton.countsPerValue(slotCount, percents, Prng.create(seed + "|" + streamId + "|pct"));
    int[] cumHi = cumulative(counts);
    int key = Permute.key(seed, streamId);

    // The slot a row's k-th element owns, or null when the row is filtered out.
    java.util.function.BiFunction<Integer, Integer, Integer> slotAt =
        (row, k) -> {
          if (repeatPlan == null) {
            Integer r = domain.popIndexAt().apply(row);
            return r == null ? null : Permute.permute(r, slotCount, key);
          }
          Integer p = repeatPosAt.apply(row);
          return p == null ? null : Permute.permute(repeatPlan.slotStartAt(p) + k, slotCount, key);
        };

    Column column;
    if (repeat != null) {
      column =
          row -> {
            Integer p = repeatPosAt.apply(row);
            if (p == null) {
              return null;
            }
            int keep = repeatPlan.lengthAt(p);
            List<String> parts = new ArrayList<>();
            // `distinct` cannot read a pre-laid-out slot — a row that must not repeat itself
            // has to CHOOSE. One uniform per pick off the row's own `#dist` stream, budgeted
            // at the maximum length, so the row still resolves alone and the in-memory engine
            // lands on the same values.
            if (repeat.distinct()) {
              double[] draws = Seekable.uniforms(seed, streamId + "#dist", row, repeat.max());
              int[] at = {0};
              List<String> picked =
                  Repeat.drawDistinct(
                      values,
                      percents,
                      keep,
                      () -> at[0] < draws.length ? draws[at[0]++] : 1.0,
                      "the value list");
              for (int k = 0; k < picked.size(); k++) {
                String raw = picked.get(k);
                parts.add(mod == null ? raw : nullToEmpty(mod.apply(row, raw, k)));
              }
              return Repeat.join(parts, repeat);
            }
            for (int k = 0; k < keep; k++) {
              Integer slot = slotAt.apply(row, k);
              String raw = slot == null ? "" : values.get(runFor(cumHi, slot));
              parts.add(mod == null ? raw : nullToEmpty(mod.apply(row, raw, k)));
            }
            return Repeat.join(parts, repeat);
          };
    } else {
      column =
          wrap(
              mod,
              row -> {
                Integer slot = slotAt.apply(row, 0);
                return slot == null ? null : values.get(runFor(cumHi, slot));
              });
    }

    // A finite set of values with known quotas is exactly what a child can filter on — unless
    // the cell holds a LIST, in which case parent="Name.value" has nothing coherent to match.
    boolean repeating = repeat != null;
    ParentCapable parent =
        new ParentCapable() {
          @Override
          public boolean hasValue(String value) {
            return !repeating && values.contains(value);
          }

          @Override
          public int quotaOf(String value) {
            int i = values.indexOf(value);
            return i < 0 ? 0 : counts[i];
          }

          @Override
          public Integer childRankAt(int row, String value) {
            Integer slot = slotAt.apply(row, 0);
            int i = values.indexOf(value);
            if (slot == null || i < 0) {
              return null;
            }
            int lo = i == 0 ? 0 : cumHi[i - 1];
            // Its rank inside the run is its position among the rows that share this value.
            return slot >= lo && slot < cumHi[i] ? slot - lo : null;
          }
        };

    // The anomaly_flag beside an exactly-apportioned column. This path used to publish no flag
    // at all, so a declared anomaly_flag="Bad" registered nothing and ${{Bad}} reached the output
    // as its own literal text — a column of ${{Bad}} in the data, from a config the in-memory
    // engine renders correctly. The value and the anomaly draw are both functions of the row
    // here, so the flag is computable one row at a time.
    String flagName = anomalyFlagName(attrs);
    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(attrs);
    if (flagName == null || anomaly == null) {
      return new Built(column, parent, null, null);
    }

    int elementDraws = repeat != null ? Math.max(repeat.max(), 1) : 1;

    // What HAPPENED, not what was selected: anomaly multiplies a number and leaves anything else
    // alone, so a selected word is not an outlier and must not be marked.
    java.util.function.BiFunction<Integer, Integer, Boolean> spikedAt =
        (row, k) -> {
          Integer slot = slotAt.apply(row, k);
          if (slot == null) {
            return false;
          }
          String raw = values.get(runFor(cumHi, slot));
          double[] draws = Seekable.uniforms(seed, streamId + "#anom", row, elementDraws);
          double drawn = k < draws.length ? draws[k] : 1.0;
          return drawn < anomaly.probability() && Imperfections.isSpikeable(raw);
        };

    Column flag =
        row -> {
          if (repeat == null) {
            return slotAt.apply(row, 0) == null ? null : String.valueOf(spikedAt.apply(row, 0));
          }
          Integer p = repeatPosAt.apply(row);
          if (p == null) {
            return null;
          }
          // With repeat the flag is a LIST parallel to the values: one boolean could not say
          // which element of the batch was the one that spiked.
          List<String> parts = new ArrayList<>();
          for (int k = 0; k < repeatPlan.lengthAt(p); k++) {
            parts.add(String.valueOf(spikedAt.apply(row, k)));
          }
          return Repeat.join(parts, repeat);
        };

    return new Built(column, parent, flagName, flag);
  }

  // ── mix, switch, conditional ─────────────────────────────────────────────────────────────

  /**
   * {@code <mix>}: several ways to build one value, in stated proportions.
   *
   * <p>The same shape as a weighted text column — the shares are apportioned over the run and the
   * row's slot decides its case — with one addition: each case gets a domain of its own, so a
   * generator inside it is numbered within the rows that chose that case. Without that, two cases
   * drawing from the same pack would take the same values in the same order.
   */
  private Built buildMix(String streamId, Config.Mix mix, Domain domain) {
    List<Config.Case> cases = mix.cases();
    String flagName = trimToNull(mix.flag());

    if (domain.size() == 0 || cases.isEmpty()) {
      Column empty = row -> domain.popIndexAt().apply(row) == null ? null : "";
      Column flag = row -> domain.popIndexAt().apply(row) == null ? null : "false";
      return new Built(empty, null, flagName, flagName == null ? null : flag);
    }

    double[] percents =
        mix.percent() != null && !mix.percent().isEmpty()
            ? PercentMask.expand(mix.percent(), cases.size())
            : evenly(cases.size());
    int[] counts =
        Hamilton.countsPerValue(domain.size(), percents, Prng.create(seed + "|" + streamId + "|pct"));
    int[] cumHi = cumulative(counts);
    int key = Permute.key(seed, streamId);

    IntFunction<Integer> slotAt =
        row -> {
          Integer r = domain.popIndexAt().apply(row);
          return r == null ? null : Permute.permute(r, domain.size(), key);
        };

    List<CaseResolver> resolvers = new ArrayList<>();
    for (int c = 0; c < cases.size(); c++) {
      int index = c;
      int lo = index == 0 ? 0 : cumHi[index - 1];
      Domain caseDomain =
          new Domain(
              counts[index],
              row -> {
                Integer slot = slotAt.apply(row);
                return slot != null && slot >= lo && slot < cumHi[index] ? slot - lo : null;
              });
      resolvers.add(caseResolver(cases.get(c), streamId + "#c" + c, caseDomain));
    }

    Column column =
        row -> {
          Integer slot = slotAt.apply(row);
          return slot == null ? null : resolvers.get(runFor(cumHi, slot)).valueAt(row);
        };
    if (flagName == null) {
      return new Built(column);
    }
    return new Built(
        column,
        null,
        flagName,
        row -> {
          Integer slot = slotAt.apply(row);
          return slot == null ? null : String.valueOf(cases.get(runFor(cumHi, slot)).anomaly());
        });
  }

  /** A case body assembled from its pieces: literal text, a generator, or a nested mix. */
  private interface CaseResolver {
    String valueAt(int row);
  }

  private CaseResolver caseResolver(Config.Case caseSpec, String streamId, Domain domain) {
    List<Column> parts = new ArrayList<>();
    for (int p = 0; p < caseSpec.parts().size(); p++) {
      Config.CasePart part = caseSpec.parts().get(p);
      if (part.text() != null) {
        String text = part.text();
        parts.add(row -> text);
      } else if (part.gen() != null) {
        parts.add(buildGen(streamId + "#p" + p, part.gen(), domain).column());
      } else if (part.mix() != null) {
        // A nested mix contributes its value only; `flag=` is a top-level idea.
        parts.add(buildMix(streamId + "#p" + p, part.mix(), domain).column());
      } else {
        parts.add(nestedSwitch(streamId + "#p" + p, part.switchSpec(), domain));
      }
    }
    return row -> {
      StringBuilder out = new StringBuilder();
      for (Column part : parts) {
        out.append(nullToEmpty(part.valueAt(row)));
      }
      return out.toString();
    };
  }

  private void buildConditional(Config.SequenceSpec spec) {
    // Over every row, and without the parent mask — matching the reference. A conditional
    // already says which rows it applies to through its own conditions.
    Domain full = new Domain(count, row -> row);
    List<Column> branches = new ArrayList<>();
    List<String> flagNames = new ArrayList<>();
    List<Column> flagColumns = new ArrayList<>();
    for (int b = 0; b < spec.branches().size(); b++) {
      Built made = buildGen(spec.name() + "#if" + b, spec.branches().get(b).gen(), full);
      branches.add(made.column());
      flagNames.add(made.flagName());
      flagColumns.add(made.flag());
    }
    columns.put(
        spec.name(),
        row -> {
          for (int b = 0; b < spec.branches().size(); b++) {
            String condition = spec.branches().get(b).ifExpr();
            if (condition == null || condition(condition, row)) {
              return branches.get(b).valueAt(row);
            }
          }
          return null;
        });

    // A branch carrying anomaly_flag="NAME" mints the companion ground-truth column. It
    // answers over the SAME conditions: the row's flag comes from whichever branch produced
    // the row's value. A branch that did not declare this name answers "false" — not empty —
    // because the row IS covered and "no outlier" is the truth about it; a row no branch
    // matched gets null, masking the flag exactly like the value.
    List<String> declared = new ArrayList<>();
    for (String name : flagNames) {
      if (name != null && !name.trim().isEmpty() && !declared.contains(name.trim())) {
        declared.add(name.trim());
      }
    }
    for (String flagName : declared) {
      columns.put(
          flagName,
          row -> {
            for (int b = 0; b < spec.branches().size(); b++) {
              String condition = spec.branches().get(b).ifExpr();
              if (condition != null && !condition(condition, row)) {
                continue;
              }
              Column flag = flagColumns.get(b);
              if (flag == null || !flagName.equals(String.valueOf(flagNames.get(b)).trim())) {
                return "false";
              }
              String value = flag.valueAt(row);
              return value == null ? "false" : value;
            }
            return null;
          });
    }
  }

  /**
   * A {@code <switch>} written inside a {@code <case>} — the nested form.
   *
   * <p>Every branch resolves over the SAME domain as the case it sits in. A branch's own rows are
   * an intersection of two partitions — the enclosing branch's and the inner subject's — and
   * there is no O(1) rank inside an intersection, which is what an exact share would need. So a
   * nested branch that declares one is refused here and the router sends the config to the
   * in-memory engine. A branch that declares none needs no rank: the row decides which branch
   * answers, and both engines read the same row.
   */
  private Column nestedSwitch(String streamId, Config.Switch sw, Domain domain) {
    List<CaseResolver> resolvers = new ArrayList<>();
    List<List<String>> allKeys = new ArrayList<>();
    for (int e = 0; e < sw.entries().size(); e++) {
      Config.SwitchEntry entry = sw.entries().get(e);
      if (carriesPercent(entry.value())) {
        throw unsupported(
            "a percentage inside <case is=\""
                + String.join("|", entry.keys())
                + "\"> of a nested <switch on=\""
                + sw.on()
                + "\">",
            streamId);
      }
      allKeys.add(entry.keys());
      resolvers.add(caseResolver(entry.value(), streamId + "#sw" + e, domain));
    }
    if (carriesPercent(sw.fallback())) {
      throw unsupported(
          "a percentage inside <default> of a nested <switch on=\"" + sw.on() + "\">", streamId);
    }
    CaseResolver fallback =
        sw.fallback() == null ? null : caseResolver(sw.fallback(), streamId + "#swdef", domain);

    return row -> {
      String key = nullToEmpty(valueAt(sw.on(), row));
      for (int e = 0; e < allKeys.size(); e++) {
        if (allKeys.get(e).contains(key)) {
          return resolvers.get(e).valueAt(row);
        }
      }
      return fallback == null ? null : fallback.valueAt(row);
    };
  }

  /**
   * The rows that chose one branch, numbered within themselves, or null when they cannot be.
   *
   * <p>Every branch used to get the whole run, which made a {@code <mix percent="20,80">} inside
   * {@code <case is="Male">} apportion its 20% over ALL the rows; the ones that landed on female
   * rows were then discarded. The subset was never out of reach — a branch of
   * {@code <switch on="Gender">} keyed {@code Male} wants exactly the domain
   * {@code parent="Gender.Male"} already gets.
   *
   * <p>One key only. A multi-key entry ({@code US|CA|MX}) is the union of subsets, and ranks
   * across a union do not compose from the per-value ranks — the interleaving is what decides
   * them. Refused rather than approximated.
   */
  private Domain branchDomain(String on, List<String> keys) {
    if (keys.size() != 1) {
      return null;
    }
    String key = keys.get(0);
    ParentCapable parent = parents.get(on);
    if (parent == null || !parent.hasValue(key)) {
      return null;
    }
    return new Domain(parent.quotaOf(key), row -> parent.childRankAt(row, key));
  }

  /** Does this branch declare a share that the domain has to be right for? */
  private static boolean carriesPercent(Config.Case body) {
    if (body == null) {
      return false;
    }
    for (Config.CasePart part : body.parts()) {
      if (part.mix() != null && !trimToEmpty(part.mix().percent()).isEmpty()) {
        return true;
      }
      if (part.gen() != null && !trimToEmpty(part.gen().attrs().get("percent")).isEmpty()) {
        return true;
      }
    }
    return false;
  }

  private static String trimToEmpty(String value) {
    return value == null ? "" : value.trim();
  }

  private void buildSwitch(Config.SequenceSpec spec) {
    Config.Switch sw = spec.switchSpec();
    Domain full = new Domain(count, row -> row);
    List<CaseResolver> entries = new ArrayList<>();
    for (int e = 0; e < sw.entries().size(); e++) {
      Config.SwitchEntry entry = sw.entries().get(e);
      Domain domain = branchDomain(sw.on(), entry.keys());
      if (domain == null && carriesPercent(entry.value())) {
        // Cannot be resolved lazily over the right subset, and resolving it over the wrong one
        // is what this change exists to stop. Refuse, and the run falls back to the in-memory
        // engine, which can.
        throw unsupported(
            "a percentage inside <case is=\""
                + String.join("|", entry.keys())
                + "\"> of <switch on=\""
                + sw.on()
                + "\">",
            spec.name());
      }
      entries.add(
          caseResolver(entry.value(), spec.name() + "#sw" + e, domain == null ? full : domain));
    }
    if (carriesPercent(sw.fallback())) {
      // <default> holds the rows no entry matched — a complement, which ParentCapable does not
      // enumerate. Same refusal, same fallback.
      throw unsupported(
          "a percentage inside <default> of <switch on=\"" + sw.on() + "\">", spec.name());
    }
    CaseResolver fallback =
        sw.fallback() == null ? null : caseResolver(sw.fallback(), spec.name() + "#swdef", full);

    columns.put(
        spec.name(),
        row -> {
          String key = nullToEmpty(valueAt(sw.on(), row));
          for (int e = 0; e < sw.entries().size(); e++) {
            if (sw.entries().get(e).keys().contains(key)) {
              return entries.get(e).valueAt(row);
            }
          }
          return fallback == null ? null : fallback.valueAt(row);
        });
  }

  // ── distinct ─────────────────────────────────────────────────────────────────────────────

  /**
   * {@code <distinct>}: fields of one record that must not repeat each other.
   *
   * <p>Two independent draws from the same pool collide about as often as chance says they
   * should, which reads as a bug in a record where a person cannot be their own manager. The
   * repair is per row and needs nothing else: a colliding field redraws on a fresh stream until
   * it differs, and every implementation redraws in the same order on the same streams.
   */
  private void applyDistinct(Config.SequenceSpec spec, Map<String, Column> fields) {
    if (spec.distinctGroups() == null) {
      return;
    }
    List<List<String>> groups = new ArrayList<>();
    for (List<String> group : spec.distinctGroups()) {
      List<String> present = new ArrayList<>();
      for (String field : group) {
        if (fields.containsKey(field)) {
          present.add(field);
        }
      }
      if (present.size() >= 2) {
        groups.add(present);
      }
    }
    if (groups.isEmpty()) {
      return;
    }

    Map<String, Config.Gen> genByField = new LinkedHashMap<>();
    for (Config.Field field : spec.fields()) {
      genByField.put(field.name(), field.gen());
    }

    // One row's repair, remembered: the fields of a row are asked for one after another, so a
    // single-entry memo turns N lookups into one repair rather than N.
    RowRepair repair =
        new RowRepair(
            row -> {
              Map<String, String> values = new LinkedHashMap<>();
              for (Map.Entry<String, Column> entry : fields.entrySet()) {
                values.put(entry.getKey(), entry.getValue().valueAt(row));
              }
              for (List<String> group : groups) {
                Set<String> seen = new LinkedHashSet<>();
                for (String fieldName : group) {
                  String value = values.get(fieldName);
                  if (value == null) {
                    continue; // an inactive row, filtered out by its parent
                  }
                  Config.Gen gen = genByField.get(fieldName);
                  int attempt = 0;
                  while (seen.contains(value) && gen != null) {
                    attempt++;
                    if (attempt > DISTINCT_FUSE) {
                      throw new IllegalStateException(
                          "stream mode: <distinct> in sequence \""
                              + spec.name()
                              + "\": could not find a value for field \""
                              + fieldName
                              + "\" different from the others after "
                              + DISTINCT_FUSE
                              + " attempts — its source likely has too few distinct values.");
                    }
                    String key = spec.name() + "." + fieldName + "#d" + attempt;
                    value = first(genValues(gen, Seekable.generator(seed, key, row), null, row));
                  }
                  values.put(fieldName, value);
                  seen.add(value);
                }
              }
              return values;
            });

    Set<String> repaired = new LinkedHashSet<>();
    for (List<String> group : groups) {
      repaired.addAll(group);
    }
    for (String fieldName : repaired) {
      columns.put(spec.name() + "." + fieldName, row -> repair.at(row).get(fieldName));
    }
  }

  /** One row's repaired values, kept for as long as that row is the one being asked about. */
  private static final class RowRepair {
    private final IntFunction<Map<String, String>> compute;
    private int cachedRow = -1;
    private Map<String, String> cached = Map.of();

    RowRepair(IntFunction<Map<String, String>> compute) {
      this.compute = compute;
    }

    Map<String, String> at(int row) {
      if (row != cachedRow) {
        cached = compute.apply(row);
        cachedRow = row;
      }
      return cached;
    }
  }

  // ── uniq ─────────────────────────────────────────────────────────────────────────────────

  /**
   * {@code uniq="true"}: no two records share the same combination.
   *
   * <p>The in-memory engine draws and then repairs collisions, which needs to see every row. Here
   * the combination space is treated as a number instead: the fields are the digits of a
   * mixed-radix counter, and the permutation turns row {@code i} into a distinct index in it. No
   * two rows can collide because no two indices can, and nothing has to be remembered.
   *
   * <p>The price is that the combinations come out uniform. Exact percentages and uniqueness at
   * the same time need the whole column, so a percent-weighted uniq is refused here rather than
   * quietly delivered as an even split.
   */
  private void buildUniq(Config.SequenceSpec spec) {
    if (!exactUniq) {
      // A group REARRANGES whole columns so each keeps its multiset — a promise about the
      // finished column, which no engine can keep a row at a time. This one could only offer
      // something else (a mixed-radix bijection over the combination space, uniform over
      // combinations, ignoring the values actually drawn), and one seed would then mean two
      // datasets. It says so instead. The router sends every uniq to the exact engine; this is
      // the backstop for a forced one.
      throw unsupported("uniq (a whole-column rearrangement)", spec.name());
    }
    if (!spec.isCompound() || spec.fields().isEmpty()) {
      throw unsupported("uniq on a simple sequence (a whole-column draw)", spec.name());
    }
    if (trimToNull(spec.parent()) != null) {
      throw unsupported("uniq combined with a parent", spec.name());
    }
    buildExactUniq(spec);
  }

  /**
   * The exact-engine version: each column built to its declared shares, then verified distinct.
   *
   * <p>Where the streaming version trades exact percentages for uniqueness, this one keeps both —
   * at the cost of a pass over the run to check, and a repair when the check finds collisions.
   * See {@link ExactUniq} for why that stays affordable.
   */
  private void buildExactUniq(Config.SequenceSpec spec) {
    List<ExactUniq.Field> fields = new ArrayList<>();
    for (Config.Field field : spec.fields()) {
      Config.Gen gen = field.gen();
      if (!"text".equals(gen.type())) {
        throw unsupported(
            "uniq field \"" + field.name() + "\" of type \"" + gen.type() + "\" (only text lists)",
            spec.name());
      }
      List<String> values =
          new ArrayList<>(new LinkedHashSet<>(splitText(gen.attrs().getOrDefault("value", ""))));
      if (values.isEmpty()) {
        throw unsupported("uniq field \"" + field.name() + "\" with an empty value list", spec.name());
      }
      String percentAttr = gen.attrs().get("percent");
      double[] percents =
          percentAttr != null && !percentAttr.isEmpty()
              ? PercentMask.expand(percentAttr, values.size())
              : evenly(values.size());
      fields.add(new ExactUniq.Field(spec.name() + "." + field.name(), values, percents));
    }

    Map<String, ExactUniq.Resolver> built =
        ExactUniq.arrange(fields, count, seed, "\"" + spec.name() + "\"", baseDir);
    for (Map.Entry<String, ExactUniq.Resolver> entry : built.entrySet()) {
      ExactUniq.Resolver resolver = entry.getValue();
      columns.put(entry.getKey(), resolver::valueAt);
    }
  }

  // ── writing ──────────────────────────────────────────────────────────────────────────────

  private void write(Appendable out, int from, int to) {
    Config.Fixtures fx = config.fixtures();
    Map<String, Repeat.Spec> eachInfo = eachInfo();
    try {
      if (from == 0) {
        emit(out, fx.before(), 0);
      }
      for (int row = from; row < to; row++) {
        emit(out, fx.beforeBlock(), row);

        List<Config.Line> active = new ArrayList<>();
        for (Config.Line line : config.block()) {
          if (line.ifExpr() == null || condition(line.ifExpr(), row)) {
            active.add(line);
          }
        }
        // The OUTPUT lines, not the <line> ELEMENTS — see the note in the in-memory engine.
        // The two must agree byte for byte, so they count the same thing.
        List<String> emitted = new ArrayList<>();
        for (Config.Line line : active) {
          emitted.addAll(renderLine(line, row, eachInfo));
        }
        for (int i = 0; i < emitted.size(); i++) {
          emit(out, fx.beforeLine(), row);
          out.append(emitted.get(i));
          emit(out, fx.afterLine(), row);
          if (i < emitted.size() - 1) {
            emit(out, fx.delimiterLine(), row);
          }
        }

        emit(out, fx.afterBlock(), row);
        if (row < count - 1) {
          emit(out, fx.delimiterBlock(), row);
        }
      }
      if (to == count) {
        emit(out, fx.after(), count - 1);
      }
    } catch (IOException e) {
      throw new UncheckedIOException("cannot write the generated data", e);
    }
  }

  private Map<String, Repeat.Spec> eachInfo() {
    Map<String, Repeat.Spec> out = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.gen() == null) {
        continue;
      }
      Repeat.Spec repeat = Repeat.parse(spec.gen().attrs());
      if (repeat != null) {
        out.put(spec.name(), repeat);
      }
    }
    return out;
  }

  private void emit(Appendable out, List<Config.Line> lines, int row) throws IOException {
    for (Config.Line line : lines) {
      // A fixture line is one output line, and renderLine hands back the LINES.
      for (String text : renderLine(line, row, Map.of())) {
        out.append(text);
      }
    }
  }

  private List<String> renderLine(
      Config.Line line, int row, Map<String, Repeat.Spec> eachInfo) {
    StringBuilder text = new StringBuilder();
    for (Config.DataPart part : line.parts()) {
      if (part.ifExpr() == null || condition(part.ifExpr(), row)) {
        text.append(part.text());
      }
    }
    String template = text.toString();

    String listName = trimToNull(line.each());
    if (listName == null) {
      return List.of(Interpolate.apply(template, config.inject(), lookup(row)) + "\n");
    }

    Repeat.Spec spec = eachInfo.get(listName);
    List<String> elements =
        Repeat.split(
            nullToEmpty(valueAt(listName, row)),
            spec == null ? Repeat.DEFAULT_SEPARATOR : spec.separator());

    int lane = 0;
    int stride = 0;
    for (Map.Entry<String, Repeat.Spec> entry : eachInfo.entrySet()) {
      if (entry.getKey().equals(listName)) {
        lane = stride;
      }
      stride += entry.getValue().max();
    }
    if (stride == 0) {
      stride = elements.size();
    }

    List<String> out = new ArrayList<>();
    for (int k = 0; k < elements.size(); k++) {
      out.add(
          Interpolate.apply(
                  template,
                  config.inject(),
                  elementLookup(row, listName, elements.get(k), k + 1, lane, stride))
              + "\n");
    }
    return out;
  }

  // ── row access ───────────────────────────────────────────────────────────────────────────

  private String valueAt(String name, int row) {
    Column column = columns.get(name);
    return column == null ? null : column.valueAt(row);
  }

  private Interpolate.Lookup lookup(int row) {
    return new Interpolate.Lookup() {
      @Override
      public boolean has(String name) {
        return columns.containsKey(name);
      }

      @Override
      public String value(String name) {
        return nullToEmpty(valueAt(name, row));
      }
    };
  }

  private Interpolate.Lookup elementLookup(
      int row, String listName, String element, int position, int lane, int stride) {
    Map<String, String> overlay =
        Map.of(
            listName, element,
            "_item", String.valueOf(position),
            "_item_id", String.valueOf(Repeat.itemKey(row + 1, position, lane, stride)));
    Interpolate.Lookup base = lookup(row);
    return new Interpolate.Lookup() {
      @Override
      public boolean has(String name) {
        return overlay.containsKey(name) || base.has(name);
      }

      @Override
      public String value(String name) {
        return overlay.containsKey(name) ? overlay.get(name) : base.value(name);
      }
    };
  }

  private boolean condition(String expression, int row) {
    return io.github.nickliapin.tdc.expr.Evaluate.asCondition(
        expression,
        new io.github.nickliapin.tdc.expr.Evaluate.Scope() {
          @Override
          public boolean has(String name) {
            return columns.containsKey(name);
          }

          @Override
          public String value(String name) {
            return nullToEmpty(valueAt(name, row));
          }
        });
  }

  // ── modifiers ────────────────────────────────────────────────────────────────────────────

  /** The per-row passes an inline-built value still needs: outliers, blanks, formatting. */
  private interface Modifier {
    String apply(int row, String value, int element);
  }

  private Modifier modifierFor(String streamId, Map<String, String> attrs, int elementDraws) {
    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(attrs);
    Imperfections.Missing missing = Imperfections.parseMissing(attrs);
    boolean hasAnomaly = anomaly != null && anomaly.probability() > 0;
    boolean hasMissing = missing != null && missing.probability() > 0;
    String mask = attrs.get("mask");
    String caseName = attrs.get("case");
    boolean hasFormat = mask != null || (caseName != null && Transforms.isCaseTransform(caseName));

    if (!hasAnomaly && !hasMissing && !hasFormat) {
      return null;
    }
    return (row, value, element) -> {
      if (value == null) {
        return null;
      }
      String out = value;
      // Each modifier draws on a stream of its own, so adding one never disturbs the values.
      // With `repeat` a row needs one draw per element, so the row's draws are pulled at once and
      // indexed — asking for one draw and asking for the first of many give the same number.
      if (hasAnomaly
          && Seekable.uniforms(seed, streamId + "#anom", row, elementDraws)[element]
              < anomaly.probability()) {
        out = Imperfections.spike(out, anomaly.factor());
      }
      if (hasMissing
          && Seekable.uniforms(seed, streamId + "#miss", row, elementDraws)[element]
              < missing.probability()) {
        out = missing.token();
      }
      if (mask != null) {
        out = Mask.apply(mask, out);
      }
      if (caseName != null && Transforms.isCaseTransform(caseName)) {
        out = Transforms.applyCase(caseName, out);
      }
      return out;
    };
  }

  private static Column wrap(Modifier mod, Column column) {
    return mod == null ? column : row -> mod.apply(row, column.valueAt(row), 0);
  }

  // ── small helpers ────────────────────────────────────────────────────────────────────────

  /** Which run of the cumulative bounds holds this slot — binary search, for wide columns. */
  private static int runFor(int[] cumHi, int slot) {
    int lo = 0;
    int hi = cumHi.length - 1;
    while (lo < hi) {
      int mid = (lo + hi) >>> 1;
      if (slot < cumHi[mid]) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  private static int[] cumulative(int[] counts) {
    int[] out = new int[counts.length];
    int acc = 0;
    for (int i = 0; i < counts.length; i++) {
      acc += counts[i];
      out[i] = acc;
    }
    return out;
  }

  private String localeOf(Map<String, String> attrs) {
    String local = attrs.get("local");
    return local == null || local.isBlank() ? config.locale() : local;
  }

  private static List<String> splitText(String value) {
    List<String> parts = new ArrayList<>();
    for (String part : value.split(",", -1)) {
      parts.add(part.trim());
    }
    return parts;
  }

  private static double[] evenly(int n) {
    double[] out = new double[n];
    Arrays.fill(out, 100.0 / n);
    return out;
  }

  private static String first(List<String> values) {
    return values.isEmpty() ? "" : values.get(0);
  }

  private static String pickSequential(List<String> list, int index, boolean cycle) {
    if (list.isEmpty()) {
      return "";
    }
    if (!cycle && index >= list.size()) {
      throw new IllegalStateException(
          "order=\"sequential\" cycle=\"false\": the source has only "
              + list.size()
              + " values, so row "
              + (index + 1)
              + " has none — shorten count= or lengthen the source");
    }
    return list.get(index % list.size());
  }

  private static String format(double v, int decimals) {
    return io.github.nickliapin.tdc.lib.Fixed.toFixed(v, decimals);
  }

  private static long longAttr(String raw, long fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    return Long.parseLong(raw.trim());
  }

  private static String nullToEmpty(String value) {
    return value == null ? "" : value;
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
