package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.expr.MatchKey;
import io.github.nickliapin.tdc.compute.Compute;
import io.github.nickliapin.tdc.date.DateGen;
import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.format.Mask;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.generators.DateOffset;
import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.generators.Counter;
import io.github.nickliapin.tdc.generators.FileGen;
import io.github.nickliapin.tdc.generators.Formula;
import io.github.nickliapin.tdc.generators.Quantile;
import io.github.nickliapin.tdc.generators.HttpGen;
import io.github.nickliapin.tdc.generators.Accumulate;
import io.github.nickliapin.tdc.generators.Stat;
import io.github.nickliapin.tdc.generators.Imperfections;
import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.generators.SymbolGen;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.pattern.PatternGen;
import io.github.nickliapin.tdc.parser.ConfigBuilder;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import io.github.nickliapin.tdc.sequence.Assertions;
import io.github.nickliapin.tdc.sequence.Pool;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Seekable;
import io.github.nickliapin.tdc.prng.Random;
import io.github.nickliapin.tdc.sequence.Uniq;
import io.github.nickliapin.tdc.stats.DistParams;
import io.github.nickliapin.tdc.stats.Distribution;
import io.github.nickliapin.tdc.stats.Timeseries;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The in-memory engine: materialize every column up front, then render row by row.
 *
 * <p>This is the engine the golden fixtures were captured from, so it is the one a port has to
 * match. The streaming engines compute a row from its index instead, and are a separate job.
 *
 * <p>The thing that decides whether output matches is not the algorithm but the <b>order the
 * shared generator is consumed in</b>. Columns are built in declaration order, each drawing
 * from one generator seeded once. Building them in a different order, or giving each its own
 * generator, produces perfectly valid data that matches nothing.
 */
public final class MemoryEngine {

  private MemoryEngine() {}

  /**
   * A finished run: the text, and the columns it was rendered from.
   *
   * <p>Both, because they answer different questions. A test that asserts on a field wants the
   * column; a file on disk wants the text. Generating them separately would take two runs of the
   * generator and could produce two different answers.
   */
  public record Rendered(String text, Map<String, String[]> columns, int count)
      implements RowSource {

    /** The value of one column on one row; {@code null} when that row has none. */
    @Override
    public String value(String column, int row) {
      String[] values = columns.get(column);
      return values == null ? null : values[row];
    }

    /** Only the declared sequences, in declaration order — not the built-in {@code _count} row. */
    @Override
    public List<String> sequenceNames() {
      List<String> out = new ArrayList<>();
      for (String name : columns.keySet()) {
        if (!name.startsWith("_")) {
          out.add(name);
        }
      }
      return out;
    }
  }

  public static String render(Config config, DataPacks packs, long nowMillis) {
    return build(config, packs, nowMillis, null).text();
  }

  /**
   * @param baseDir the folder a {@code src=} path is relative to — the config file's own folder,
   *     so a config means the file next to itself rather than the one next to whatever directory
   *     the program was started from.
   */
  public static Rendered build(Config config, DataPacks packs, long nowMillis, Path baseDir) {
    int count = config.count();
    Map<String, String[]> columns = buildColumns(config, count, packs, nowMillis, baseDir);

    // The run is finished; now the config gets to check its own output — before a single line is
    // written, because a file that exists is a file someone will use.
    Assertions.check(
        config,
        (name, row) -> {
          String[] column = columns.get(name);
          return column == null || row >= column.length ? null : column[row];
        },
        columns::containsKey);

    Map<String, Repeat.Spec> eachInfo = eachInfo(config);
    Config.Fixtures fx = config.fixtures();
    StringBuilder out = new StringBuilder();
    emit(out, fx.before(), columns, 0, config.inject());

    for (int row = 0; row < count; row++) {
      emit(out, fx.beforeBlock(), columns, row, config.inject());

      // Drop the suppressed lines first. A delimiter belongs between the lines that survive,
      // so deciding that up front is what keeps a separator off the last one standing.
      List<Config.Line> active = new ArrayList<>();
      for (Config.Line line : config.block()) {
        if (line.ifExpr() == null || condition(line.ifExpr(), columns, row)) {
          active.add(line);
        }
      }
      // The OUTPUT lines, not the <line> ELEMENTS. One `<line each="Items">` produces as many
      // output lines as the list has elements, and the three per-line fixtures are documented as
      // wrapping "the lines of a record" — so they have to see what the reader sees. They used to
      // see the elements, and <delimiter_line> between the repetitions of an each= line therefore
      // did nothing at all: no comma between the members of an array, in silence.
      List<String> emitted = new ArrayList<>();
      for (Config.Line line : active) {
        emitted.addAll(renderLine(line, columns, row, config.inject(), eachInfo));
      }
      for (int i = 0; i < emitted.size(); i++) {
        emit(out, fx.beforeLine(), columns, row, config.inject());
        out.append(emitted.get(i));
        emit(out, fx.afterLine(), columns, row, config.inject());
        if (i < emitted.size() - 1) {
          emit(out, fx.delimiterLine(), columns, row, config.inject());
        }
      }

      emit(out, fx.afterBlock(), columns, row, config.inject());
      if (row < count - 1) {
        emit(out, fx.delimiterBlock(), columns, row, config.inject());
      }
    }

    emit(out, fx.after(), columns, count - 1, config.inject());
    return new Rendered(out.toString(), columns, count);
  }

  private static void emit(
      StringBuilder out,
      List<Config.Line> lines,
      Map<String, String[]> columns,
      int row,
      String inject) {
    for (Config.Line line : lines) {
      // A fixture line is one output line, and renderLine hands back the LINES.
      for (String text : renderLine(line, columns, row, inject, Map.of())) {
        out.append(text);
      }
    }
  }

