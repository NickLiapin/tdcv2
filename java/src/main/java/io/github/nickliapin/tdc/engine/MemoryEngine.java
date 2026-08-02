package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.compute.Compute;
import io.github.nickliapin.tdc.date.DateGen;
import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.format.Mask;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.generators.Counter;
import io.github.nickliapin.tdc.generators.FileGen;
import io.github.nickliapin.tdc.generators.HttpGen;
import io.github.nickliapin.tdc.generators.Accumulate;
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
import io.github.nickliapin.tdc.sequence.Pool;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Seekable;
import io.github.nickliapin.tdc.prng.Random;
import io.github.nickliapin.tdc.sequence.Uniq;
import io.github.nickliapin.tdc.stats.Distribution;
import io.github.nickliapin.tdc.stats.Timeseries;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
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
      for (int i = 0; i < active.size(); i++) {
        emit(out, fx.beforeLine(), columns, row, config.inject());
        out.append(renderLine(active.get(i), columns, row, config.inject(), eachInfo));
        emit(out, fx.afterLine(), columns, row, config.inject());
        if (i < active.size() - 1) {
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
      out.append(renderLine(line, columns, row, inject, Map.of()));
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
        eligible = buckets.getOrDefault(wanted, List.of());
        detail = " (" + equality[1] + "=\"" + wanted + "\")";
      } else {
        eligible = new ArrayList<>();
        for (int m = 0; m < table.count(); m++) {
          if (Evaluate.asCondition(expression, new MemberScope(columns, table, m, row))) {
            eligible.add(m);
          }
        }
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
      Map<String, String[]> columns, Pool.Table table, int member, int row)
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
      return column == null || column[row] == null ? "" : column[row];
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
    Map<String, String[]> columns = new LinkedHashMap<>();
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
                        part, null, layouts));
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
              rowLinks, rows);
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
                          layouts)));
        }

        if (applicable > 0 && spec.distinctGroups() != null) {
          enforceDistinct(
              spec, produced, applicable, prng, packs, config, nowMillis, baseDir, rowLinks, rows);
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
                    new PerRow.Stream(config.seed(), spec.name() + "#switch", rows));
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
                columns, spec.name()));
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
                    new PerRow.Stream(config.seed(), spec.name() + "#switch", rows));
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
                columns, spec.name()));
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
        produced =
            columnValues(
                spec.gen(), applicable, prng, packs, config, nowMillis, baseDir, rowLinks,
                stream, anomalyFlags, layouts);
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
    resolveHttp(config, columns, count);
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
            value = oneScalar(byName.get(name), one, packs, config, nowMillis, baseDir);
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
  private static String oneScalar(
      Config.SequenceSpec spec,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir) {
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
              new boolean[1], null);
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
      List<Integer> rows) {
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
                Seekable.generator(
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
      PerRow.Stream stream) {
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
                null);
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
              new PerRow.Stream(stream.seed(), stream.id() + "#c" + c, caseRows));
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
      PerRow.Stream stream) {
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
                null);
      } else {
        values =
            mixValues(
                part.mix(), count, prng, packs, config, nowMillis, baseDir, rowLinks, null, sub);
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
   * <p>Built over every row rather than only the matching ones, because a case may hold a
   * generator and its draws are part of the stream whether or not that key came up. A row with
   * no match and no default is empty — which is a value, not a failure: a country with no
   * currency listed simply has none here.
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
      String name) {
    // Every entry resolves over the WHOLE run, not over the rows that chose it — the streaming
    // engine builds them that way so a lookup stays O(1), and the stream names have to match it
    // entry for entry.
    List<List<String>> built = new ArrayList<>(spec.entries().size());
    for (int e = 0; e < spec.entries().size(); e++) {
      built.add(
          caseValues(
              spec.entries().get(e).value(), count, prng, packs, config, nowMillis, baseDir,
              rowLinks, new PerRow.Stream(config.seed(), name + "#sw" + e, null)));
    }
    List<String> fallback =
        spec.fallback() == null
            ? null
            : caseValues(
                spec.fallback(), count, prng, packs, config, nowMillis, baseDir, rowLinks,
                new PerRow.Stream(config.seed(), name + "#swdef", null));

    String[] subject = columns.get(spec.on());
    String[] out = new String[count];
    for (int i = 0; i < count; i++) {
      String key = subject == null || subject[i] == null ? "" : subject[i];
      String picked = null;
      for (int e = 0; e < spec.entries().size(); e++) {
        if (spec.entries().get(e).keys().contains(key)) {
          picked = built.get(e).get(i);
          break;
        }
      }
      if (picked == null && fallback != null) {
        picked = fallback.get(i);
      }
      out[i] = picked;
    }
    return out;
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
    List<List<String>> built = new ArrayList<>();
    for (Config.Branch branch : spec.branches()) {
      built.add(
          finish(
              generate(branch.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks),
              branch.gen().attrs(),
              prng,
              new boolean[count]));
    }

    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      String picked = null;
      for (int b = 0; b < spec.branches().size(); b++) {
        String condition = spec.branches().get(b).ifExpr();
        if (condition == null || condition(condition, columns, i)) {
          picked = built.get(b).get(i);
          break;
        }
      }
      out.add(picked);
    }
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
      Map<String, PerRow.ExactLayout> layouts) {
    if (stream == null) {
      return finish(
          generate(gen, count, prng, packs, config, nowMillis, baseDir, rowLinks),
          gen.attrs(),
          prng,
          anomalyFlags);
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
        boolean[] one = new boolean[1];
        List<String> done =
            finish(
                generate(gen, 1, rowPrng, packs, config, nowMillis, baseDir, rowLinks),
                gen.attrs(),
                rowPrng,
                one);
        out.add(done.isEmpty() ? "" : done.get(0));
        if (anomalyFlags != null && i < anomalyFlags.length) {
          anomalyFlags[i] = one[0];
        }
      }
      return out;
    }

    return finishKeyed(
        generate(gen, count, prng, packs, config, nowMillis, baseDir, rowLinks),
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
      out.add(gen.valueAt(i / denom, u, 1 / denom));
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
    List<String> out = new ArrayList<>(values);

    Imperfections.Anomaly anomaly = Imperfections.parseAnomaly(attrs);
    if (anomaly != null) {
      Imperfections.applyAnomaly(out, anomaly, prng, anomalyFlags);
    }
    Imperfections.Missing missing = Imperfections.parseMissing(attrs);
    if (missing != null) {
      Imperfections.applyMissing(out, missing, prng);
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
      Map<String, String> attrs, int count, Prng.Sfc32 prng) {
    Distribution.Spec spec = Distribution.parse(attrs);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
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
  private static String pickSequential(List<String> list, int index, boolean cycle) {
    if (list.isEmpty()) {
      return "";
    }
    if (!cycle && index >= list.size()) {
      throw new IllegalStateException(
          "order=\"sequential\" cycle=\"false\": only "
              + list.size()
              + " values for "
              + (index + 1)
              + " rows");
    }
    return list.get(index % list.size());
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
        continue;
      }
      local.put(
          spec.name(),
          materializeLocal(spec, count, prng, packs, config, nowMillis, baseDir, rowLinks, local));
    }

    if (pack.validate() != null) {
      enforceValid(pack, local, count, prng, packs, config, nowMillis, baseDir, rowLinks);
    }

    List<String> out = new ArrayList<>(count);
    for (int row = 0; row < count; row++) {
      out.add(Interpolate.apply(pack.output(), config.inject(), lookup(local, row)));
    }
    return out;
  }

  /** One local sequence of a pack body: a computed value, or an ordinary generated column. */
  private static String[] materializeLocal(
      Config.SequenceSpec spec,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      Config config,
      long nowMillis,
      Path baseDir,
      Map<String, RowLinkPlan> rowLinks,
      Map<String, String[]> local) {
    if (spec.isComputed()) {
      String[] values = new String[count];
      for (int i = 0; i < count; i++) {
        values[i] = computeRow(spec, local, i);
      }
      return values;
    }
    List<String> produced = generate(spec.gen(), count, prng, packs, config, nowMillis, baseDir, rowLinks);
    return finish(produced, spec.gen().attrs(), prng, new boolean[count]).toArray(new String[0]);
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
      Map<String, RowLinkPlan> rowLinks) {
    for (int row = 0; row < count; row++) {
      int attempts = 0;
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
          if (spec.isComputed()) {
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
  private static void resolveHttp(Config config, Map<String, String[]> columns, int count) {
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

      List<String> values;
      try {
        values =
            HttpGen.fetch(
                attrs.getOrDefault("src", ""),
                count,
                inputs,
                HttpGen.seedFor(config.seed(), spec.name()),
                HttpGen.onError(attrs),
                HttpGen.timeoutMs(attrs.get("timeout")));
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
          return distribute(gen.attrs(), count, prng);
        }
        return NumberGen.generate(gen.attrs(), count, prng);
      }
      case "timeseries" -> {
        return Timeseries.generate(gen.attrs(), count, prng);
      }
      case "file" -> {
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
        return DateGen.generate(gen.attrs(), locale, nowMillis, count, prng);
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
  private static String renderLine(
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
      return Interpolate.apply(template, inject, lookup(columns, row)) + "\n";
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

    StringBuilder out = new StringBuilder();
    for (int k = 0; k < elements.size(); k++) {
      out.append(
              Interpolate.apply(
                  template,
                  inject,
                  elementLookup(columns, row, listName, elements.get(k), k + 1, lane, stride)))
          .append('\n');
    }
    return out.toString();
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
