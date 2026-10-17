package io.github.nickliapin.tdc.validator;

import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a {@code <line each="…">} walks, and {@code | json} on a list — TDC312.
 *
 * <p>A {@code repeat=} column is a LIST joined into one cell with its separator, and {@code |
 * json} cannot see that: it reads text. Without its argument it prints the whole cell as one
 * string, {@code "English;Spanish"}, which is valid JSON and almost never what the config meant.
 * With an argument that is not the column's separator it prints a one-element array. Both run,
 * both produce a file that parses, and the mistake surfaces in whatever reads the file — so
 * {@code check} says so, naming the separator to write.
 */
final class JsonLists {
  private static final Pattern INTERP_REF = Pattern.compile("\\$\\{\\{([^}]*)\\}\\}");

  private JsonLists() {}

  /** The names a {@code <line each="…">} walks — a pool among them is read by being printed. */
  static Set<String> eachPools(TDCParser.OpenCloseElementContext block) {
    Set<String> out = new LinkedHashSet<>();
    for (TDCParser.OpenCloseElementContext line : children(block)) {
      if (!"line".equals(line.name.getText())) {
        continue;
      }
      String each = attributes(line.attr()).getOrDefault("each", "").trim();
      if (!each.isEmpty()) {
        out.add(each);
      }
    }
    return out;
  }

  /**
   * Every list a {@code ${{…}}} can name, by the path it is named with, and its separator.
   *
   * <p>Only lists whose separator the config states plainly are known: a {@code <sequence>} whose
   * single {@code <gen>} repeats, a pool field of that shape, and the same field read through a
   * reference to the pool ({@code D.languages}) or on a line walking it ({@code
   * Doctors.languages}), one nested level included ({@code Doctors.dept.tags}).
   */
  static Map<String, String> separators(TDCParser.OpenCloseElementContext env) {
    Map<String, String> lists = new LinkedHashMap<>();
    if (env == null) {
      return lists;
    }
    Map<String, Map<String, String>> poolLists = new LinkedHashMap<>();
    for (TDCParser.OpenCloseElementContext pool : children(env)) {
      if (!"pool".equals(pool.name.getText())) {
        continue;
      }
      String poolName = attributes(pool.attr()).getOrDefault("name", "").trim();
      if (poolName.isEmpty()) {
        continue;
      }
      Map<String, String> own = listsOf(sequencesOf(pool), poolLists);
      poolLists.put(poolName, own);
      for (Map.Entry<String, String> entry : own.entrySet()) {
        lists.put(poolName + "." + entry.getKey(), entry.getValue());
      }
    }
    lists.putAll(listsOf(sequencesOf(env), poolLists));
    return lists;
  }

  /**
   * {@code {message, hint}} per {@code ${{List | json}}} not splitting on the list's separator.
   *
   * @param walked the list an {@code each} line walks: there its name is the current ELEMENT
   */
  static List<String[]> check(String text, Map<String, String> lists, String walked) {
    List<String[]> out = new ArrayList<>();
    if (lists.isEmpty()) {
      return out;
    }
    Matcher m = INTERP_REF.matcher(text);
    while (m.find()) {
      String[] pieces = m.group(1).split("\\|", -1);
      String name = pieces[0].trim();
      String separator = lists.get(name);
      if (separator == null || name.equals(walked)) {
        continue;
      }
      for (int i = 1; i < pieces.length; i++) {
        String piece = pieces[i];
        int colon = piece.indexOf(':');
        if (!(colon < 0 ? piece : piece.substring(0, colon)).trim().equals("json")) {
          continue;
        }
        String arg = colon < 0 ? null : piece.substring(colon + 1).trim();
        // `json:` with nothing after it is TDC273's to report, and one complaint is enough.
        if ("".equals(arg)) {
          continue;
        }
        String want = separator.trim();
        if (want.equals(arg)) {
          continue;
        }
        String message =
            arg == null
                ? "\"" + name + "\" is a list joined with \"" + separator
                    + "\", and | json prints it as one string"
                : "| json:" + arg + " splits on \"" + arg + "\", but \"" + name
                    + "\" is joined with \"" + separator + "\"";
        String hint =
            writable(separator)
                ? "Write ${{" + name + " | json:" + want + "}} for a JSON array of its elements."
                : "\"" + separator + "\" cannot be written after json: — give the list another "
                    + "separator=, such as \";\".";
        out.add(new String[] {message, hint});
      }
    }
    return out;
  }

  /**
   * A separator {@code json:} can carry. The argument is trimmed, a {@code |} starts the next
   * filter and a <code>}</code> ends the reference, so a list joined with any of those cannot be
   * named after the colon.
   */
  private static boolean writable(String separator) {
    return !separator.trim().isEmpty() && !separator.contains("|") && !separator.contains("}");
  }

  private static Map<String, String> listsOf(
      List<TDCParser.OpenCloseElementContext> sequences,
      Map<String, Map<String, String>> poolLists) {
    Map<String, String> own = new LinkedHashMap<>();
    for (TDCParser.OpenCloseElementContext seq : sequences) {
      String name = attributes(seq.attr()).getOrDefault("name", "").trim();
      List<Map<String, String>> gens = new ArrayList<>();
      for (TDCParser.ElementContext child : elements(seq)) {
        if (child.selfClosingElement() != null
            && "gen".equals(child.selfClosingElement().name.getText())) {
          gens.add(attributes(child.selfClosingElement().attr()));
        } else if (child.openCloseElement() != null
            && "gen".equals(child.openCloseElement().name.getText())) {
          gens.add(attributes(child.openCloseElement().attr()));
        }
      }
      if (name.isEmpty() || gens.size() != 1) {
        continue;
      }
      Map<String, String> gen = gens.get(0);
      if (!gen.getOrDefault("repeat", "").trim().isEmpty()) {
        own.put(name, gen.getOrDefault("separator", Repeat.DEFAULT_SEPARATOR));
      } else if ("pool".equals(gen.get("type"))) {
        // A record drawn from another pool carries that pool's lists one level down.
        Map<String, String> other = poolLists.get(gen.getOrDefault("value", "").trim());
        if (other != null) {
          for (Map.Entry<String, String> entry : other.entrySet()) {
            own.put(name + "." + entry.getKey(), entry.getValue());
          }
        }
      }
    }
    return own;
  }

  /** The {@code <sequence>}s of a container, those wrapped in {@code <uniq>}/{@code <distinct>} included. */
  private static List<TDCParser.OpenCloseElementContext> sequencesOf(
      TDCParser.OpenCloseElementContext container) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    for (TDCParser.OpenCloseElementContext child : children(container)) {
      String tag = child.name.getText();
      if ("sequence".equals(tag)) {
        out.add(child);
      } else if ("uniq".equals(tag) || "distinct".equals(tag)) {
        out.addAll(sequencesOf(child));
      }
    }
    return out;
  }

  private static List<TDCParser.OpenCloseElementContext> children(
      TDCParser.OpenCloseElementContext parent) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    for (TDCParser.ElementContext child : elements(parent)) {
      if (child.openCloseElement() != null) {
        out.add(child.openCloseElement());
      }
    }
    return out;
  }

  private static List<TDCParser.ElementContext> elements(
      TDCParser.OpenCloseElementContext parent) {
    if (parent == null || parent.content() == null) {
      return List.of();
    }
    return parent.content().element();
  }

  private static Map<String, String> attributes(List<TDCParser.AttrContext> attrs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrs) {
      String raw = attr.attrValue.getText();
      out.put(attr.attrName.getText(), raw.substring(1, raw.length() - 1));
    }
    return out;
  }
}