  /**
   * The repeating sequences, indexed by name.
   *
   * <p>A name that is not here is not a list, so {@code each=} on it walks nothing.
   */
  private static Map<String, Repeat.Spec> eachInfo(Config config) {
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

  /**
   * Materialize every column.
   *
   * <p>A value of {@code null} means "this row is outside the column's parent filter", which
   * renders as empty rather than as a neighbour's value shifted up.
   */
  /**
   * Compute every {@code <pool>} declared in the config, once, before any row exists.
   *
   * <p>A pool is built by the ORDINARY column machinery with {@code count} set to the member count
   * instead of the row count — which is the whole reason a {@code <uniq>}, a {@code <mix>}, an
   * {@code if=} or a {@code parent=} inside a pool behaves exactly as it does outside one, with
   * nothing here to make it so.
   */
  /**
   * Publish a running total.
   *
   * <p>Reads its source out of the columns rather than drawing anything: a running total consumes
   * no randomness at all, which is why adding one leaves every other column exactly where it was.
   */
  private static void runningColumn(
      Config.SequenceSpec spec, Map<String, String[]> columns, int count) {
    Map<String, String> attrs = spec.gen().attrs();
    String of = attrs.getOrDefault("of", "").trim();
    String op = Accumulate.read(attrs);
    String[] source = columns.get(of);
    if (op == null || source == null) {
      return; // the validator reports both
    }
    String resetName = attrs.getOrDefault("reset", "").trim();
    String[] resetAt = resetName.isEmpty() ? null : columns.get(resetName);
    String base = attrs.getOrDefault("base", "").trim();
    String[] values = java.util.Arrays.copyOf(source, Math.min(count, source.length));
    columns.put(spec.name(), Accumulate.applyColumn(values, op, base.isEmpty() ? null : base, resetAt));
  }

  /**
   * Publish a statistic over the whole run: ONE value, on every row.
   *
   * <p>Reads its source out of the columns rather than drawing anything, exactly as a running
   * total does — which is why adding one leaves every other column where it was.
   */
  /**
   * {@code <gen type="formula">} — arithmetic over the columns beside it.
   *
   * <p>Resolved here for the same reason {@code running} and {@code stat} are: it reads columns
   * that already exist, so every name in {@code expr=} has to be declared above. Unlike them it
   * needs only its OWN row, which is why it also streams — unless it calls {@code prev()}, and
   * then {@code sequential} hands it the row before.
   */
  private static void formulaColumn(
      Config.SequenceSpec spec, Map<String, String[]> columns, int count, boolean sequential) {
    Map<String, String> attrs = spec.gen().attrs();
    String source = Formula.expressionOf(attrs);
    Integer decimals = Formula.decimalsOf(attrs);
    String[] values = new String[count];
    for (int row = 0; row < count; row++) {
      final int here = row;
      // The previous row, and only under the mode that promises there IS one. The column's own
      // earlier cells live in `values` — they are not in `columns` until the loop ends — so its
      // own past is read from there and every other column from the map.
      java.util.function.Function<String, String> previousAt =
          !sequential
              ? null
              : name -> {
                if (here == 0) {
                  return null; // no earlier row: prev() falls back to its initial value
                }
                if (name.equals(spec.name())) {
                  return values[here - 1];
                }
                String[] column = columns.get(name);
                return column != null && here - 1 < column.length ? column[here - 1] : null;
              };
      values[row] =
          Formula.valueAtRow(
              source,
              decimals,
              here,
              columns::containsKey,
              name -> {
                String[] column = columns.get(name);
                return column != null && here < column.length ? column[here] : null;
              },
              previousAt);
    }
    columns.put(spec.name(), values);
  }

  private static void statColumn(
      Config.SequenceSpec spec, Map<String, String[]> columns, int count) {
    Map<String, String> attrs = spec.gen().attrs();
    String of = attrs.getOrDefault("of", "").trim();
    String op = Stat.read(attrs);
    String[] source = columns.get(of);
    if (op == null || source == null) {
      return; // the validator reports both
    }
    Integer decimals;
    try {
      decimals = Stat.parseDecimals(attrs);
    } catch (Stat.StatError e) {
      return; // a bad decimals= is a diagnostic, not a crash
    }
    String[] values = java.util.Arrays.copyOf(source, Math.min(count, source.length));
    String answer = Stat.statistic(values, op, decimals);
    String[] column = new String[count];
    java.util.Arrays.fill(column, answer);
    columns.put(spec.name(), column);
  }

  static Map<String, Pool.Table> buildPoolTables(
      Config config, DataPacks packs, long nowMillis, Path baseDir) {
    Map<String, Pool.Table> tables = new LinkedHashMap<>();
    for (Config.PoolSpec spec : config.pools()) {
      if (spec.name().isEmpty() || spec.count() < 1) {
        continue; // the validator already said so
      }
      Config inner =
          new Config(
              spec.count(),
              Pool.poolSeed(config.seed(), spec.name()),
              config.locale(),
              config.inject(),
              config.regexMaxLength(),
              spec.sequences(),
              config.block(),
              config.fixtures(),
              config.mode(),
              config.engine(),
              spec.uniqGroups(),
              spec.distinctGroups());
      // The pools already built — so a MEMBER can reference one, exactly as a row does.
      // Declaration order is the whole cycle check: a pool sees only the pools above it.
      Map<String, String[]> built =
          buildColumns(inner, spec.count(), packs, nowMillis, baseDir, tables);

      List<String> fields = new ArrayList<>();
      Map<String, List<String>> columns = new LinkedHashMap<>();
      for (Config.SequenceSpec member : spec.sequences()) {
        // A member that references another pool publishes ONLY `name.field` — a record has no
        // value of its own — which is why the dotted keys are matched here too.
        for (Map.Entry<String, String[]> entry : built.entrySet()) {
          if (!entry.getKey().equals(member.name())
              && !entry.getKey().startsWith(member.name() + ".")) {
            continue;
          }
          fields.add(entry.getKey());
          List<String> values = new ArrayList<>(entry.getValue().length);
          for (String v : entry.getValue()) {
            values.add(v == null ? "" : v);
          }
          columns.put(entry.getKey(), values);
        }
      }
      tables.put(spec.name(), new Pool.Table(spec.name(), spec.count(), fields, columns));
    }
    return tables;
  }

  /**
   * Publish one member of a pool per row, under {@code Ref.field} for every field it has.
   *
   * <p>One pick per ROW, shared by every field: that is what makes the first name and the last
   * name in a row belong to the same doctor. Not one pick per field, which is exactly how
   * "Дмитрий Иванова" would get out.
   */
  private static void poolReference(
      Config.SequenceSpec spec,
      Map<String, String[]> columns,
      boolean[] mask,
      int count,
      Map<String, Pool.Table> tables,
      String seed) {
    String poolName = spec.gen().attr("value", "").trim();
    Pool.Table table = tables.get(poolName);
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

    int[] members = new int[count];
    for (int row = 0; row < count; row++) {
      if (!mask[row]) {
        members[row] = -1;
        continue;
      }
      if (expression.isEmpty()) {
        members[row] = Pool.pickMember(seed, spec.name(), table, row);
        continue;
      }
      List<Integer> eligible;
      String detail = "";
      if (equality != null) {
        String[] driver = columns.get(equality[1]);
        String wanted = driver == null || driver[row] == null ? "" : driver[row];
        eligible = buckets.getOrDefault(MatchKey.of(wanted), List.of());
        detail = " (" + equality[1] + "=\"" + wanted + "\")";
      } else {
        eligible = new ArrayList<>();
        Map<String, String> read = new java.util.LinkedHashMap<>();
        for (int m = 0; m < table.count(); m++) {
          if (Evaluate.asCondition(expression, new MemberScope(columns, table, m, row, read))) {
            eligible.add(m);
          }
        }
        detail = Pool.rowValuesDetail(read);
      }
      if (eligible.isEmpty()) {
        throw new IllegalStateException(
            Pool.noCandidateMessage(poolName, expression, row, detail));
      }
      members[row] =
          eligible.get(
              Seekable.nextInt(seed, Pool.refStream(spec.name()), row, eligible.size()));
    }

    for (String field : table.fields()) {
      List<String> column = table.columns().getOrDefault(field, List.of());
      String[] values = new String[count];
      for (int row = 0; row < count; row++) {
        int m = members[row];
        values[row] = m < 0 ? null : (m < column.size() ? column.get(m) : "");
      }
      columns.put(spec.name() + "." + field, values);
    }
  }

  /**
   * A candidate member's fields first, then the row's columns.
   *
   * <p>A qualified {@code Pool.field} always means the member's field. A name that is both a field
   * and a column is refused by the validator, so this never has to guess.
   */
  private record MemberScope(
      Map<String, String[]> columns,
      Pool.Table table,
      int member,
      int row,
      /** The ROW columns the filter read, and what they held — see Pool.rowValuesDetail. */
      Map<String, String> read)
      implements Evaluate.Scope {

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
      String[] column = columns.get(name);
      String value = column == null || column[row] == null ? "" : column[row];
      if (column != null) {
        read.put(name, value);
      }
      return value;
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

  private static Map<String, String[]> buildColumns(
      Config config, int count, DataPacks packs, long nowMillis, Path baseDir) {
    return buildColumns(config, count, packs, nowMillis, baseDir, null);
  }

  /**
   * The same, with the pools already built handed in — which is how a POOL body is materialised,
   * so that one of its members can draw from a pool declared above it.
   */
  private static Map<String, String[]> buildColumns(
      Config config,
      int count,
      DataPacks packs,
      long nowMillis,
      Path baseDir,
      Map<String, Pool.Table> prebuilt) {
    // Before a single row exists: can the uniq groups cover `count` at all? The post-build check
    // asks the same question over the finished columns, which means reaching it costs the
    // allocation this refusal is meant to save.
    checkEnvUniqCapacity(config, count);

    Map<String, String[]> columns = new LinkedHashMap<>();
    // The REAL value behind a date column's text, for the columns some offset measures from.
    //
    // A date cell holds a PRESENTATION: `02/03/2026` in an en locale, `03.02.2026` in a ru one,
    // `March 2` under format="MMMM D". Reading a date back out of that is guesswork at best and
    // impossible at worst — the last form has thrown the year away. So the column that produced
    // it keeps what it actually generated, and an offset measures from THAT. Only the columns
    // named by some `of=` are kept, so a config with no offset in it pays nothing.
    Map<String, Long[]> instants = new LinkedHashMap<>();
    Set<String> wantsInstant = new java.util.LinkedHashSet<>();
    for (Config.SequenceSpec candidate : config.sequences()) {
      if (DateOffset.isOffset(candidate.gen())) {
        wantsInstant.add(DateOffset.sourceOf(candidate.gen().attrs()));
      }
    }

    // Row links are shared across the whole render: two sequences naming one key must land on
    // the same rows, whichever sequence reaches it first.
    Map<String, RowLinkPlan> rowLinks = new LinkedHashMap<>();

    // Built-ins first. They are positional, consume no randomness, and are therefore
    // identical for a given count no matter what else the config does.
    String[] counts = new String[count];
    String[] first = new String[count];
    String[] last = new String[count];
    String[] total = new String[count];
    for (int i = 0; i < count; i++) {
      counts[i] = String.valueOf(i + 1);
      first[i] = i == 0 ? "true" : "false";
      last[i] = i == count - 1 ? "true" : "false";
      total[i] = String.valueOf(count);
    }
    columns.put("_count", counts);
    columns.put("_first", first);
    columns.put("_last", last);
    columns.put("_total", total);

    Prng.Sfc32 prng = Prng.create(config.seed());

    // Pools first, and off a DERIVED seed. A pool must be invisible to every column it does not
    // feed: adding one leaves the ids, the ages and the names exactly where they were, so an old
    // snapshot still matches.
    Map<String, Pool.Table> tables =
        prebuilt != null ? prebuilt : buildPoolTables(config, packs, nowMillis, baseDir);

    // What each finished column's exact layout gave each row, by column name. A child that
    // filters on one of them is ordered by its RANK there, not by row order.
    Map<String, PerRow.ExactLayout> layouts = new LinkedHashMap<>();

    for (Config.SequenceSpec spec : config.sequences()) {
      boolean[] mask = parentMask(spec, columns, count);
      // In the order the column BUILDS them, which for a child is its rank inside the parent's
      // exact layout rather than plain row order.
      List<Integer> rows = PerRow.orderedRows(spec.parent(), mask, layouts);
      int applicable = rows.size();
      // A reference to a <pool>: this row gets one member, and every field of that member is
      // published under `Ref.field`. Resolved HERE, in declaration order, so a later
      // `<switch on="Doc.city">` finds the field already registered.
      if (spec.gen() != null && "pool".equals(spec.gen().type())) {
        poolReference(spec, columns, mask, count, tables, config.seed());
        continue;
      }

      // A running total down a column. Resolved HERE, in declaration order, so it reads a column
      // that already exists — which is also why `of=` must name a sequence declared above it.
      if (spec.gen() != null && "running".equals(spec.gen().type())) {
        runningColumn(spec, columns, count);
        continue;
      }
      // A statistic over the whole run. Resolved here for the same reason and by the same rule:
      // it reads a column that already exists, so `of=` has to name a sequence above it.
      // Arithmetic over the columns beside it. Resolved here for the same reason as the two
      // below: it reads columns that already exist, so every name in `expr=` has to be declared
      // above. Unlike them it needs only its OWN row, which is why it also streams.
      if (spec.gen() != null && "formula".equals(spec.gen().type())) {
        formulaColumn(
            spec,
            columns,
            count,
            config.mode() != null && "sequential".equals(config.mode().trim()));
        continue;
      }
      if (spec.gen() != null && "stat".equals(spec.gen().type())) {
        statColumn(spec, columns, count);
        continue;
      }
      // A date measured from another date, for the same reason and by the same rule: it reads a
      // column that already exists.
      if (DateOffset.isOffset(spec.gen())) {
        String of = DateOffset.sourceOf(spec.gen().attrs());
        String[] offsetSource = columns.get(of);
        if (offsetSource != null) {
          DateOffset.Column built =
              DateOffset.build(
                  spec.name(),
                  spec.gen().attrs(),
                  offsetSource,
                  instants.get(of),
                  count,
                  prng,
                  config.locale(),
                  wantsInstant.contains(spec.name()));
          columns.put(spec.name(), built.values());
          if (built.instants() != null) {
            instants.put(spec.name(), built.instants());
          }
        }
        continue;
      }
      if (spec.isComposed()) {
        // The body in declaration order — one pass, because the order the gens draw in is part of
        // the contract and taking the named ones first would shift every column after this one.
        String[] composed = new String[applicable];
        Arrays.fill(composed, "");
        Map<String, List<String>> built = new LinkedHashMap<>();

        // `uniq="true"` on a composed value. A concatenation is unique exactly when the join is
        // injective — true when ONE part is drawn and the rest are constants, because appending a
        // constant cannot make two different draws collide. Two drawn parts is the variable-width
        // trap and the validator refuses it (TDC220), so this stays null there.
        List<Config.Item> drawnParts =
            spec.items().stream()
                .filter(i -> i.gen() != null && i.field() == null)
                .toList();
        Config.Item uniqPart = spec.uniq() && drawnParts.size() == 1 ? drawnParts.get(0) : null;

        // Unnamed parts are numbered among ALL parts, literals included, because that is how the
        // streaming engine numbers them.
        int unnamed = 0;

        for (Config.Item item : spec.items()) {
          if (item.constantName() != null) {
            // A constant costs no draw at all — that is the whole reason it exists rather than a
            // one-value generator.
            List<String> constant = new ArrayList<>();
            for (int i = 0; i < applicable; i++) {
              constant.add(item.text() == null ? "" : item.text());
            }
            built.put(item.constantName(), constant);
            continue;
          }
          if (item.text() != null) {
            for (int i = 0; i < applicable; i++) {
              composed[i] += item.text();
            }
            continue;
          }
          Config.Gen gen = item.field() != null ? item.field().gen() : item.gen();
          String partId =
              item.field() != null
                  ? spec.name() + "." + item.field().name()
                  : spec.name() + "#p" + unnamed++;
          PerRow.Stream part = new PerRow.Stream(config.seed(), partId, rows);
          List<String> values;
          if (applicable == 0) {
            values = new ArrayList<>();
          } else if (item == uniqPart) {
            values =
                new ArrayList<>(
                    UniqSimple.build(
                        spec.name(), gen, applicable, prng, packs, config.locale(), baseDir));
          } else {
            values =
                new ArrayList<>(
                    columnValues(
                        gen, applicable, prng, packs, config, nowMillis, baseDir, rowLinks,
                        part, null, layouts, Siblings.of(columns)));
          }
          if (item.field() != null) {
            built.put(item.field().name(), values);
            continue;
          }
          for (int i = 0; i < applicable; i++) {
            composed[i] += values.get(i);
          }
        }

        if (applicable > 0 && spec.distinctGroups() != null) {
          // The groups name FIELDS, and a composed body carries its fields in `items` — so the
          // constraint is checked against a spec that spells them out.
          enforceDistinct(
              withFieldsOf(spec), built, applicable, prng, packs, config, nowMillis, baseDir,
              rowLinks, rows, false);
        }

        // Only when something unnamed actually composed it. A body of nothing but named items has
        // no value of its own, and ${{Name}} stays the literal marker that says you meant a field.
        if (composesOwnValue(spec.items())) {
          columns.put(spec.name(), spread(rows, Arrays.asList(composed), count));
        }
        for (Map.Entry<String, List<String>> entry : built.entrySet()) {
          columns.put(spec.name() + "." + entry.getKey(), spread(rows, entry.getValue(), count));
        }
        continue;
      }

      if (spec.isCompound()) {
        // Every field shares the parent mask and draws from the shared stream in declaration
        // order, which is what keeps a compound coherent: the city and the postcode of one
        // generated address belong to the same row, not to two independent ones.
        Map<String, List<String>> produced = new LinkedHashMap<>();
        for (Config.Field field : spec.fields()) {
          produced.put(
              field.name(),
              applicable == 0
                  ? new ArrayList<>()
                  : new ArrayList<>(
                      columnValues(
                          field.gen(), applicable, prng, packs, config, nowMillis, baseDir,
                          rowLinks,
                          new PerRow.Stream(
                              config.seed(), spec.name() + "." + field.name(), rows),
                          null,
                          layouts,
                          Siblings.of(columns))));
        }

        if (applicable > 0 && spec.distinctGroups() != null) {
          enforceDistinct(
              spec, produced, applicable, prng, packs, config, nowMillis, baseDir, rowLinks, rows,
              false);
        }
        if (applicable > 0 && spec.uniq()) {
          enforceUniqRedrawing(
              spec, produced, applicable, prng, packs, config, nowMillis, baseDir, rowLinks);
        }

        for (Config.Field field : spec.fields()) {
          columns.put(
              spec.name() + "." + field.name(),
              spread(rows, produced.get(field.name()), count));
        }
        continue;
      }

      if (spec.isMix()) {
        boolean[] flags = new boolean[applicable];
        List<String> produced =
            applicable == 0
                ? List.of()
                : mixValues(
                    spec.mix(), applicable, prng, packs, config, nowMillis, baseDir, rowLinks,
                    flags,
                    // The '#switch' suffix is a stable historical key: the streaming engine
                    // spells it that way so a <mix> keeps the values of the <switch> it replaced.
                    new PerRow.Stream(config.seed(), spec.name() + "#switch", rows), columns);
        columns.put(spec.name(), spread(rows, produced, count));

        String flagName = spec.mix().flag();
        if (flagName != null && !flagName.isBlank()) {
          List<String> labels = new ArrayList<>(applicable);
          for (boolean on : flags) {
            labels.add(String.valueOf(on));
          }
          columns.put(flagName, spread(rows, labels, count));
        }
        continue;
      }

      if (spec.isSwitch()) {
        columns.put(
            spec.name(),
            switchValues(
                spec.switchSpec(), count, prng, packs, config, nowMillis, baseDir, rowLinks,
                columns, spec.name(), layouts));
        continue;
      }

      if (spec.isMix()) {
        boolean[] flags = new boolean[applicable];
        List<String> produced =
            applicable == 0
                ? List.of()
                : mixValues(
                    spec.mix(), applicable, prng, packs, config, nowMillis, baseDir, rowLinks,
                    flags,
                    // The '#switch' suffix is a stable historical key: the streaming engine
                    // spells it that way so a <mix> keeps the values of the <switch> it replaced.
                    new PerRow.Stream(config.seed(), spec.name() + "#switch", rows), columns);
        columns.put(spec.name(), spread(rows, produced, count));

        String flagName = spec.mix().flag();
        if (flagName != null && !flagName.isBlank()) {
          // The ground-truth companion: which rows took a case declared anomalous. It shares
          // the parent mask, so the label is absent exactly where the value is.
          List<String> labels = new ArrayList<>(applicable);
          for (boolean on : flags) {
            labels.add(String.valueOf(on));
          }
          columns.put(flagName, spread(rows, labels, count));
        }
        continue;
      }

      if (spec.isSwitch()) {
        columns.put(
            spec.name(),
            switchValues(
                spec.switchSpec(), count, prng, packs, config, nowMillis, baseDir, rowLinks,
                columns, spec.name(), layouts));
        continue;
      }

      if (spec.isComputed()) {
        // Derived, not drawn: no PRNG at all. A check digit is a function of the values already
        // in the row, so it takes nothing from the stream and adding one shifts nothing.
        String[] values = new String[count];
        for (int i = 0; i < count; i++) {
          final int row = i;
          values[i] =
              Compute.evaluate(
                  (TDCParser.OpenCloseElementContext) spec.compute(),
                  name -> {
                    String[] column = columns.get(name);
                    return column == null ? null : column[row];
                  });
        }
        columns.put(spec.name(), values);
        continue;
      }

      if (spec.isConditional()) {
        // Over every row, and without the parent mask — matching the reference. A conditional
        // already says which rows it applies to through its own conditions, so `parent=` on one
        // has nothing left to decide.
        columns.put(
            spec.name(),
            conditional(spec, count, prng, packs, config, nowMillis, baseDir, rowLinks, columns)
                .toArray(new String[0]));
        continue;
      }

      // `common.vehicle.model.${{Brand}}` — the pack to draw from is decided by another
      // column, so the address is not known until the row is. Built here rather than in the
      // generator, because this is the only place the sibling columns exist.
      if ("template".equals(spec.gen().type()) && spec.gen().attr("value", "").contains("${{")) {
        columns.put(
            spec.name(),
            spread(
                rows,
                dynamicTemplate(spec.gen(), mask, columns, prng, packs, config, nowMillis, baseDir),
                count));
        continue;
      }

      // A single column cannot be both proportional and unique, so — unlike the
      // compound path, which only rearranges — uniq changes the draw: without
      // replacement, one PRNG draw per pick (UniqSimple).
      if (spec.uniq()
          && !"increment".equals(spec.gen().type())
          && !"decrement".equals(spec.gen().type())) {
        List<String> unique =
            applicable == 0
                ? List.of()
                : UniqSimple.build(
                    spec.name(), spec.gen(), applicable, prng, packs, config.locale(), baseDir);
        columns.put(spec.name(), spread(rows, unique, count));
        continue;
      }

      boolean[] anomalyFlags = new boolean[applicable];
      Repeat.Spec repeat = Repeat.parse(spec.gen().attrs());
      PerRow.Stream stream = new PerRow.Stream(config.seed(), spec.name(), rows);
      String flagName = spec.gen().attrs().get("anomaly_flag");
      boolean flagNamed = flagName != null && !flagName.isBlank();

      // With `repeat` the anomaly label is a LIST parallel to the values, saying which ELEMENT
      // spiked rather than merely that one did.
      List<String> repeatFlags = null;
      List<String> produced;
      if (applicable == 0) {
        produced = List.of();
      } else if (repeat != null) {
        // A listed column lays every element of every row out at once and reads the slots the
        // length plan gave the row; anything drawn takes one sub-stream per element. Which of
        // the two is the streaming engine's own split.
        Listed listed = listedValues(spec.gen(), packs, config, baseDir);
        if (listed != null) {
          produced =
              RepeatKeyed.buildLayout(
                  repeat,
                  listed.values(),
                  listed.percents(),
                  applicable,
                  stream,
                  elementModifier(spec.gen(), repeat, stream));
        } else {
          Config.Gen element =
              new Config.Gen(spec.gen().type(), Repeat.without(spec.gen().attrs()));
          repeatFlags = flagNamed ? new ArrayList<>() : null;
          produced =
              RepeatKeyed.buildDraws(
                  repeat,
                  applicable,
                  stream,
                  spec.gen().type(),
                  (k, elementPrng, flag) -> {
                    List<String> done =
                        finish(
                            generate(
                                element, 1, elementPrng, packs, config, nowMillis, baseDir,
                                rowLinks),
                            element.attrs(),
                            elementPrng,
                            flag);
                    return done.isEmpty() ? "" : done.get(0);
                  },
                  repeatFlags);
        }
      } else {
        // A column some `<gen type="date" of="…">` measures from keeps the instant it generated
        // beside the text it renders. Nothing else asks, so nothing else allocates.
        List<Long> collected =
            "date".equals(spec.gen().type()) && wantsInstant.contains(spec.name())
                ? new ArrayList<>(applicable)
                : null;
        produced =
            columnValues(
                spec.gen(), applicable, prng, packs, config, nowMillis, baseDir, rowLinks,
                stream, anomalyFlags, layouts, collected, Siblings.of(columns));
        // Attach the instants only if the build actually filled them for every row. A sink that
        // was asked for and left empty is NOT "this column has no date on any row" — it is "this
        // build never wrote one", and the two answers are opposite. Refusing to attach gives the
        // text reading, which either works or names the problem out loud.
        if (collected != null && collected.size() == applicable) {
          // Laid over the real rows exactly as the values are: a filtered column builds compacted
          // and is spread afterwards, so the two must be spread the same way or an offset would
          // measure row 3 from row 1's date.
          Long[] over = new Long[count];
          for (int at = 0; at < rows.size(); at++) {
            over[rows.get(at)] = at < collected.size() ? collected.get(at) : null;
          }
          instants.put(spec.name(), over);
        }
      }
      columns.put(spec.name(), spread(rows, produced, count));

      if (flagNamed) {
        // The ground-truth companion: which rows the run chose to spike. It shares the parent
        // mask, so the label is absent on exactly the rows the value is absent from — a
        // detector trained on this cannot learn from a label the data never had.
        List<String> flags;
        if (repeatFlags != null) {
          flags = repeatFlags;
        } else {
          flags = new ArrayList<>(applicable);
          for (boolean on : anomalyFlags) {
            flags.add(String.valueOf(on));
          }
        }
        columns.put(flagName, spread(rows, flags, count));
      }
    }
    enforceEnvDistinct(config, columns, count, prng, packs, nowMillis, baseDir);
    enforceEnvUniq(config, columns, count);
    resolveHttp(config, columns, count, baseDir);
    return columns;
  }

  /**
   * Env-level {@code <distinct>}: the wrapped sequences differ from each other on every row.
   *
   * <p>Same idea as {@code <distinct>} inside one compound, one level up. A colliding sequence
   * redraws until it differs, which is cheap because a collision is rare and the alternative —
   * planning the whole group together — would tie sequences that are otherwise independent.
   */
  private static void enforceEnvDistinct(
      Config config,
      Map<String, String[]> columns,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      long nowMillis,
      Path baseDir) {
    Map<String, Config.SequenceSpec> byName = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }

    for (List<String> group : config.envDistinctGroups()) {
      List<String> members = scalarMembers(group, byName, columns);
      if (members.size() < 2) {
        continue;
      }
      for (int i = 0; i < count; i++) {
        Set<String> seen = new java.util.LinkedHashSet<>();
        for (String name : members) {
          String[] values = columns.get(name);
          String value = values[i];
          if (value == null) {
            continue; // a row this sequence does not apply to
          }
          int attempts = 0;
          while (seen.contains(value)) {
            if (attempts >= DISTINCT_FUSE) {
              throw new IllegalStateException(
                  "<distinct> across sequences: could not find a value for sequence \""
                      + name
                      + "\" different from the others after "
                      + DISTINCT_FUSE
                      + " attempts — its source likely has too few distinct values.");
            }
            attempts++;
            // Named for the sequence and the attempt, exactly as the streaming engine names it,
            // so the replacement is the same value on both engines.
            Prng.Sfc32 one = Seekable.generator(config.seed(), name + "#ed" + attempts, i);
            value = oneScalar(byName.get(name), one, packs, config, nowMillis, baseDir, columns, i);
          }
          values[i] = value;
          seen.add(value);
        }
      }
    }
  }

  /**
   * Env-level {@code <uniq>}: the tuple of the wrapped sequences is unique across the run.
   *
   * <p>The values are already drawn, so this rearranges rather than redraws — each column keeps
   * the multiset it produced and only the pairings change. That is what keeps a weighted member's
   * proportions intact while the combinations become distinct.
   */
  private static void enforceEnvUniq(Config config, Map<String, String[]> columns, int count) {
    Map<String, Config.SequenceSpec> byName = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }

    for (List<String> group : config.envUniqGroups()) {
      List<String> members = scalarMembers(group, byName, columns);
      if (members.size() < 2) {
        continue;
      }
      // Only the rows where every member has a value: a row one member skips has no tuple to
      // make unique, and forcing one would invent a value the config never asked for.
      List<Integer> rows = new ArrayList<>();
      for (int i = 0; i < count; i++) {
        boolean complete = true;
        for (String name : members) {
          if (columns.get(name)[i] == null) {
            complete = false;
            break;
          }
        }
        if (complete) {
          rows.add(i);
        }
      }
      if (rows.isEmpty()) {
        continue;
      }

      String label = String.join(" × ", members);
      Map<Integer, List<String>> byRow = new LinkedHashMap<>();

      for (List<Integer> block : partitionRows(rows, subjectsOf(members, byName), columns)) {
        List<List<String>> grid = new ArrayList<>();
        List<List<Integer>> counts = new ArrayList<>();
        for (String name : members) {
          List<String> column = new ArrayList<>(block.size());
          for (int row : block) {
            column.add(columns.get(name)[row]);
          }
          grid.add(column);
          counts.add(Uniq.valueCounts(column));
        }

        int upper = Uniq.upperBound(counts);
        if (block.size() > upper) {
          throw new IllegalStateException(uniqGroupMessage(label, rows.size(), upper));
        }
        Uniq.Arrangement arranged = Uniq.arrange(grid);
        if (arranged.distinct() < block.size()) {
          throw new IllegalStateException(
              uniqGroupMessage(label, rows.size(), arranged.distinct()));
        }
        for (int k = 0; k < block.size(); k++) {
          List<String> tuple = new ArrayList<>(members.size());
          for (int m = 0; m < members.size(); m++) {
            tuple.add(arranged.columns().get(m).get(k));
          }
          byRow.put(block.get(k), tuple);
        }
      }

      // Blocks are made unique on their own; two of them could still meet on the same tuple when
      // the subjects share a value (a name in both lists). Rare, but silence here would be a
      // broken promise, so it is counted and refused.
      Set<List<String>> seen = new HashSet<>();
      for (int row : rows) {
        seen.add(byRow.get(row));
      }
      if (seen.size() < rows.size()) {
        throw new IllegalStateException(uniqGroupMessage(label, rows.size(), seen.size()));
      }

      for (int m = 0; m < members.size(); m++) {
        String[] values = columns.get(members.get(m));
        for (int row : rows) {
          values[row] = byRow.get(row).get(m);
        }
      }
    }
  }

