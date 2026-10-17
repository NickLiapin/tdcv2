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

/**
 * {@code each="NAME"} on a {@code <line>} — one output line per element of a list or record of a
 * pool.
 *
 * <p>Shared by the in-memory and the streaming engine, which used to carry a copy each. Both
 * copies asked a {@code <data if=…>} once per ROW, so a condition naming the element — {@code
 * _item}, or the list itself — saw the row instead; the reference asks it once per element, with
 * the element in scope.
 *
 * <p>The walked name is a list (a {@code repeat=} sequence) or a pool. A list element overlays the
 * name itself; a pool record overlays every field as {@code Pool.field}, nested records included
 * ({@code Doctors.dept.name}), since the pool table publishes them under those paths. The line's
 * own {@code if=} is asked of each element too, and the positions — {@code Pool._item}, {@code
 * Pool._first}, {@code Pool._last} — are counted over the elements it KEEPS: {@code _last} is the
 * last line printed, which is what a JSON array needs to know before its comma, whatever the
 * filter dropped after it.
 */
final class Each {
  private Each() {}

  /**
   * The output lines of one {@code each} line on one row, each with its newline attached.
   *
   * @param table the pool of that name, if there is one; a sequence of the same name wins, as it
   *     does everywhere a name is read
   */
  static List<String> render(
      Config.Line line,
      String name,
      int row,
      String inject,
      Map<String, Repeat.Spec> eachInfo,
      Pool.Table table,
      Interpolate.Lookup base) {
    List<Map<String, String>> candidates = new ArrayList<>();
    if (table != null && !base.has(name)) {
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
      if (holds(line.ifExpr(), overlay, base)) {
        kept.add(overlay);
      }
    }
    List<String> out = new ArrayList<>();
    for (int k = 0; k < kept.size(); k++) {
      Map<String, String> overlay = kept.get(k);
      overlay.put(name + "._item", String.valueOf(k + 1));
      overlay.put(name + "._first", k == 0 ? "true" : "false");
      overlay.put(name + "._last", k == kept.size() - 1 ? "true" : "false");
      StringBuilder template = new StringBuilder();
      for (Config.DataPart part : line.parts()) {
        if (holds(part.ifExpr(), overlay, base)) {
          template.append(part.text());
        }
      }
      out.add(Interpolate.apply(template.toString(), inject, view(overlay, base)) + "\n");
    }
    return out;
  }

  private static boolean holds(
      String expression, Map<String, String> overlay, Interpolate.Lookup base) {
    if (expression == null) {
      return true;
    }
    Interpolate.Lookup view = view(overlay, base);
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
   * The row's view with one element's names laid over it.
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
