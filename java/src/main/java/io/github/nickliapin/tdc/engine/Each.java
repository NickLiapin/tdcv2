package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.format.Interpolate;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.sequence.Pool;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * {@code each="NAME"} on a {@code <line>} or a {@code <group>} — its output once per element of a
 * list or record of a pool.
 *
 * <p>Shared by the in-memory and the streaming engine, which used to carry a copy each. Both
 * copies asked a {@code <data if=…>} once per ROW, so a condition naming the element — {@code
 * _item}, or the list itself — saw the row instead; the reference asks it once per element, with
 * the element in scope.
 *
 * <p>The walked name is a list (a {@code repeat=} sequence) or a pool. A list element overlays the
 * name itself; a pool record overlays every field as {@code Pool.field}, nested records included
 * ({@code Doctors.dept.name}), since the pool table publishes them under those paths. The {@code
 * if=} is asked of each element too, and the positions — {@code Pool._item}, {@code Pool._first},
 * {@code Pool._last} — are counted over the elements it KEEPS: {@code _last} is the last line
 * printed, which is what a JSON array needs to know before its comma, whatever the filter dropped
 * after it.
 *
 * <p>A {@code <group>} nests: its element is in scope for every line inside it, an inner group's
 * on top of an outer one's.
 */
final class Each {
  private Each() {}

  /** The output lines of one {@code each} line on one row, each with its newline attached. */
  static List<String> render(
      Config.Line line,
      String name,
      int row,
      String inject,
      Map<String, Repeat.Spec> eachInfo,
      Function<String, Pool.Table> pools,
      Interpolate.Lookup base) {
    List<String> out = new ArrayList<>();
    for (Map<String, String> overlay :
        overlays(name, line.ifExpr(), row, eachInfo, pools, base)) {
      out.add(textOf(line, inject, view(overlay, base)));
    }
    return out;
  }

  /**
   * {@code <group>}: its lines and groups, once per element it walks — or once, or not at all.
   *
   * <p>With {@code each=} the items print once per element of a list or record of a pool, with that
   * element in scope for every one of them, so an inner {@code each} can keep the doctors of the
   * department being printed ({@code Doctors.dept.id == Depts.id}). Without it, {@code if=} decides
   * all of them at once, in the scope around the group.
   */
  static List<String> renderGroup(
      Config.Line group,
      int row,
      String inject,
      Map<String, Repeat.Spec> eachInfo,
      Function<String, Pool.Table> pools,
      Interpolate.Lookup base) {
    String name = group.each() == null ? "" : group.each().trim();
    List<Map<String, String>> scopes;
    if (name.isEmpty()) {
      scopes = holds(group.ifExpr(), base) ? List.of(Map.of()) : List.of();
    } else {
      scopes = overlays(name, group.ifExpr(), row, eachInfo, pools, base);
    }
    List<String> out = new ArrayList<>();
    for (Map<String, String> overlay : scopes) {
      Interpolate.Lookup view = view(overlay, base);
      for (Config.Line item : group.items()) {
        out.addAll(renderItem(item, row, inject, eachInfo, pools, view));
      }
    }
    return out;
  }

  /** One line or group inside a group, in the scope the groups around it put in place. */
  private static List<String> renderItem(
      Config.Line item,
      int row,
      String inject,
      Map<String, Repeat.Spec> eachInfo,
      Function<String, Pool.Table> pools,
      Interpolate.Lookup view) {
    if (item.isGroup()) {
      return renderGroup(item, row, inject, eachInfo, pools, view);
    }
    String name = item.each() == null ? "" : item.each().trim();
    if (!name.isEmpty()) {
      return render(item, name, row, inject, eachInfo, pools, view);
    }
    if (!holds(item.ifExpr(), view)) {
      return List.of();
    }
    return List.of(textOf(item, inject, view));
  }

  /** One printed line: the parts whose condition holds, interpolated, newline attached. */
  private static String textOf(Config.Line line, String inject, Interpolate.Lookup view) {
    StringBuilder template = new StringBuilder();
    for (Config.DataPart part : line.parts()) {
      if (holds(part.ifExpr(), view)) {
        template.append(part.text());
      }
    }
    return Interpolate.apply(template.toString(), inject, view) + "\n";
  }

  /** One overlay per element printed, positions included, after {@code keep} dropped some. */
  private static List<Map<String, String>> overlays(
      String name,
      String keep,
      int row,
      Map<String, Repeat.Spec> eachInfo,
      Function<String, Pool.Table> pools,
      Interpolate.Lookup base) {
    List<Map<String, String>> candidates = new ArrayList<>();
    // A sequence of the same name wins over a pool, as it does everywhere a name is read.
    Pool.Table table = base.has(name) ? null : pools.apply(name);
    if (table != null) {
      for (int m = 0; m < table.count(); m++) {
        Map<String, String> overlay = new HashMap<>();
        overlay.put("_item", String.valueOf(m + 1));
        overlay.put("_item_id", String.valueOf(m + 1));
        for (String field : table.fields()) {
          List<String> column = table.columns().get(field);
          overlay.put(name + "." + field, column == null ? "" : column.get(m));
        }
        candidates.add(overlay);
      }
    } else {
      Repeat.Spec spec = eachInfo.get(name);
      String cell = base.value(name);
      List<String> elements =
          Repeat.split(
              cell == null ? "" : cell,
              spec == null ? Repeat.DEFAULT_SEPARATOR : spec.separator());
      // Lanes: two repeating sequences write into the same child table, so each gets its own
      // slice of every card's key block rather than sharing one counter.
      int lane = 0;
      int stride = 0;
      for (Map.Entry<String, Repeat.Spec> entry : eachInfo.entrySet()) {
        if (entry.getKey().equals(name)) {
          lane = stride;
        }
        stride += entry.getValue().max();
      }
      if (stride == 0) {
        stride = elements.size();
      }
      for (int k = 0; k < elements.size(); k++) {
        Map<String, String> overlay = new HashMap<>();
        overlay.put(name, elements.get(k));
        overlay.put("_item", String.valueOf(k + 1));
        overlay.put("_item_id", String.valueOf(Repeat.itemKey(row + 1, k + 1, lane, stride)));
        candidates.add(overlay);
      }
    }

    List<Map<String, String>> kept = new ArrayList<>();
    for (Map<String, String> overlay : candidates) {
      if (holds(keep, view(overlay, base))) {
        kept.add(overlay);
      }
    }
    for (int k = 0; k < kept.size(); k++) {
      Map<String, String> overlay = kept.get(k);
      overlay.put(name + "._item", String.valueOf(k + 1));
      overlay.put(name + "._first", k == 0 ? "true" : "false");
      overlay.put(name + "._last", k == kept.size() - 1 ? "true" : "false");
    }
    return kept;
  }

  private static boolean holds(String expression, Interpolate.Lookup view) {
    if (expression == null) {
      return true;
    }
    return Evaluate.asCondition(
        expression,
        new Evaluate.Scope() {
          @Override
          public boolean has(String name) {
            return view.has(name);
          }

          @Override
          public String value(String name) {
            return view.value(name);
          }
        });
  }

  /**
   * The scope around, with one element's names laid over it.
   *
   * <p>Shallow on purpose: every other column still resolves per record, which is exactly what
   * makes a foreign key on the repeated line point at the right parent on every emitted row.
   */
  private static Interpolate.Lookup view(Map<String, String> overlay, Interpolate.Lookup base) {
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
}