  /** The most distinct values this spec can produce, or null when unknowable. */
  private static Long staticCapacity(Config.SequenceSpec spec) {
    Config.Gen gen = spec.gen();
    if (gen == null) {
      return null; // a mix, a switch, a compound — not bounded here
    }
    // `repeat=` makes the cell a LIST of draws, whose distinct combinations are a different and
    // larger count than one draw's. Not bounded here.
    if (gen.attrs().get("repeat") != null) {
      return null;
    }

    if ("text".equals(gen.type())) {
      String raw = gen.attrs().get("value");
      if (raw == null) {
        return null;
      }
      Set<String> items = new java.util.LinkedHashSet<>();
      for (String part : raw.split(",", -1)) {
        items.add(part.trim());
      }
      return (long) items.size();
    }

    if ("number".equals(gen.type())) {
      // A decimal range holds far more than its integer span, and `distribution=` draws a real
      // number: neither is the count of whole numbers between the bounds.
      if (gen.attrs().get("decimals") != null || gen.attrs().get("distribution") != null) {
        return null;
      }
      String source = gen.attrs().getOrDefault("value", gen.attrs().getOrDefault("range", ""));
      source = source.trim();
      if (source.isEmpty()) {
        return null;
      }
      try {
        long total = 0;
        for (NumberGen.Range range : NumberGen.parseRanges(source)) {
          total += range.max() - range.min() + 1;
        }
        return total > 0 ? total : null;
      } catch (RuntimeException e) {
        // A range this cannot read is the validator's to report, not this check's.
        return null;
      }
    }

    return null;
  }

  /**
   * Can each {@code <uniq>} group cover {@code count} at all — asked before a single row is built.
   *
   * <p>The group already had this check, and its message is the right one. But it ran over the
   * FINISHED columns, so reaching it meant materialising them first: two lists of ten values and
   * {@code count="1000000000"} died in the allocator instead, exactly where the warning is worth
   * most, because the alternative is a long run that was never going to succeed.
   *
   * <p>A member whose capacity is not knowable from its spec makes the group unbounded, and then
   * this says nothing and the post-build check does its work as before. A refusal here is a PROOF,
   * never a guess: no config that could have worked is turned away.
   */
  public static void checkEnvUniqCapacity(Config config, int count) {
    Map<String, Config.SequenceSpec> byName = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }

