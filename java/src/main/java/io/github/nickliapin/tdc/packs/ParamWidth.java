package io.github.nickliapin.tdc.packs;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * How many characters a composed pack's own {@code <sequence>} produces, when that is a FACT
 * rather than a guess.
 *
 * <p>A pack parameter replaces one of the pack's sequences for the run: {@code <gen
 * type="template" value="usa.finance.aba_routing" prefix="12"/>} swaps the pack's own {@code
 * prefix}. That is the documented way to pin part of an identifier.
 *
 * <p>The packs that carry a CHECK DIGIT compute it over a fixed layout, so a pinned value of the
 * wrong width does not shift the layout — it breaks it. Measured on {@code
 * usa.finance.aba_routing}, whose {@code prefix} is 2 characters and {@code tail} is 6:
 * {@code prefix="12345"} aborted the run with {@code <at>: index 8 is out of range}, and
 * {@code tail="678"} wrote {@code 326784} — six digits, and not a routing number. {@code check}
 * passed on both.
 *
 * <p>So the width is worked out here, and ONLY where it can be proven from the pack's own body:
 * a {@code text} alternation whose items are all the same length, a {@code regex} of one class
 * with an exact count, a zero-padded {@code number} range. Everything else is absent and the
 * caller stays silent, because a refusal has to be a proof.
 *
 * <p>Read by scanning the body rather than by parsing it — the same choice {@code
 * parameterNames} makes, and for the same reason: the validator asks before anything is built,
 * and parsing here would report a pack author's syntax error at the caller's line.
 */
public final class ParamWidth {

  private static final Pattern SEQUENCE_BLOCK =
      Pattern.compile("<sequence\\s+[^>]*name\\s*=\\s*\"([^\"]+)\"[^>]*>(.*?)</sequence>",
          Pattern.DOTALL);
  private static final Pattern GEN_TAG = Pattern.compile("<gen\\b([^>]*)/?>");
  private static final Pattern ATTR = Pattern.compile("(\\w+)\\s*=\\s*\"([^\"]*)\"");
  private static final Pattern CONTAINER = Pattern.compile("<(compute|mix|switch|case)\\b");
  /** One class or escape repeated an exact number of times: {@code [0-9]{6}}, {@code \\d{4}}. */
  private static final Pattern FIXED_REGEX =
      Pattern.compile("^(?:\\[[^\\]]+\\]|\\\\[dwsDWS]|[A-Za-z0-9])\\{(\\d+)\\}$");
  private static final Pattern NUMBER_RANGE = Pattern.compile("^(-?\\d+)\\.\\.(-?\\d+)$");

  private ParamWidth() {}

  /** The exact character count this generator always produces, or {@code null}. */
  private static Integer fixedWidth(String kind, String value) {
    if (value == null || value.isEmpty()) {
      return null;
    }
    if ("text".equals(kind)) {
      String[] items = value.split(",", -1);
      if (items.length < 2) {
        return null; // a single literal is not a list
      }
      int width = items[0].length();
      for (String item : items) {
        if (item.length() != width) {
          return null;
        }
      }
      return width;
    }
    if ("regex".equals(kind)) {
      Matcher m = FIXED_REGEX.matcher(value);
      return m.matches() ? Integer.valueOf(m.group(1)) : null;
    }
    if ("number".equals(kind)) {
      Matcher m = NUMBER_RANGE.matcher(value);
      if (!m.matches()) {
        return null;
      }
      String low = m.group(1);
      String high = m.group(2);
      // Only a zero-padded range has a fixed width: `1..9999` is 1 to 4 characters.
      return low.length() == high.length() && low.startsWith("0") ? low.length() : null;
    }
    return null;
  }

  /** Parameter name → the width the pack's own sequence always produces. */
  public static Map<String, Integer> parameterWidths(String body) {
    Map<String, Integer> out = new LinkedHashMap<>();
    Matcher block = SEQUENCE_BLOCK.matcher(body);
    while (block.find()) {
      String name = block.group(1);
      String inner = block.group(2);
      Matcher gens = GEN_TAG.matcher(inner);
      if (!gens.find()) {
        continue;
      }
      String genAttrs = gens.group(1);
      // Exactly one `<gen>` and nothing else that produces a value: a compound sequence, a
      // <compute>, a <mix> or a <switch> has no single width to read.
      if (gens.find() || CONTAINER.matcher(inner).find()) {
        continue;
      }
      Map<String, String> attrs = new LinkedHashMap<>();
      Matcher a = ATTR.matcher(genAttrs);
      while (a.find()) {
        attrs.put(a.group(1), a.group(2));
      }
      // A named <gen> is one field of a compound; repetition or formatting means the bare
      // width read below is no longer what the sequence produces.
      if (attrs.containsKey("name") || attrs.containsKey("repeat") || attrs.containsKey("mask")
          || attrs.containsKey("missing")) {
        continue;
      }
      Integer width = fixedWidth(attrs.getOrDefault("type", ""), attrs.get("value"));
      if (width != null) {
        out.put(name, width);
      }
    }
    return out;
  }
}