    for (List<String> group : config.envUniqGroups()) {
      List<Config.SequenceSpec> members = new ArrayList<>();
      for (String name : group) {
        Config.SequenceSpec spec = byName.get(name);
        if (spec != null && (spec.gen() != null || spec.isMix() || spec.isSwitch())) {
          members.add(spec);
        }
      }
      if (members.size() < 2) {
        continue;
      }
      // A parent filter means fewer rows carry the tuple than `count`, and the exact number is not
      // known until the parent is built.
      boolean filtered = false;
      for (Config.SequenceSpec spec : members) {
        if (spec.parent() != null && !spec.parent().isBlank()) {
          filtered = true;
          break;
        }
      }
      if (filtered) {
        continue;
      }

      double ceiling = 1;
      for (Config.SequenceSpec spec : members) {
        Long capacity = staticCapacity(spec);
        if (capacity == null) {
          ceiling = Double.POSITIVE_INFINITY;
          break;
        }
        ceiling *= capacity;
        if (ceiling >= count) {
          break;
        }
      }

      if (count > ceiling) {
        throw new IllegalStateException(
            uniqGroupMessage(String.join(" × ", group), count, (int) ceiling));
      }
    }
  }

  private static String uniqGroupMessage(String label, int need, int available) {
    return "uniq: group \""
        + label
        + "\" cannot produce "
        + need
        + " unique combinations — the values drawn for these sequences allow at most "
        + available
        + " distinct rows. Add more values to a member (more distinct names, wider ranges…) "
        + "or lower the count.";
  }

  /**
   * The subjects the group's {@code <switch>} members are keyed by, in order, without repeats.
   *
   * <p>Empty when no member is a switch, which is the ordinary case and leaves the behaviour
   * exactly as it was.
   */
  private static List<String> subjectsOf(
      List<String> members, Map<String, Config.SequenceSpec> byName) {
    List<String> subjects = new ArrayList<>();
    for (String name : members) {
      Config.SequenceSpec spec = byName.get(name);
      if (spec != null && spec.switchSpec() != null && !subjects.contains(spec.switchSpec().on())) {
        subjects.add(spec.switchSpec().on());
      }
    }
    return subjects;
  }

  /**
   * Split the rows into blocks that may be shuffled among themselves.
   *
   * <p>With no switch member there is one block holding every row — the old behaviour, bit for
   * bit. With one, rows are grouped by the value of its subject, so male rows only ever trade with
   * male rows: a switch's value answers the subject of ITS row.
   */
  private static List<List<Integer>> partitionRows(
      List<Integer> rows, List<String> subjects, Map<String, String[]> columns) {
    if (subjects.isEmpty()) {
      return List.of(rows);
    }
    Map<List<String>, List<Integer>> blocks = new LinkedHashMap<>();
    for (int row : rows) {
      List<String> key = new ArrayList<>(subjects.size());
      for (String subject : subjects) {
        String[] column = columns.get(subject);
        key.add(column == null ? "" : String.valueOf(column[row]));
      }
      blocks.computeIfAbsent(key, k -> new ArrayList<>()).add(row);
    }
    return new ArrayList<>(blocks.values());
  }

  /** The members of a group that are single-valued sequences and were actually built. */
  private static List<String> scalarMembers(
      List<String> group,
      Map<String, Config.SequenceSpec> byName,
      Map<String, String[]> columns) {
    List<String> out = new ArrayList<>();
    for (String name : group) {
      Config.SequenceSpec spec = byName.get(name);
      boolean scalar = spec != null && (spec.gen() != null || spec.isMix() || spec.isSwitch());
      if (scalar && columns.containsKey(name)) {
        out.add(name);
      }
    }
    return out;
  }

  /** One fresh value from a sequence — what a {@code <distinct>} collision redraws. */
  /**
   * One fresh value from a sequence — what a {@code <distinct>} collision redraws.
   *
   * <p>A switch needs the ROW, which the other two do not: its branch is chosen by the subject
   * column's value on that row, so a redraw has to land in the branch the original did — a
   * {@code <case is="p">} row must come back with another p value. Without the row this returned
   * the empty string, which the caller then accepted as "different from the others" and wrote
   * into the cell: colliding rows came out BLANK, with no diagnostic, from a config the docs
   * describe as supported.
   */
  private static String oneScalar(
      Config.SequenceSpec spec,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, String[]> columns,
      int row) {
    if (spec.gen() != null) {
      List<String> built =
          finish(
              generate(spec.gen(), 1, prng, packs, config, nowMillis, baseDir, new LinkedHashMap<>()),
              spec.gen().attrs(),
              prng,
              new boolean[1]);
      return built.isEmpty() ? "" : built.get(0);
    }
    if (spec.isMix()) {
      List<String> built =
          mixValues(
              spec.mix(), 1, prng, packs, config, nowMillis, baseDir, new LinkedHashMap<>(),
              new boolean[1], null, Map.of());
      return built.isEmpty() ? "" : built.get(0);
    }
    if (spec.isSwitch()) {
      // The FIRST entry whose keys hold the subject's value, else <default>, else empty — the
      // precedence switchValues builds the whole column with.
      Config.Switch sw = spec.switchSpec();
      String[] subject = columns.get(sw.on());
      String key = subject != null && row < subject.length && subject[row] != null
          ? subject[row]
          : "";
      Config.Case chosen = null;
      for (Config.SwitchEntry entry : sw.entries()) {
        if (entry.keys().contains(key)) {
          chosen = entry.value();
          break;
        }
      }
      if (chosen == null) {
        chosen = sw.fallback();
      }
      if (chosen == null) {
        return "";
      }
      List<String> built =
          caseValues(
              chosen, 1, prng, packs, config, nowMillis, baseDir, Map.of(), null, columns);
      return built.isEmpty() ? "" : built.get(0);
    }
    return "";
  }


  /** How many redraws a {@code <distinct>} field gets before its source is called too small. */
  private static final int DISTINCT_FUSE = 100;

  /**
   * {@code <distinct>} — fields inside one group must differ from each other within a row.
   *
   * <p>Redraw on collision, field by field, in declaration order. A person's city of birth and
   * city of residence come from the same list and are usually different; without this they
   * coincide about as often as the list is short.
   *
   * <p>Redrawing appends to the stream, so the result stays deterministic. The fuse is there
   * because a one-value list can never satisfy two fields, and spinning forever would say far
   * less than naming the problem.
   *
   * <p>{@code sharedPrng} is for a PACK BODY, which is a nested build with no seed of its own:
   * there is nothing to key a repair stream by, so the replacement comes off the prng the body was
   * handed. The reference draws exactly this distinction, and a Spanish or Portuguese full name —
   * two given names and two surnames, each pair {@code <distinct>} — is where it shows.
   */
  private static void enforceDistinct(
      Config.SequenceSpec spec,
      Map<String, List<String>> produced,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      List<Integer> rows,
      boolean sharedPrng) {
    Map<String, Config.Gen> genByField = new LinkedHashMap<>();
    for (Config.Field field : spec.fields()) {
      genByField.put(field.name(), field.gen());
    }

    for (List<String> group : spec.distinctGroups()) {
      List<String> fields = new ArrayList<>();
      for (String name : group) {
        if (produced.containsKey(name) && genByField.containsKey(name)) {
          fields.add(name);
        }
      }
      if (fields.size() < 2) {
        continue;
      }

      for (int i = 0; i < count; i++) {
        Set<String> seen = new java.util.HashSet<>();
        for (String fieldName : fields) {
          List<String> values = produced.get(fieldName);
          Config.Gen gen = genByField.get(fieldName);
          String value = values.get(i);
          int attempts = 0;
          while (seen.contains(value)) {
            if (attempts >= DISTINCT_FUSE) {
              throw new IllegalStateException(
                  "<distinct> in sequence \""
                      + spec.name()
                      + "\": could not find a value for field \""
                      + fieldName
                      + "\" different from the others after "
                      + DISTINCT_FUSE
                      + " attempts — its source likely has too few distinct values.");
            }
            attempts++;
            // Each attempt has a stream of its own, named for the field and the attempt number —
            // the same names the streaming engine redraws under, so both engines land on the
            // same replacement.
            int row = i < rows.size() ? rows.get(i) : i;
            Prng.Sfc32 one =
                sharedPrng
                    ? prng
                    : Seekable.generator(
                        config.seed(), spec.name() + "." + fieldName + "#d" + attempts, row);
            value = generate(gen, 1, one, packs, config, nowMillis, baseDir, rowLinks).get(0);
          }
          values.set(i, value);
          seen.add(value);
        }
      }
    }
  }

  /**
   * {@code uniq="true"} — no two rows carry the same tuple.
   *
   * <p>The values are only rearranged, never replaced, so a declared {@code percent=} share
   * comes through untouched. Uniqueness and an exact distribution are not a trade here.
   *
   * <p>Checked before any output: a cheap upper bound first, then the builder's own answer. A
   * config that cannot produce the requested number of distinct rows says so, with the number it
   * could reach, rather than quietly emitting duplicates.
   */
  /** How many independent redraws before a config is declared genuinely impossible. */
  private static final int UNIQ_REDRAW_ATTEMPTS = 8;

  /** Thrown by the arranger alone, so the retry below can tell it from a real failure. */
  private static final class UniqInfeasible extends RuntimeException {

    private static final long serialVersionUID = 1L;
    final int achievable;

    UniqInfeasible(int achievable) {
      super("uniq is infeasible");
      this.achievable = achievable;
    }
  }

  private static void arrangeUnique(
      Config.SequenceSpec spec, Map<String, List<String>> produced, int count) {
    List<List<String>> columns = new ArrayList<>();
    for (Config.Field field : spec.fields()) {
      columns.add(produced.get(field.name()));
    }

    // Already unique as drawn? Then there is nothing to rearrange, and moving values anyway would
    // only make this engine disagree with the exact one, which checks the same thing first and
    // leaves a passing draw untouched. Cheap enough to always ask: one pass, one set. NUL joins
    // the tuple because a generated value cannot contain it, so no two different tuples can join
    // into the same key.
    Set<String> seenTuples = new java.util.HashSet<>();
    boolean collided = false;
    for (int i = 0; i < count && !collided; i++) {
      StringBuilder key = new StringBuilder();
      for (List<String> column : columns) {
        key.append(i < column.size() ? column.get(i) : "").append('\0');
      }
      collided = !seenTuples.add(key.toString());
    }
    if (!collided) {
      return;
    }

    List<List<Integer>> columnCounts = new ArrayList<>();
    for (List<String> column : columns) {
      columnCounts.add(Uniq.valueCounts(column));
    }

    // The cheap bound first: it cannot be reached, so there is no point building anything.
    int upper = Uniq.upperBound(columnCounts);
    if (count > upper) {
      throw new UniqInfeasible(upper);
    }

    Uniq.Arrangement arranged = Uniq.arrange(columns);
    if (arranged.distinct() < count) {
      throw new UniqInfeasible(arranged.distinct());
    }
    for (int i = 0; i < spec.fields().size(); i++) {
      produced.put(spec.fields().get(i).name(), arranged.columns().get(i));
    }
  }

  /**
   * {@code uniq="true"}, and a fresh draw when the first one happened to be unarrangeable.
   *
   * <p>The arranger may only rearrange what was drawn — that is what keeps {@code percent=}
   * exact. But when nothing pins the proportions, a lopsided draw is an accident of sampling
   * rather than something to protect, and refusing the whole run over it blames the value lists
   * for a problem they do not have:
   *
   * <pre>{@code
   * 4 values x 8 values, count=20   ->  32 combinations exist
   * drawn: a1x7 a2x6 a3x3 a4x4      ->  "its data supports at most 19"
   * }</pre>
   *
   * <p>So it draws again. This runs only where the previous behaviour threw, so no config that
   * works today shifts by a byte — a successful run consumes exactly the draws it always did.
   *
   * <p>When the columns come from an exact quota, a redraw returns the same multiset in a
   * different order and cannot help. That is detected after one attempt and reported as what it
   * is, rather than retried seven more times for nothing.
   */
  private static void enforceUniqRedrawing(
      Config.SequenceSpec spec,
      Map<String, List<String>> produced,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks) {
    try {
      arrangeUnique(spec, produced, count);
      return;
    } catch (UniqInfeasible ignored) {
      // Fall through to the redraw.
    }

    String firstSignature = uniqSignature(spec, produced);
    int best = 0;
    for (int attempt = 0; attempt < UNIQ_REDRAW_ATTEMPTS; attempt++) {
      for (Config.Field field : spec.fields()) {
        produced.put(
            field.name(),
            new ArrayList<>(
                finish(
                    generate(field.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks),
                    field.gen().attrs(),
                    prng,
                    new boolean[count])));
      }
      // The same value frequencies mean the draw is quota-fixed: every further attempt would
      // produce this multiset again.
      boolean quotaFixed = attempt == 0 && uniqSignature(spec, produced).equals(firstSignature);
      try {
        arrangeUnique(spec, produced, count);
        return;
      } catch (UniqInfeasible e) {
        best = Math.max(best, e.achievable);
        if (quotaFixed) {
          throw new IllegalStateException(uniqQuotaMessage(spec.name(), count, e.achievable));
        }
      }
    }
    throw new IllegalStateException(uniqRedrawnMessage(spec.name(), count, best));
  }

  /** Per field, its value frequencies sorted — what changes when a draw is not quota-fixed. */
  private static String uniqSignature(Config.SequenceSpec spec, Map<String, List<String>> produced) {
    List<String> parts = new ArrayList<>();
    for (Config.Field field : spec.fields()) {
      List<Integer> counts = new ArrayList<>(Uniq.valueCounts(produced.get(field.name())));
      counts.sort(null);
      StringBuilder b = new StringBuilder();
      for (int i = 0; i < counts.size(); i++) {
        if (i > 0) {
          b.append(',');
        }
        b.append(counts.get(i));
      }
      parts.add(b.toString());
    }
    return String.join("|", parts);
  }

  /** The proportions are the config's requirement, so the draw is not the engine's to change. */
  private static String uniqQuotaMessage(String name, int requested, int achievable) {
    return "uniq: sequence \""
        + name
        + "\" cannot produce "
        + requested
        + " unique combinations. Its values are drawn to an exact share (percent=, or a weighted"
        + " pack), so their proportions are fixed by the config, and those proportions allow at"
        + " most "
        + achievable
        + " distinct rows. Add more values to a field (more distinct names, wider ranges…),"
        + " relax the share, or lower the count.";
  }

  /** Nothing pinned the draw, and redrawing still could not get there. */
  private static String uniqRedrawnMessage(String name, int requested, int achievable) {
    return "uniq: sequence \""
        + name
        + "\" cannot produce "
        + requested
        + " unique combinations — "
        + UNIQ_REDRAW_ATTEMPTS
        + " independent draws each topped out around "
        + achievable
        + " distinct rows. Its fields do not hold enough distinct values between them. Add more"
        + " values to a field (more distinct names, wider ranges…) or lower the count.";
  }

  /**
   * A mix: the cases are apportioned exactly over the rows, then each case fills its own.
   *
   * <p>Grouping the rows by case before generating is what makes a nested mix mean what it
   * says. The inner percentages then apply to the subset the outer case selected, so "20% of
   * the readings are faulty, and half of those are out of range" comes out as ten per cent of
   * everything rather than as two independent coin flips.
   */
  private static List<String> mixValues(
      Config.Mix mix,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      boolean[] flags,
      PerRow.Stream stream,
      Map<String, String[]> columns) {
    List<Config.Case> cases = mix.cases();
    if (cases.isEmpty()) {
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        out.add("");
      }
      return out;
    }

    double[] percents;
    if (mix.percent() == null || mix.percent().isBlank()) {
      percents = new double[cases.size()];
      Arrays.fill(percents, 100.0 / cases.size());
    } else {
      percents = PercentMask.expand(mix.percent(), cases.size());
    }

    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add("");
    }

    // An inline mix inside a pack generator body has nothing to key by, so the older arrangement
    // stands there.
    if (stream == null) {
      List<Integer> indexes = new ArrayList<>(cases.size());
      for (int i = 0; i < cases.size(); i++) {
        indexes.add(i);
      }
      List<Integer> selected = Hamilton.distribute(count, indexes, percents, prng);
      if (flags != null) {
        for (int i = 0; i < count; i++) {
          flags[i] = cases.get(selected.get(i)).anomaly();
        }
      }
      for (int c = 0; c < cases.size(); c++) {
        List<Integer> taken = new ArrayList<>();
        for (int i = 0; i < count; i++) {
          if (selected.get(i) == c) {
            taken.add(i);
          }
        }
        if (taken.isEmpty()) {
          continue;
        }
        List<String> values =
            caseValues(
                cases.get(c), taken.size(), prng, packs, config, nowMillis, baseDir, rowLinks,
                null, columns);
        for (int i = 0; i < taken.size(); i++) {
          out.set(taken.get(i), values.get(i));
        }
      }
      return out;
    }

    // Which case a row takes is the same exact layout a weighted list gets: a quota per case,
    // permuted over the rows. So the choice follows from the row alone, and the shares still come
    // out to the digit over the whole run.
    int[] counts =
        Hamilton.countsPerValue(
            count, percents, Prng.create(stream.seed() + "|" + stream.id() + "|pct"));
    int layoutKey = Permute.key(stream.seed(), stream.id());

    // Case c owns slots [cumLo[c], cumLo[c] + counts[c]).
    int[] cumLo = new int[counts.length];
    int acc = 0;
    for (int c = 0; c < counts.length; c++) {
      cumLo[c] = acc;
      acc += counts[c];
    }

    // The permutation both ways. The streaming engine asks "which slot is this row?"; building a
    // case's body needs the reverse, "which row holds slot s?".
    int[] slotOf = new int[count];
    int[] positionOfSlot = new int[count];
    for (int i = 0; i < count; i++) {
      int slot = Permute.permute(i, count, layoutKey);
      slotOf[i] = slot;
      positionOfSlot[slot] = i;
    }

    for (int c = 0; c < cases.size(); c++) {
      int quota = counts[c];
      if (quota == 0) {
        continue;
      }
      int[] positions = new int[quota];
      List<Integer> caseRows = new ArrayList<>(quota);
      for (int local = 0; local < quota; local++) {
        positions[local] = positionOfSlot[cumLo[c] + local];
        caseRows.add(stream.rowAt(positions[local]));
      }
      List<String> values =
          caseValues(
              cases.get(c), quota, prng, packs, config, nowMillis, baseDir, rowLinks,
              new PerRow.Stream(stream.seed(), stream.id() + "#c" + c, caseRows), columns);
      for (int local = 0; local < quota; local++) {
        out.set(positions[local], values.get(local));
      }
    }

    if (flags != null) {
      // The label reads the same slot-to-case mapping the value did, so the two cannot disagree
      // on a row — which is the whole point of a ground-truth column.
      for (int i = 0; i < count; i++) {
        flags[i] = cases.get(caseOfSlot(counts, cumLo, slotOf[i])).anomaly();
      }
    }
    return out;
  }

  /** Which case owns a slot, read off the same cumulative quotas the values were placed by. */
  private static int caseOfSlot(int[] counts, int[] cumLo, int slot) {
    for (int c = 0; c < counts.length; c++) {
      if (slot < cumLo[c] + counts[c]) {
        return c;
      }
    }
    return counts.length - 1;
  }

  /** A case body: its pieces concatenated, each built for the rows that chose this case. */
  private static List<String> caseValues(
      Config.Case caseSpec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      PerRow.Stream stream,
      Map<String, String[]> columns) {
    List<StringBuilder> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add(new StringBuilder());
    }
    // Parts are numbered among ALL of them, literals included: the streaming engine numbers them
    // off the same list, and a different count here would key the same part under a different
    // name.
    for (int p = 0; p < caseSpec.parts().size(); p++) {
      Config.CasePart part = caseSpec.parts().get(p);
      PerRow.Stream sub = stream == null ? null : stream.named(stream.id() + "#p" + p);
      List<String> values;
      if (part.text() != null) {
        values = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
          values.add(part.text());
        }
      } else if (part.gen() != null) {
        values =
            columnValues(
                part.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks, sub, null,
                null, columns == null ? null : Siblings.of(columns));
      } else if (part.mix() != null) {
        values =
            mixValues(
                part.mix(), count, prng, packs, config, nowMillis, baseDir, rowLinks, null, sub,
                columns);
      } else {
        values =
            nestedSwitchValues(
                part.switchSpec(), count, prng, packs, config, nowMillis, baseDir, rowLinks, sub,
                columns);
      }
      for (int i = 0; i < count; i++) {
        out.get(i).append(values.get(i));
      }
    }
    List<String> text = new ArrayList<>(count);
    for (StringBuilder b : out) {
      text.add(b.toString());
    }
    return text;
  }

  /**
   * A switch: look the subject's value up in the table.
   *
   * <p>An entry is built over THE ROWS THAT CHOSE IT, exactly as a mix builds a case over the
   * rows it won. Every entry used to be built over the whole run and the values that landed on
   * rows belonging to another branch were dropped, so a {@code <mix percent="20,80">} inside
   * {@code <case is="Male">} apportioned its 20% across all the rows rather than across the men.
   * Measured over 100 runs of 10 rows split 5/5: 0, 1 or 2 survivors, and 23 runs with none at
   * all, where the config plainly asked for one man in five.
   *
   * <p>A row with no match and no default is empty — which is a value, not a failure: a country
   * with no currency listed simply has none here.
   */
  private static String[] switchValues(
      Config.Switch spec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String[]> columns,
      String name,
      Map<String, PerRow.ExactLayout> layouts) {
    // Group the rows by branch BEFORE generating: the subject's whole column is already here.
    String[] subject = columns.get(spec.on());
    List<List<Integer>> entryRows = new ArrayList<>(spec.entries().size());
    for (int e = 0; e < spec.entries().size(); e++) {
      entryRows.add(new ArrayList<>());
    }
    List<Integer> fallbackRows = new ArrayList<>();
    for (int i = 0; i < count; i++) {
      String key = subject == null || subject[i] == null ? "" : subject[i];
      int picked = -1;
      for (int e = 0; e < spec.entries().size(); e++) {
        if (spec.entries().get(e).keys().contains(key)) {
          picked = e;
          break;
        }
      }
      (picked < 0 ? fallbackRows : entryRows.get(picked)).add(i);
    }

    String[] out = new String[count];
    for (int e = 0; e < spec.entries().size(); e++) {
      Config.SwitchEntry entry = spec.entries().get(e);
      place(
          entry.value(), entryRows.get(e),
          rankedBranchRows(spec.on(), entry.keys(), entryRows.get(e), layouts),
          name + "#sw" + e, count, prng, packs, config, nowMillis, baseDir, rowLinks, out,
          columns);
    }
    if (spec.fallback() != null) {
      // <default> holds the rows no entry matched — a complement, which no layout enumerates.
      place(
          spec.fallback(), fallbackRows, null, name + "#swdef", count, prng, packs, config,
          nowMillis, baseDir, rowLinks, out, columns);
    }
    return out;
  }

  /**
   * A {@code <switch>} written inside a {@code <case>} — the nested form.
   *
   * <p>It looks its subject up over THE ROWS OF THE BRANCH IT SITS IN. {@code stream} already
   * carries those rows and this part's name, so position {@code i} here is the same cell the
   * streaming engine resolves at the absolute row.
   *
   * <p>A branch of a nested switch is never RANKED: its rows are an intersection of two
   * partitions — the enclosing branch's and the inner subject's — and the streaming engines
   * cannot number an intersection one row at a time. A branch that declares a share is refused
   * there, the router sends the config here, and the quota goes over the branch's own rows. One
   * that declares none is built over the enclosing branch's rows, which is what the streaming
   * engines do.
   */
  private static List<String> nestedSwitchValues(
      Config.Switch spec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      PerRow.Stream stream,
      Map<String, String[]> columns) {
    String streamId = stream == null ? "" : stream.id();
    String[] subject = columns.get(spec.on());
    List<List<Integer>> entryPositions = new ArrayList<>();
    for (int e = 0; e < spec.entries().size(); e++) {
      entryPositions.add(new ArrayList<>());
    }
    List<Integer> fallbackPositions = new ArrayList<>();
    for (int i = 0; i < count; i++) {
      int row = stream == null ? i : stream.rowAt(i);
      String key = subject == null || row >= subject.length || subject[row] == null
          ? ""
          : subject[row];
      int picked = -1;
      for (int e = 0; e < spec.entries().size(); e++) {
        if (spec.entries().get(e).keys().contains(key)) {
          picked = e;
          break;
        }
      }
      (picked < 0 ? fallbackPositions : entryPositions.get(picked)).add(i);
    }

    String[] out = new String[count];
    Arrays.fill(out, "");
    for (int e = 0; e < spec.entries().size(); e++) {
      placeNested(
          spec.entries().get(e).value(), entryPositions.get(e), streamId + "#sw" + e, count, prng,
          packs, config, nowMillis, baseDir, rowLinks, stream, out, columns);
    }
    if (spec.fallback() != null) {
      placeNested(
          spec.fallback(), fallbackPositions, streamId + "#swdef", count, prng, packs, config,
          nowMillis, baseDir, rowLinks, stream, out, columns);
    }
    return Arrays.asList(out);
  }

  /** One branch of a nested switch, over the positions that chose it. */
  private static void placeNested(
      Config.Case body,
      List<Integer> positions,
      String streamId,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      PerRow.Stream stream,
      String[] out,
      Map<String, String[]> columns) {
    if (positions.isEmpty()) {
      return;
    }
    if (!caseCarriesPercent(body)) {
      List<String> whole =
          caseValues(
              body, count, prng, packs, config, nowMillis, baseDir, rowLinks,
              new PerRow.Stream(
                  config.seed(), streamId, stream == null ? null : stream.rows()),
              columns);
      for (int i : positions) {
        out[i] = whole.get(i);
      }
      return;
    }
    List<Integer> rows = new ArrayList<>(positions.size());
    for (int i : positions) {
      rows.add(stream == null ? i : stream.rowAt(i));
    }
    List<String> values =
        caseValues(
            body, positions.size(), prng, packs, config, nowMillis, baseDir, rowLinks,
            new PerRow.Stream(config.seed(), streamId, rows), columns);
    for (int local = 0; local < positions.size(); local++) {
      out[positions.get(local)] = values.get(local);
    }
  }

  /**
   * One switch branch over its own rows.
   *
   * <p>A branch no row chose draws nothing: a quota over zero rows is not a quota.
   *
   * <p>{@code ranked} is the rows in the order the STREAMING engine numbers them; {@code null}
   * when they cannot be numbered, and then the branch is built over the whole run and read at
   * the row — which is what the streaming engine does with such a branch, and the two must
   * agree.
   */
  private static void place(
      Config.Case body,
      List<Integer> rows,
      List<Integer> ranked,
      String streamId,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      String[] out,
      Map<String, String[]> columns) {
    if (rows.isEmpty()) {
      return;
    }
    if (ranked == null) {
      if (!caseCarriesPercent(body)) {
        // The streaming engines cannot number the rows of a multi-key branch or of <default>, so
        // they build those over the whole run and read the row they want. This engine has to do
        // the same or the two would answer differently on a config neither of them refuses.
        List<String> whole =
            caseValues(
                body, count, prng, packs, config, nowMillis, baseDir, rowLinks,
                new PerRow.Stream(config.seed(), streamId, null), columns);
        for (int row : rows) {
          out[row] = whole.get(row);
        }
        return;
      }
      // It declares a share, so the streaming engines refuse it and the router sends the whole
      // config here: no other engine will ever produce this column, and it is free to be exact.
      // The quota goes over the branch's OWN rows, in row order.
      List<String> exact =
          caseValues(
              body, rows.size(), prng, packs, config, nowMillis, baseDir, rowLinks,
              new PerRow.Stream(config.seed(), streamId, rows), columns);
      for (int local = 0; local < rows.size(); local++) {
        out[rows.get(local)] = exact.get(local);
      }
      return;
    }
    List<String> values =
        caseValues(
            body, ranked.size(), prng, packs, config, nowMillis, baseDir, rowLinks,
            new PerRow.Stream(config.seed(), streamId, ranked), columns);
    for (int local = 0; local < ranked.size(); local++) {
      out[ranked.get(local)] = values.get(local);
    }
  }

  /**
   * A switch branch's rows in the order the STREAMING engine numbers them, or {@code null} when
   * it cannot number them at all.
   *
   * <p>A branch keyed {@code Male} of {@code <switch on="Gender">} is the same subset as
   * {@code parent="Gender.Male"}, and both engines must lay a quota over it the same way. That
   * order is NOT row order: it is the rank inside the subject's exact layout, which is what
   * {@code orderedRows} computes for a child and what the streaming engine's
   * {@code childRankAt} hands out. Ordering by row instead put the right COUNT of values on the
   * wrong rows, and the two engines disagreed on a config neither of them refused.
   *
   * <p>{@code null} for a multi-key entry ({@code US|CA|MX}): its rows are a union of subsets,
   * and ranks across a union do not compose from the per-value ranks.
   */
  /** Does this {@code <case>} body declare a share that the denominator has to be right for? */
  private static boolean caseCarriesPercent(Config.Case body) {
    for (Config.CasePart part : body.parts()) {
      if (part.mix() != null
          && part.mix().percent() != null
          && !part.mix().percent().trim().isEmpty()) {
        return true;
      }
      String genPercent = part.gen() == null ? null : part.gen().attrs().get("percent");
      if (genPercent != null && !genPercent.trim().isEmpty()) {
        return true;
      }
    }
    return false;
  }

  private static List<Integer> rankedBranchRows(
      String on, List<String> keys, List<Integer> rows, Map<String, PerRow.ExactLayout> layouts) {
    if (keys.size() != 1) {
      return null;
    }
    PerRow.ExactLayout plan = layouts.get(on);
    if (plan == null) {
      return null;
    }
    int vi = plan.values().indexOf(keys.get(0));
    if (vi < 0) {
      return null;
    }
    int lo = plan.cumHi()[vi] - plan.counts()[vi];

    List<Integer> ordered = new ArrayList<>(Collections.nCopies(rows.size(), -1));
    for (int row : rows) {
      Integer slot = plan.slotByRow().get(row);
      if (slot == null) {
        return null;
      }
      int rank = slot - lo;
      if (rank < 0 || rank >= ordered.size()) {
        return null;
      }
      ordered.set(rank, row);
    }
    return ordered.contains(-1) ? null : ordered;
  }

  /**
   * A conditional sequence: the first branch whose condition holds wins.
   *
   * <p>Every branch is generated in full, for every row, even though at most one value survives
   * on each. That is not waste to be optimised away — the draws a branch takes are part of the
   * stream, so generating only the winning branch would make the whole run depend on which
   * branch happened to win, and two engines would stop agreeing.
   */
  private static List<String> conditional(
      Config.SequenceSpec spec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String[]> columns) {
    if (count == 0) {
      return List.of();
    }
    // Each branch draws under its OWN stream — `Name#if0`, `Name#if1` — the ids the
    // streaming engine gives them. They used to take the run's shared PRNG, which made a
    // branch's values depend on how many draws the columns before it had made, so the same
    // config and seed produced different data here than when streaming.
    List<List<String>> built = new ArrayList<>();
    List<String> flagNames = new ArrayList<>();
    List<boolean[]> flags = new ArrayList<>();
    for (int b = 0; b < spec.branches().size(); b++) {
      Config.Gen gen = spec.branches().get(b).gen();
      boolean[] spiked = new boolean[count];
      built.add(
          columnValues(
              gen,
              count,
              prng,
              packs,
              config,
              nowMillis,
              baseDir,
              rowLinks,
              new PerRow.Stream(config.seed(), spec.name() + "#if" + b, null),
              spiked,
              null,
              columns == null ? null : Siblings.of(columns)));
      String declared = gen.attrs().get("anomaly_flag");
      flagNames.add(declared == null || declared.trim().isEmpty() ? null : declared.trim());
      flags.add(spiked);
    }

    // One column per DISTINCT name: branches sharing anomaly_flag="IsOutlier" share the
    // column, which is the point of writing it on each branch.
    Map<String, String[]> flagColumns = new LinkedHashMap<>();
    for (String name : flagNames) {
      if (name != null) {
        flagColumns.computeIfAbsent(name, key -> new String[count]);
      }
    }

    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      int winner = -1;
      for (int b = 0; b < spec.branches().size(); b++) {
        String condition = spec.branches().get(b).ifExpr();
        if (condition == null || condition(condition, columns, i)) {
          winner = b;
          break;
        }
      }
      // No branch matched: the row is not covered, so neither the value nor any claim
      // about it exists — every flag column stays null here, masked like the value.
      out.add(winner < 0 ? null : built.get(winner).get(i));
      if (winner < 0) {
        continue;
      }
      for (Map.Entry<String, String[]> entry : flagColumns.entrySet()) {
        // A covered row always has an answer. `false` — not empty — when the branch that
        // produced it cannot spike at all, because "no outlier" is the truth about that
        // row and a detector scored against the column needs it stated, not left blank.
        boolean spiked =
            entry.getKey().equals(flagNames.get(winner)) && flags.get(winner)[i];
        entry.getValue()[i] = spiked ? "true" : "false";
      }
    }
    columns.putAll(flagColumns);
    return out;
  }

  /**
   * The passes that run over a finished column, in this order: outliers, then blanks, then
   * formatting.
   *
   * <p>The order is the contract. Spiking after blanking would multiply an empty string, and
   * formatting before either would format a value that is about to be replaced.
   */
  /**
   * One generator's finished values for a whole column, keyed the way the streaming engine keys
   * them.
   *
   * <p>Three shapes, and which one applies is the streaming engine's own split: a LISTED column —
   * a {@code text} list, a weighted file column, a weighted pack — is laid out exactly over the
   * rows and permuted, never picked per row; an independent generator is built ROW BY ROW off
   * {@code (seed, streamId, row)}, with the modifiers applied inside that loop so {@code anomaly=}
   * spends the row's own draw; everything else keeps the older shape.
   *
   * <p>Without a {@code stream} — an inline generator, a nested pack body — all three collapse to
   * the last, which is what those callers want.
   */
  private static List<String> columnValues(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      PerRow.Stream stream,
      boolean[] anomalyFlags,
      Map<String, PerRow.ExactLayout> layouts,
      Siblings siblings) {
    return columnValues(
        gen, count, prng, packs, config, nowMillis, baseDir, rowLinks, stream, anomalyFlags,
        layouts, null, siblings);
  }

  /** {@link #columnValues}, also keeping the instants behind a date column some offset reads. */
  private static List<String> columnValues(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      PerRow.Stream stream,
      boolean[] anomalyFlags,
      Map<String, PerRow.ExactLayout> layouts,
      List<Long> instants,
      Siblings siblings) {
    if (stream == null) {
      return finish(
          generate(
              gen, count, prng, packs, config, nowMillis, baseDir, rowLinks, instants, siblings,
              null),
          gen.attrs(),
          prng,
          anomalyFlags,
          instants);
    }

    Listed listed = listedValues(gen, packs, config, baseDir);
    if (listed != null) {
      return finishKeyed(
          PerRow.exactTextLayout(listed.values(), listed.percents(), count, stream, layouts),
          gen,
          prng,
          anomalyFlags,
          stream);
    }

    // `sample="exact"` on a quantile read is a PLAN, like the layout above: every row takes its
    // own point on the sorted sample, and which point follows from a scatter over the whole
    // column. Built a row at a time it would see a count of one and hand every row the median.
    if ("file".equals(gen.type())
        && Quantile.isQuantile(gen.attrs())
        && Quantile.isExactSample(gen.attrs())) {
      Quantile.Source source =
          Quantile.read(
              FileGen.load(gen.attrs(), baseDir, packs.dataRoots()), gen.attr("src", "").trim());
      int sweepDecimals = Quantile.decimalsFor(gen.attrs(), source);
      int sweepKey = Permute.key(stream.seed(), stream.id());
      List<String> swept = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        // The POSITION inside this column, not the absolute row: the sweep spreads `count`
        // points over the rows this column actually has, and a filtered column has fewer of
        // them than the run does.
        swept.add(Quantile.exactAt(source, sweepDecimals, count, sweepKey, i));
      }
      return finishKeyed(swept, gen, prng, anomalyFlags, stream);
    }

    // Two types the streaming engine builds INLINE: the value follows the position, and only the
    // one draw that perturbs it is keyed by the row.
    if ("timeseries".equals(gen.type())) {
      return finishKeyed(
          timeseriesKeyed(gen.attrs(), count, stream), gen, prng, anomalyFlags, stream);
    }
    if ("pattern".equals(gen.type())) {
      return finishKeyed(
          patternKeyed(gen.attrs(), count, baseDir, stream), gen, prng, anomalyFlags, stream);
    }

    // A weighted choice inside an advanced_regex — `(?%{RU:70|US:20|DE:10})` — is a quota over the
    // column like any other share. Decided one row at a time it awards every row to the largest
    // share: 100% RU, not 70/20/10.
    boolean weighted =
        weightedTemplatePack(gen, packs, config) != null
            || ("advanced_regex".equals(gen.type())
                && AdvancedRegexGen.hasWeightedChoice(gen.attr("value", "")));
    if (PerRow.perRowBuildable(gen, count, weighted, packNeedsWholeColumn(gen, packs, config))) {
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        Prng.Sfc32 rowPrng = PerRow.rowGenerator(stream, stream.rowAt(i));
        final int here = stream.rowAt(i);
        boolean[] one = new boolean[1];
        // One row's instant lands in its own scratch: the inner call knows nothing of `i`, and a
        // later `missing=` pass has to line up with the values it just blanked.
        List<Long> scratch = instants == null ? null : new ArrayList<>(1);
        List<String> done =
            finish(
                generate(
                    gen, 1, rowPrng, packs, config, nowMillis, baseDir, rowLinks, scratch,
                    siblings, position -> here),
                gen.attrs(),
                rowPrng,
                one,
                scratch);
        out.add(done.isEmpty() ? "" : done.get(0));
        if (anomalyFlags != null && i < anomalyFlags.length) {
          anomalyFlags[i] = one[0];
        }
        if (instants != null) {
          instants.add(scratch != null && !scratch.isEmpty() ? scratch.get(0) : null);
        }
      }
      return out;
    }

    return finishKeyed(
        generate(
            gen, count, prng, packs, config, nowMillis, baseDir, rowLinks, null, siblings,
            stream::rowAt),
        gen,
        prng,
        anomalyFlags,
        stream);
  }

  /**
   * {@link #finish}, with the two modifier draws taken from the column's own {@code #anom} and
   * {@code #miss} streams when the type is one the streaming engine builds inline.
   */
  private static List<String> finishKeyed(
      List<String> values,
      Config.Gen gen,
      Prng.Sfc32 prng,
      boolean[] anomalyFlags,
      PerRow.Stream stream) {
    return PerRow.INLINE_ANOMALY_TYPES.contains(gen.type())
        ? finishWith(values, gen.attrs(), prng, anomalyFlags, stream)
        : finish(values, gen.attrs(), prng, anomalyFlags);
  }

  /** {@link #finish}, with the anomaly and missing draws taken from a stream rather than in order. */
  private static List<String> finishWith(
      List<String> values,
      Map<String, String> attrs,
      Prng.Sfc32 prng,
      boolean[] anomalyFlags,
      PerRow.Stream stream) {
    List<String> out = new ArrayList<>(values);

    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(attrs);
    if (anomaly != null) {
      for (int i = 0; i < out.size(); i++) {
        boolean selected =
            anomaly.probability() > 0
                && PerRow.purposeDraw(stream, "#anom", stream.rowAt(i)) < anomaly.probability();
        if (anomalyFlags != null && i < anomalyFlags.length) {
          anomalyFlags[i] = selected;
        }
        if (selected) {
          out.set(i, Imperfections.spike(out.get(i), anomaly.factor()));
        }
      }
    }

    Imperfections.Missing missing = Imperfections.parseMissing(attrs);
    if (missing != null && missing.probability() > 0) {
      for (int i = 0; i < out.size(); i++) {
        if (PerRow.purposeDraw(stream, "#miss", stream.rowAt(i)) < missing.probability()) {
          out.set(i, missing.token());
          // A blanked cell has no spike left to label. `anomaly_flag` is the ground truth an
          // outlier detector is scored against, and the anomalies page promises the flag and the
          // spike "can never disagree".
          if (anomalyFlags != null && i < anomalyFlags.length) {
            anomalyFlags[i] = false;
          }
        }
      }
    }

    return formatValues(out, attrs);
  }

  /** A value list and the shares it is laid out by. */
  private record Listed(List<String> values, double[] percents) {}

  /** The value list and the shares a column lays out, when its values are LISTED. */
  private static Listed listedValues(
      Config.Gen gen, DataPacks packs, Config config, Path baseDir) {
    if ("sequential".equals(gen.attrs().get("order"))) {
      return null;
    }
    if (gen.attrs().containsKey("weight")) {
      // `row=` links whole rows of the file; the choice is not this column's.
      if (trimToNull(gen.attrs().get("row")) != null) {
        return null;
      }
      FileGen.Weighted weighted = FileGen.loadWeighted(gen.attrs(), baseDir, packs.dataRoots());
      return weighted == null ? null : new Listed(weighted.values(), weighted.percents());
    }
    Listed pack = weightedTemplatePack(gen, packs, config);
    if (pack != null) {
      return pack;
    }
    if (!"text".equals(gen.type())) {
      return null;
    }
    List<String> values = splitText(gen.attr("value", ""));
    return new Listed(values, PerRow.sharesOf(gen.attr("percent", ""), values.size()));
  }

  /**
   * A {@code <gen type="template">} pointing at a pack that carries its own shares.
   *
   * <p>A synthetic address ({@code person.b_day} and its kind) is resolved inside the generator and
   * has no pack file behind it, so asking the registry would throw rather than answer.
   */
  private static Listed weightedTemplatePack(Config.Gen gen, DataPacks packs, Config config) {
    if (!"template".equals(gen.type())) {
      return null;
    }
    String path = gen.attr("value", "");
    if (path.isEmpty() || !packs.exists(path, config.locale())) {
      return null;
    }
    DataPacks.Entry entry = packs.load(path, config.locale());
    return entry.weighted() ? new Listed(entry.values(), entry.percents()) : null;
  }

  /**
   * Whether a pack GENERATOR apportions a share over the whole column. Its values are computed
   * rather than listed, so there is no list to lay out.
   */
  private static boolean packNeedsWholeColumn(Config.Gen gen, DataPacks packs, Config config) {
    if (!"template".equals(gen.type())) {
      return false;
    }
    String path = gen.attr("value", "");
    return !path.isEmpty()
        && packs.exists(path, config.locale())
        && packs.needsWholeColumn(path, config.locale());
  }

  /**
   * {@code <gen type="timeseries" noise=…>} keyed by the row.
   *
   * <p>The value follows the POSITION — a series read at a point of the run — while the noise
   * follows the ROW, on the dedicated {@code :ts} stream the streaming engine uses. Same two names,
   * same two uniforms, same series.
   */
  private static List<String> timeseriesKeyed(
      Map<String, String> attrs, int count, PerRow.Stream stream) {
    Timeseries.Spec spec = Timeseries.parse(attrs);
    boolean noisy = spec.hasNoise();
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      double z = 0;
      if (noisy) {
        double[] u = Seekable.uniforms(stream.seed(), stream.id() + ":ts", stream.rowAt(i), 2);
        z = Timeseries.standardNormal(u[0], u[1]);
      }
      out.add(io.github.nickliapin.tdc.lib.Fixed.toFixed(Timeseries.valueAt(spec, i, z), spec.decimals()));
    }
    return out;
  }

  /**
   * {@code <gen type="pattern">} keyed by the row.
   *
   * <p>As with timeseries: the curve is read at the POSITION, and the one draw that places the
   * value inside its band is keyed by the ROW on the streaming engine's {@code :pat} stream.
   */
  private static List<String> patternKeyed(
      Map<String, String> attrs, int count, Path baseDir, PerRow.Stream stream) {
    PatternGen gen = PatternGen.of(attrs, baseDir);
    boolean draws = gen.draws();
    double denom = count > 1 ? count - 1 : 1;
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      double u =
          draws
              ? Seekable.uniforms(stream.seed(), stream.id() + ":pat", stream.rowAt(i), 1)[0]
              : 0;
      out.add(gen.valueAt(i / denom, u));
    }
    return out;
  }

  /**
   * {@code anomaly=}, {@code missing=} and the formatting layer for ONE element of a repeating
   * LISTED column.
   *
   * <p>The two probability draws come off the row's {@code #anom} and {@code #miss} streams with a
   * budget of the row's maximum length, so element k always gets the same uniform however long its
   * row turned out to be.
   */
  private static RepeatKeyed.Modifier elementModifier(
      Config.Gen gen, Repeat.Spec spec, PerRow.Stream stream) {
    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(gen.attrs());
    Imperfections.Missing missing = Imperfections.parseMissing(gen.attrs());
    String mask = gen.attrs().get("mask");
    String caseName = gen.attrs().get("case");
    boolean hasAnomaly = anomaly != null && anomaly.probability() > 0;
    boolean hasMissing = missing != null && missing.probability() > 0;
    boolean hasFormat = mask != null || (caseName != null && Transforms.isCaseTransform(caseName));
    if (!hasAnomaly && !hasMissing && !hasFormat) {
      return null;
    }

    int budget = Math.max(1, spec.max());
    RepeatKeyed.ElementDraw anomalyAt =
        hasAnomaly ? RepeatKeyed.elementUniforms(stream, "#anom", budget) : null;
    RepeatKeyed.ElementDraw missingAt =
        hasMissing ? RepeatKeyed.elementUniforms(stream, "#miss", budget) : null;

    return (row, value, k) -> {
      String out = value;
      if (anomalyAt != null && anomalyAt.at(row, k) < anomaly.probability()) {
        out = Imperfections.spike(out, anomaly.factor());
      }
      if (missingAt != null && missingAt.at(row, k) < missing.probability()) {
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

  static List<String> finish(
      List<String> values, Map<String, String> attrs, Prng.Sfc32 prng, boolean[] anomalyFlags) {
    return finish(values, attrs, prng, anomalyFlags, null);
  }

  /**
   * {@link #finish}, also clearing the instant behind any cell {@code missing=} blanked.
   *
   * <p>A blanked cell no longer shows the date it was built from, so a column measuring from this
   * one must find nothing there rather than produce a date on a row whose source says nothing.
   * {@code mask=}/{@code case=} change only the SPELLING, which is exactly what the instant
   * outlives.
   */
  static List<String> finish(
      List<String> values,
      Map<String, String> attrs,
      Prng.Sfc32 prng,
      boolean[] anomalyFlags,
      List<Long> instants) {
    List<String> out = new ArrayList<>(values);

    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(attrs);
    if (anomaly != null) {
      Imperfections.applyAnomaly(out, anomaly, prng, anomalyFlags);
    }
    Imperfections.Missing missing = Imperfections.parseMissing(attrs);
    if (missing != null) {
      List<String> before = new ArrayList<>(out);
      Imperfections.applyMissing(out, missing, prng);
      if (instants != null) {
        for (int i = 0; i < Math.min(out.size(), instants.size()); i++) {
          if (!java.util.Objects.equals(out.get(i), before.get(i))) {
            instants.set(i, null);
          }
        }
      }
      // And the ground-truth flag goes with it, for the same reason. `anomaly_flag` is sold as
      // the label an outlier detector is scored against, and the anomalies page promises the flag
      // and the spike "can never disagree" — but a blanked cell HAS no spike to agree with.
      if (anomalyFlags != null) {
        for (int i = 0; i < Math.min(out.size(), anomalyFlags.length); i++) {
          if (!java.util.Objects.equals(out.get(i), before.get(i))) {
            anomalyFlags[i] = false;
          }
        }
      }
    }

    return formatValues(out, attrs);
  }

  /**
   * {@code case=} and {@code mask=}, which reach the same code the {@code |upper} and {@code
   * |mask:} filters do so the three ways of asking cannot drift apart.
   */
  private static List<String> formatValues(List<String> out, Map<String, String> attrs) {
    String mask = attrs.get("mask");
    if (mask != null) {
      out.replaceAll(v -> Mask.apply(mask, v));
    }
    String caseName = attrs.get("case");
    if (caseName != null && Transforms.isCaseTransform(caseName)) {
      out.replaceAll(v -> Transforms.applyCase(caseName, v));
    }
    return out;
  }

  /**
   * A column drawn from a named distribution.
   *
   * <p>Each row spends the same number of uniforms whatever the value turns out to be, which is
   * what keeps a row computable from its index. Rejection sampling would be simpler to write and
   * would break that.
   */
  private static List<String> distribute(
      Map<String, String> attrs,
      int count,
      Prng.Sfc32 prng,
      Siblings siblings,
      java.util.function.IntUnaryOperator rowAt) {
    List<String> dynamic = DistParams.expressionParams(attrs);
    Distribution.Spec fixed = dynamic.isEmpty() ? Distribution.parse(attrs) : null;
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      DistParams.Resolved resolved = null;
      if (fixed == null) {
        int row = rowAt == null ? i : rowAt.applyAsInt(i);
        resolved =
            DistParams.resolve(
                attrs,
                dynamic,
                row,
                name -> siblings != null && siblings.has().test(name),
                name -> siblings == null ? null : siblings.at().apply(name, row));
      }
      // Nothing to draw from, so nothing is drawn: the row comes out empty, which is what
      // `<gen type="formula">` does with the same input. One rule for "the source said nothing",
      // wherever the source is read.
      if (resolved != null && resolved.empty()) {
        // The uniforms are spent anyway. Otherwise blanking one cell would slide every value
        // after it, and a `parent=` filter would quietly rewrite the rest of the column.
        for (int d = 0; d < DistParams.draws(attrs); d++) {
          prng.next();
        }
        out.add("");
        continue;
      }
      Distribution.Spec spec =
          fixed != null ? fixed : Distribution.parse(resolved == null ? attrs : resolved.attrs());
      double[] uniforms = new double[spec.draws()];
      for (int d = 0; d < spec.draws(); d++) {
        uniforms[d] = Distribution.openUnit(prng.next());
      }
      out.add(Distribution.format(Distribution.sample(spec, uniforms), spec));
    }
    return out;
  }


  /** One row link's plan: which row of the file each record reads. */
  private record RowLinkPlan(String sourceKey, List<Integer> indexes) {}

  /**
   * Where a per-row expression reads the columns beside it.
   *
   * <p>{@code has} is separate from {@code at} because an ABSENT name is not an empty one: an
   * unresolved bare word evaluates to the WORD, the way {@code if="Tier == hi"} reads {@code hi},
   * and only a name the registry KNOWS can mark the row empty. It is the same seam the reference
   * calls {@code ctx.valueAt}.
   */
  record Siblings(
      java.util.function.Predicate<String> has,
      java.util.function.BiFunction<String, Integer, String> at) {

    /**
     * The finished columns, as the seam.
     *
     * <p>Safe because TDC240 refuses a parameter that names a column not declared ABOVE it: what
     * it reads is finished by the time the column that reads it is built.
     */
    static Siblings of(Map<String, String[]> columns) {
      return new Siblings(
          columns::containsKey,
          (name, row) -> {
            String[] column = columns.get(name);
            return column != null && row < column.length ? column[row] : null;
          });
    }
  }

  /**
   * {@code row="key"} — every sequence on the same key reads the same row of the file.
   *
   * <p>The first sequence to use a key draws the plan — one row index per record — and every
   * later one follows it. That is the whole point: a city and its postcode taken from one real
   * record are consistent, where two independent draws produce a pairing no validator would
   * accept.
   *
   * <p>Because only the first draws, adding a second field to an existing link consumes no
   * further randomness and leaves every other column exactly where it was.
   */
  private static List<String> linkedFileValues(
      String rowKey,
      Map<String, String> attrs,
      int count,
      Path baseDir,
      List<Path> roots,
      Prng.Sfc32 prng,
      Map<String, RowLinkPlan> rowLinks) {
    FileGen.RowSource source = FileGen.loadRows(attrs, baseDir, roots);
    RowLinkPlan plan = rowLinks.get(rowKey);

    if (plan == null) {
      List<Integer> indexes = new ArrayList<>(count);
      FileGen.Weighted weighted = FileGen.weightedRows(attrs, source);
      if (weighted != null) {
        // With weight=, the shared rows follow the file's counts exactly; every linked field
        // then reads those same rows.
        for (String index : Hamilton.distribute(count, weighted.values(), weighted.percents(), prng)) {
          indexes.add(Integer.parseInt(index));
        }
      } else {
        for (int i = 0; i < count; i++) {
          indexes.add(Random.nextInt(prng, 0, source.rows().size()));
        }
      }
      plan = new RowLinkPlan(source.sourceKey(), indexes);
      rowLinks.put(rowKey, plan);
    } else {
      if (!plan.sourceKey().equals(source.sourceKey())) {
        throw new IllegalStateException(
            "sequence: row link \"" + rowKey + "\" cannot mix different file sources");
      }
      if (plan.indexes().size() != count) {
        throw new IllegalStateException(
            "sequence: row link \"" + rowKey + "\" cannot be reused with a different row count");
      }
    }

    List<String> out = new ArrayList<>(count);
    for (int index : plan.indexes()) {
      out.add(FileGen.cellAt(source, index));
    }
    return out;
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.trim();
    if (trimmed.isEmpty()) {
      throw new IllegalArgumentException("sequence: file row link must not be empty");
    }
    return trimmed;
  }

  /**
   * A {@code value="a, b, c"} list.
   *
   * <p>Trimmed, matching the reference: a config writes the space after the comma because that
   * is how a person writes a list, and the space is formatting rather than part of the value.
   */
  private static List<String> splitText(String value) {
    List<String> parts = new ArrayList<>();
    for (String part : value.split(",", -1)) {
      parts.add(part.trim());
    }
    return parts;
  }

  /**
   * Element {@code index mod N}, or a refusal once the data runs out under {@code cycle="false"}.
   *
   * <p>Looping is the default because a short list walked over many rows is the ordinary case —
   * twelve months across a year of daily records. {@code cycle="false"} is for when running out
   * is a mistake worth hearing about rather than something to paper over by starting again.
   */
  /**
   * Which of {@code size} positions row {@code index} reads, wrapping unless {@code
   * cycle="false"}.
   *
   * <p>Split out of {@link #pickSequential} because a walked date range has positions without
   * having a list: its values are computed from an index, and only this part applies.
   */
  static long sequentialIndex(long size, long index, boolean cycle) {
    if (size <= 0) {
      return 0;
    }
    if (!cycle && index >= size) {
      throw new IllegalStateException(
          "order=\"sequential\" cycle=\"false\": the source has only "
              + size
              + " values, so row "
              + (index + 1)
              + " has none — shorten count= or lengthen the source");
    }
    return index % size;
  }

  private static String pickSequential(List<String> list, int index, boolean cycle) {
    if (list.isEmpty()) {
      return "";
    }
    return list.get((int) sequentialIndex(list.size(), index, cycle));
  }

  /** Pack bodies parse once per address and are then reused; a pack does not change mid-run. */
  private static final Map<String, Object> PACK_BODIES = new java.util.concurrent.ConcurrentHashMap<>();

  /** How many redraws a {@code <valid>} constraint gets before the generator is called impossible. */
  private static final int VALID_FUSE = 100;

  /**
   * Attributes on a {@code <gen type="template">} that steer the CALL rather than parameterise
   * the pack behind it. Everything else may replace a same-named local sequence.
   */
  private static final java.util.Set<String> RESERVED_TEMPLATE_ATTRS =
      java.util.Set.of(
          "type", "value", "local", "name", "if", "comment", "anomaly", "anomaly_factor",
          "anomaly_flag", "missing", "missing_as", "mask", "case", "order", "cycle");

  private static List<String> runPackGenerator(
      DataPacks.Entry entry,
      String path,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String> callerAttrs) {
    Object body =
        PACK_BODIES.computeIfAbsent(
            path,
            ignored -> {
              String source = entry.generator();
              // A body holding <sequence> or <data> is composed; anything else is a lone <gen>.
              return source.contains("<sequence") || source.contains("<data")
                  ? ConfigBuilder.parsePackBody(source)
                  : ConfigBuilder.parseGenTag(source);
            });

    if (body instanceof Config.Gen gen) {
      return generate(gen, count, prng, packs, config, nowMillis, baseDir, rowLinks);
    }

    ConfigBuilder.PackGenerator pack = (ConfigBuilder.PackGenerator) body;
    Map<String, String[]> local = new LinkedHashMap<>();
    Map<String, String> pinned = new LinkedHashMap<>();
    for (Config.SequenceSpec spec : pack.sequences()) {
      // A caller attribute whose name matches this local sequence replaces it with a constant
      // column: `<gen type="template" value="common.internet.email" domain="example.test"/>` is
      // how a pack is parameterised. It draws nothing, so the rest of the body's deterministic
      // stream is exactly where it would otherwise be.
      String overridden =
          callerAttrs == null || RESERVED_TEMPLATE_ATTRS.contains(spec.name())
              ? null
              : callerAttrs.get(spec.name());
      if (overridden != null) {
        String[] constant = new String[count];
        java.util.Arrays.fill(constant, overridden);
        local.put(spec.name(), constant);
        pinned.put(spec.name(), overridden);
        continue;
      }
      local.putAll(
          materializeLocal(spec, count, prng, packs, config, nowMillis, baseDir, rowLinks, local));
    }

    if (pack.validate() != null) {
      enforceValid(
          pack, local, count, prng, packs, config, nowMillis, baseDir, rowLinks, pinned);
    }

    List<String> out = new ArrayList<>(count);
    for (int row = 0; row < count; row++) {
      out.add(Interpolate.apply(pack.output(), config.inject(), lookup(local, row)));
    }
    return out;
  }

  /**
   * One local sequence of a pack body, as the column or columns it contributes.
   *
   * <p>A COMPOUND sequence contributes one column per field, named {@code sequence.field} — the
   * same shape it has in a config, because the reference runs a pack body through the very
   * sequence builder a config goes through. Every {@code .tdc} pack that ships is written this
   * way.
   */
  private static Map<String, String[]> materializeLocal(
      Config.SequenceSpec spec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String[]> local) {
    Map<String, String[]> produced = new LinkedHashMap<>();
    if (spec.isComputed()) {
      String[] values = new String[count];
      for (int i = 0; i < count; i++) {
        values[i] = computeRow(spec, local, i);
      }
      produced.put(spec.name(), values);
      return produced;
    }
    if (spec.fields() != null) {
      // Declaration order off the shared prng: a pack body is a nested build with no stream of
      // its own, so the fields of one row draw one after another rather than each keying itself
      // — which is what pairs a given name with the surname beside it.
      Map<String, List<String>> byField = new LinkedHashMap<>();
      for (Config.Field field : spec.fields()) {
        List<String> values =
            generate(field.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks);
        byField.put(
            field.name(),
            new ArrayList<>(finish(values, field.gen().attrs(), prng, new boolean[count])));
      }
      // After every field exists, never during: a group's members must all be there before the
      // constraint between them means anything.
      if (spec.distinctGroups() != null) {
        enforceDistinct(
            spec, byField, count, prng, packs, config, nowMillis, baseDir, rowLinks, List.of(),
            true);
      }
      for (Config.Field field : spec.fields()) {
        produced.put(
            spec.name() + "." + field.name(), byField.get(field.name()).toArray(new String[0]));
      }
      return produced;
    }
    List<String> values = generate(spec.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks);
    produced.put(
        spec.name(), finish(values, spec.gen().attrs(), prng, new boolean[count]).toArray(new String[0]));
    return produced;
  }

  private static String computeRow(Config.SequenceSpec spec, Map<String, String[]> local, int row) {
    return Compute.evaluate(
        (TDCParser.OpenCloseElementContext) spec.compute(),
        name -> {
          String[] column = local.get(name);
          return column == null ? null : column[row];
        });
  }

  /**
   * Reject and redraw until the pack's {@code <valid>} predicate holds.
   *
   * <p>Some identifiers have combinations that were never issued — a region code that does not
   * exist, a date inside a national ID that never happened. Redrawing appends to the stream, so
   * the result stays deterministic; the fuse is there because a constraint no draw can satisfy
   * would otherwise hang the run rather than report itself.
   */
  private static void enforceValid(
      ConfigBuilder.PackGenerator pack,
      Map<String, String[]> local,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String> pinned) {
    // A PINNED sequence is never redrawn. A caller parameter replaces a local sequence with a
    // constant, and redrawing it threw that constant away: a config asking for a particular base
    // got values with nothing to do with it and no word of complaint. When the pin is all the
    // guard reads there is nothing left to re-roll either, so the answer is fixed before the
    // first attempt and saying so at once beats a hundred no-ops per row.
    boolean redrawable =
        pack.sequences().stream()
            .anyMatch(s -> !s.isComputed() && !pinned.containsKey(s.name()));

    for (int row = 0; row < count; row++) {
      int attempts = 0;
      if (!redrawable && !holds(pack, local, row)) {
        StringBuilder named = new StringBuilder();
        for (Map.Entry<String, String> e : pinned.entrySet()) {
          if (named.length() > 0) {
            named.append(", ");
          }
          named.append(e.getKey()).append("=\"").append(e.getValue()).append('"');
        }
        throw new IllegalStateException(
            "pack generator <valid> rejects the value built from "
                + (named.length() == 0 ? "the pinned parameters" : named)
                + ", and every sequence the guard reads is pinned, so there is nothing left to"
                + " redraw. Pass a value the pack accepts, or drop the parameter and let the pack"
                + " draw its own.");
      }
      while (!holds(pack, local, row)) {
        if (attempts >= VALID_FUSE) {
          throw new IllegalStateException(
              "pack generator <valid> constraint could not be satisfied for row "
                  + row
                  + " after "
                  + VALID_FUSE
                  + " attempts — the base cannot produce a valid value");
        }
        attempts++;
        for (Config.SequenceSpec spec : pack.sequences()) {
          // A pinned sequence keeps its constant.
          if (spec.isComputed() || pinned.containsKey(spec.name())) {
            continue;
          }
          if (spec.gen() == null) {
            throw new IllegalStateException(
                "pack generator <valid> requires simple <gen> base sequences; sequence \""
                    + spec.name()
                    + "\" is not supported");
          }
          List<String> one =
              finish(
                  generate(spec.gen(), 1, prng, packs, config, nowMillis, baseDir, rowLinks),
                  spec.gen().attrs(),
                  prng,
                  new boolean[1]);
          local.get(spec.name())[row] = one.get(0);
        }
        // Derived values follow their inputs, in declaration order.
        for (Config.SequenceSpec spec : pack.sequences()) {
          if (spec.isComputed()) {
            local.get(spec.name())[row] = computeRow(spec, local, row);
          }
        }
      }
    }
  }

  private static boolean holds(
      ConfigBuilder.PackGenerator pack, Map<String, String[]> local, int row) {
    return Compute.evaluatePredicate(
        pack.validate(),
        name -> {
          String[] column = local.get(name);
          return column == null ? null : column[row];
        });
  }


  /**
   * Fill every {@code type="http"} column from its service, once the rest of the run exists.
   *
   * <p>A second pass rather than a generator branch, because an http gen may read another
   * sequence through {@code in=}, and that sequence has to be finished first.
   *
   * <p>One call per column, carrying the whole batch — a million rows is a handful of requests,
   * not a million. The {@code in=} column travels as the request body, so a service can answer
   * per input rather than out of thin air.
   *
   * <p>The seed sent along is derived from the run's seed and the sequence name. The engine
   * cannot make an http column reproducible, since the service decides the values; what it can
   * do is give the service everything it needs to be reproducible on its own.
   */
  private static void resolveHttp(
      Config config, Map<String, String[]> columns, int count, Path baseDir) {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.gen() == null || !"http".equals(spec.gen().type())) {
        continue;
      }
      Map<String, String> attrs = spec.gen().attrs();
      String inName = attrs.get("in");
      List<String> inputs = null;
      if (inName != null && !inName.isBlank()) {
        String[] column = columns.get(inName);
        inputs = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
          inputs.add(column == null || column[i] == null ? "" : column[i]);
        }
      }

      // Resolved per sequence and never cached: two sequences may sign with two different
      // secrets, and a config naming an unset variable should say so in terms of the sequence the
      // reader wrote.
      String secretSpec = attrs.get("secret");
      String secret = null;
      if (secretSpec != null && !secretSpec.isBlank()) {
        try {
          secret = HttpGen.resolveSecret(secretSpec, baseDir);
        } catch (HttpGen.SecretException e) {
          throw new IllegalStateException(
              "http service for sequence \"" + spec.name() + "\": " + e.getMessage(), e);
        }
      }

      List<String> values;
      try {
        values =
            HttpGen.fetch(
                attrs.getOrDefault("src", ""),
                count,
                inputs,
                HttpGen.seedFor(config.seed(), spec.name()),
                HttpGen.onError(attrs),
                HttpGen.timeoutMs(attrs.get("timeout")),
                secret);
      } catch (HttpGen.ServiceException e) {
        throw new IllegalStateException(
            "http service for sequence \"" + spec.name() + "\" at " + e.url + " " + e.getMessage(), e);
      }

      String[] target = columns.get(spec.name());
      if (target != null) {
        for (int i = 0; i < count && i < values.size(); i++) {
          target[i] = values.get(i);
        }
      }
    }
  }

  /** Which rows a column applies to. */
  private static boolean[] parentMask(
      Config.SequenceSpec spec, Map<String, String[]> columns, int count) {
    boolean[] mask = new boolean[count];
    if (spec.parent() == null) {
      Arrays.fill(mask, true);
      return mask;
    }
    int dot = spec.parent().indexOf('.');
    String parentName = dot < 0 ? spec.parent() : spec.parent().substring(0, dot);
    String parentValue = dot < 0 ? null : spec.parent().substring(dot + 1);

    String[] parent = columns.get(parentName);
    if (parent == null) {
      throw new IllegalArgumentException(
          "sequence \""
              + spec.name()
              + "\" references unknown parent \""
              + parentName
              + "\". Parent sequences must be declared before their children.");
    }
    for (int i = 0; i < count; i++) {
      mask[i] = parentValue == null ? parent[i] != null : parentValue.equals(parent[i]);
    }
    return mask;
  }

  /** Lay dense produced values back over the full row range, leaving filtered rows null. */
  /**
   * A template whose address names another column.
   *
   * <p>The row decides where its value comes from: a car's model list depends on its make, a
   * region's cities on its country. That is the difference between data that is merely plausible
   * per column and data that holds together across a record.
   *
   * <p>One row at a time, necessarily — the address changes with it — and only on the rows the
   * parent selected, so a filtered-out row draws nothing rather than drawing from whatever
   * address an empty interpolation happens to produce.
   */
  private static List<String> dynamicTemplate(
      Config.Gen gen,
      boolean[] mask,
      Map<String, String[]> columns,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir) {
    String template = gen.attr("value", "");
    String locale = gen.attrs().getOrDefault("local", config.locale());
    if (locale.isBlank()) {
      locale = config.locale();
    }
    List<String> out = new ArrayList<>();
    for (int row = 0; row < mask.length; row++) {
      if (!mask[row]) {
        continue;
      }
      int current = row;
      String address =
          Interpolate.apply(
              template,
              config.inject(),
              new Interpolate.Lookup() {
                @Override
                public boolean has(String name) {
                  return columns.containsKey(name);
                }

                @Override
                public String value(String name) {
                  String[] column = columns.get(name);
                  String v = column == null ? null : column[current];
                  return v == null ? "" : v;
                }
              });
      Config.Gen resolved = new Config.Gen("template", withValue(gen.attrs(), address));
      List<String> built =
          generate(resolved, 1, prng, packs, config, nowMillis, baseDir, new LinkedHashMap<>());
      out.add(built.isEmpty() ? "" : built.get(0));
    }
    return out;
  }

  /** The same attributes with {@code value} replaced by an address already resolved. */
  private static Map<String, String> withValue(Map<String, String> attrs, String value) {
    Map<String, String> out = new LinkedHashMap<>(attrs);
    out.put("value", value);
    return out;
  }

  private static String[] spread(List<Integer> rows, List<String> produced, int count) {
    String[] values = new String[count];
    for (int at = 0; at < rows.size(); at++) {
      values[rows.get(at)] = at < produced.size() ? produced.get(at) : null;
    }
    return values;
  }

  /**
   * One generator's values.
   *
   * <p>Shared with the streaming engine, which calls it with a count of one and a generator
   * private to the row. Two copies of this dispatch would be two places for the languages to
   * drift apart from each other and from themselves.
   */
  static List<String> generate(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks) {
    return generate(gen, count, prng, packs, config, nowMillis, baseDir, rowLinks, null, null, null);
  }

  /**
   * One generator's values, optionally keeping the instants behind a date column.
   *
   * <p>Threaded rather than derived afterwards because a date's cell is a RENDERING —
   * {@code 02/03/2026} in an en locale, {@code 03.02.2026} in a ru one — and reading a date back
   * out of that is a guess. The column that produced it keeps what it generated, and an offset
   * measures from THAT.
   */
  static List<String> generate(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      List<Long> instants) {
    return generate(
        gen, count, prng, packs, config, nowMillis, baseDir, rowLinks, instants, null, null);
  }

  /**
   * The same, with the seam a distribution parameter written as an EXPRESSION reads through.
   *
   * <p>{@code rowAt} says which absolute row each position is; {@code null} means the positions
   * ARE the rows — the whole-column build of an unfiltered sequence.
   */
  static List<String> generate(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      List<Long> instants,
      Siblings siblings,
      java.util.function.IntUnaryOperator rowAt) {
    String locale = config.locale();

    // order="sequential" comes before everything else: it replaces the draw entirely, so the
    // percent= and the random pick below never happen. Row i is element i mod N.
    //
    // Only text and file, matching the reference. A sequential regex or date would have to mean
    // something invented here, and inventing it is how two implementations stop agreeing.
    if (("text".equals(gen.type()) || "file".equals(gen.type()))
        && "sequential".equals(gen.attrs().get("order"))) {
      List<String> list =
          "file".equals(gen.type())
              ? FileGen.load(gen.attrs(), baseDir, packs.dataRoots())
              : splitText(gen.attr("value", ""));
      boolean cycle = !"false".equals(gen.attrs().get("cycle"));
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        out.add(pickSequential(list, i, cycle));
      }
      return out;
    }

    // The same rule over a date range: row i is the i-th step from the start. The axis is
    // arithmetic rather than a list, so a long range costs nothing to walk.
    if ("date".equals(gen.type()) && "sequential".equals(gen.attrs().get("order"))) {
      DateGen.Axis axis = DateGen.dateAxis(gen.attrs(), locale, nowMillis);
      boolean cycle = !"false".equals(gen.attrs().get("cycle"));
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        // An OPEN axis has no size and never wraps: row i is simply the i-th step.
        long k = axis.size() == null ? i : sequentialIndex(axis.size(), i, cycle);
        // A WALKED date keeps its instant too. It is the pairing a real record asks for most —
        // orders march down the calendar, delivery is a few days after its own order — and this
        // branch returns before the drawn-date one, so without this the sink stayed empty and
        // the offset read every row as "this row has no date". A silent empty column, from a
        // config that was right.
        if (instants != null) {
          instants.add(io.github.nickliapin.tdc.date.Calendar.toEpochMillis(axis.valueAt(k)));
        }
        out.add(axis.at(k));
      }
      return out;
    }

    List<String> values;
    String percent;
    switch (gen.type()) {
      case "increment" -> {
        return Counter.generate(gen.attrs(), count, true);
      }
      case "decrement" -> {
        return Counter.generate(gen.attrs(), count, false);
      }
      case "number" -> {
        String distribution = gen.attrs().get("distribution");
        if (distribution != null && !distribution.isBlank()) {
          return distribute(gen.attrs(), count, prng, siblings, rowAt);
        }
        return NumberGen.generate(gen.attrs(), count, prng);
      }
      case "timeseries" -> {
        return Timeseries.generate(gen.attrs(), count, prng);
      }
      case "file" -> {
        // `read="quantile"` reads the SAME file as a distribution rather than a bag: sorted
        // once, a row lands anywhere on it, and the values between observations appear on their
        // own. One uniform per row and nothing shared, so this needs no branch of its own on the
        // streaming engine — it arrives here a row at a time and answers the same way. The EXACT
        // sweep is a plan over the whole column and lives where the stream is.
        if (Quantile.isQuantile(gen.attrs())) {
          Quantile.Source source =
              Quantile.read(
                  FileGen.load(gen.attrs(), baseDir, packs.dataRoots()),
                  gen.attr("src", "").trim());
          int quantileDecimals = Quantile.decimalsFor(gen.attrs(), source);
          List<String> drawn = new ArrayList<>(count);
          for (int i = 0; i < count; i++) {
            drawn.add(
                Quantile.render(
                    Quantile.at(source.sorted(), Seekable.openUnit(prng.next())),
                    quantileDecimals));
          }
          return drawn;
        }
        String rowKey = trimToNull(gen.attrs().get("row"));
        if (rowKey != null) {
          return linkedFileValues(
              rowKey, gen.attrs(), count, baseDir, packs.dataRoots(), prng, rowLinks);
        }
        FileGen.Weighted weighted = FileGen.loadWeighted(gen.attrs(), baseDir, packs.dataRoots());
        if (weighted != null) {
          // The same apportionment percent= uses, so the file's counts come out exact rather
          // than approximate.
          return Hamilton.distribute(count, weighted.values(), weighted.percents(), prng);
        }
        return FileGen.generate(gen.attrs(), count, baseDir, prng, packs.dataRoots());
      }
      case "pattern" -> {
        return PatternGen.generate(gen.attrs(), count, baseDir, prng);
      }
      case "http" -> {
        // Filled in a second pass, after every ordinary column exists: an http gen may read
        // another sequence through in=, and that sequence has to be there first.
        List<String> placeholder = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
          placeholder.add("");
        }
        return placeholder;
      }
      case "regex" -> {
        return RegexGen.generate(gen.attrs(), count, config.regexMaxLength(), prng);
      }
      case "advanced_regex" -> {
        return AdvancedRegexGen.generate(gen.attrs(), count, config.regexMaxLength(), prng);
      }
      case "symbol" -> {
        return SymbolGen.generate(gen.attrs(), count, prng);
      }
      case "date" -> {
        return DateGen.generate(gen.attrs(), locale, nowMillis, count, prng, instants);
      }
      case "text" -> {
        values = splitText(gen.attr("value", ""));
        percent = gen.attr("percent", "");
      }
      case "template" -> {
        String path = gen.attr("value", "");
        // Two template paths are generators rather than lists. They are resolved before the
        // pack registry is consulted, which is why no pack file is named after them.
        if ("person.b_day".equals(path)) {
          List<String> out = new ArrayList<>(count);
          for (int i = 0; i < count; i++) {
            out.add(DateGen.birthDay(gen.attrs(), locale, nowMillis, prng));
          }
          return out;
        }
        if ("date.range".equals(path)) {
          return DateGen.legacyRange(gen.attrs(), locale, nowMillis, count, prng);
        }
        DataPacks.Entry entry = packs.load(path, locale);
        if (entry.isGenerator()) {
          // The pack ships a rule rather than a list. Two shapes: a lone <gen>, or local
          // sequences feeding an output template — which is how an identifier with a check
          // digit is expressed as editable data instead of as engine code.
          return runPackGenerator(
              entry, path, count, prng, packs, config, nowMillis, baseDir, rowLinks, gen.attrs());
        }
        if (entry.weighted()) {
          // A weighted pack is laid out exactly, not sampled: the counts in the file are
          // proportions the run has to hit, which is the same path percent= takes.
          return Hamilton.distribute(count, entry.values(), entry.percents(), prng);
        }
        values = entry.values();
        percent = "";
      }
      default -> throw new UnsupportedOperationException(
          "generator type \"" + gen.type() + "\" is not ported yet");
    }
    if (percent.isEmpty()) {
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        out.add(values.get((int) Math.floor(prng.next() * values.size())));
      }
      return out;
    }
    // Through the shared mask reader, so a partial mask like percent="50" over three values
    // splits the remainder instead of throwing on the blanks.
    return Hamilton.distribute(count, values, PercentMask.expand(percent, values.size()), prng);
  }

  /**
   * Evaluate an {@code if} against one row.
   *
   * <p>A column that has no value on this row reads as empty rather than as missing, so a
   * condition on a child column is false on the rows its parent did not select — which is what
   * a config expects when it asks about a field that only some records have.
   */
  private static boolean condition(String expr, Map<String, String[]> columns, int row) {
    return Evaluate.asCondition(
        expr,
        new Evaluate.Scope() {
          @Override
          public boolean has(String name) {
            return columns.containsKey(name);
          }

          @Override
          public String value(String name) {
            String[] column = columns.get(name);
            return column == null || column[row] == null ? "" : column[row];
          }
        });
  }

  /**
   * One line — or, with {@code each="NAME"}, one line per element of that list.
   *
   * <p>Returns the text with its newline already attached, because a line with {@code each} may
   * produce several and a list with nothing in it must produce none at all: a customer with no
   * orders leaves no blank row behind.
   */
  private static List<String> renderLine(
      Config.Line line,
      Map<String, String[]> columns,
      int row,
      String inject,
      Map<String, Repeat.Spec> eachInfo) {
    StringBuilder text = new StringBuilder();
    for (Config.DataPart part : line.parts()) {
      if (part.ifExpr() == null || condition(part.ifExpr(), columns, row)) {
        text.append(part.text());
      }
    }
    String template = text.toString();

    String listName = line.each() == null ? null : line.each().trim();
    if (listName == null || listName.isEmpty()) {
      return List.of(Interpolate.apply(template, inject, lookup(columns, row)) + "\n");
    }

    Repeat.Spec spec = eachInfo.get(listName);
    String[] column = columns.get(listName);
    String cell = column == null || column[row] == null ? "" : column[row];
    List<String> elements =
        Repeat.split(cell, spec == null ? Repeat.DEFAULT_SEPARATOR : spec.separator());

    // Lanes: two repeating sequences write into the same child table, so each gets its own
    // slice of every card's key block rather than sharing one counter.
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
                  inject,
                  elementLookup(columns, row, listName, elements.get(k), k + 1, lane, stride))
              + "\n");
    }
    return out;
  }

  /**
   * The row's view with one element of a list substituted for the list itself, plus the two
   * positional built-ins {@code _item} and {@code _item_id}.
   *
   * <p>Shallow on purpose: every other column still resolves per record, which is exactly what
   * makes a foreign key on the repeated line point at the right parent on every emitted row.
   */
  private static Interpolate.Lookup elementLookup(
      Map<String, String[]> columns,
      int row,
      String listName,
      String element,
      int position,
      int lane,
      int stride) {
    Map<String, String> overlay =
        Map.of(
            listName, element,
            "_item", String.valueOf(position),
            "_item_id", String.valueOf(Repeat.itemKey(row + 1, position, lane, stride)));
    Interpolate.Lookup base = lookup(columns, row);
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

  /** One row's view of the columns, shared by the interpolator and the {@code if} evaluator. */
  private static Interpolate.Lookup lookup(Map<String, String[]> columns, int row) {
    return new Interpolate.Lookup() {
      @Override
      public boolean has(String name) {
        return columns.containsKey(name);
      }

      @Override
      public String value(String name) {
        String[] column = columns.get(name);
        return column == null || column[row] == null ? "" : column[row];
      }
    };
  }

  /**
   * Whether a composed body builds a value of its own.
   *
   * <p>A body of nothing but named items — fields and constants — has none.
   */
  static boolean composesOwnValue(List<Config.Item> items) {
    return items.stream()
        .anyMatch(item -> item.constantName() == null && (item.gen() != null || item.text() != null));
  }

  /** The same spec with its composed body's named gens spelled out as fields. */
  static Config.SequenceSpec withFieldsOf(Config.SequenceSpec spec) {
    List<Config.Field> fields = new ArrayList<>();
    for (Config.Item item : spec.items()) {
      if (item.field() != null) {
        fields.add(item.field());
      }
    }
    return new Config.SequenceSpec(
        spec.name(), spec.parent(), null, fields, spec.items(), null, null, null, null,
        spec.distinctGroups(), spec.uniq());
  }

}
