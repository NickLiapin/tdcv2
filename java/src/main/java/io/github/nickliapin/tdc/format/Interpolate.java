package io.github.nickliapin.tdc.format;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@code ${{Name}}} and {@code ${{Name|upper|mask:xxx}}} inside a {@code <data>}.
 *
 * <p>The marker itself is configurable through {@code <env inject="...">}: the {@code %} in it
 * stands for the name, and everything around it is the delimiter. A config generating shell
 * scripts can set {@code inject="<<%>>"} and stop fighting with dollar signs.
 *
 * <p>A name that matches no sequence is left exactly as it was written, marker and all. Replacing
 * it with an empty string would hide a typo inside data that still looks well-formed; leaving
 * {@code ${{Gendre}}} in the output makes it obvious on the first row.
 */
public final class Interpolate {

  /** Reads the {@code inject} attribute; the greedy group picks the rightmost usable {@code %}. */
  private static final Pattern INJECT_SHAPE = Pattern.compile("(.+)%(.+)");

  // Optional, not a nullable value: a ConcurrentHashMap cannot cache "this inject has no
  // slot" as null, so it would recompile that pattern on every single line.
  private static final Map<String, Optional<Pattern>> PATTERN_CACHE = new ConcurrentHashMap<>();

  /** What a name resolves to on the row being rendered. */
  public interface Lookup {
    boolean has(String name);

    String value(String name);
  }

  private Interpolate() {}

  public static String apply(String text, String inject, Lookup lookup) {
    Pattern pattern = pattern(inject);
    if (pattern == null) {
      // An inject with no `%` names nothing, so there is nothing to substitute.
      return text;
    }

    Matcher m = pattern.matcher(text);
    StringBuilder out = new StringBuilder();
    int last = 0;
    while (m.find()) {
      out.append(text, last, m.start());
      Reference ref = parseReference(m.group(1));
      if (!lookup.has(ref.name())) {
        out.append(m.group());
      } else {
        String value = lookup.value(ref.name());
        for (Filter f : ref.filters()) {
          value = Transforms.applyFilter(f.kind(), f.arg(), value);
        }
        out.append(value);
      }
      last = m.end();
    }
    out.append(text.substring(last));
    return out.toString();
  }

  private record Filter(String kind, String arg) {}

  private record Reference(String name, List<Filter> filters) {}

  /**
   * {@code NAME ( "|" filter )*}, where a filter is a bare word or {@code word:arg}. The argument
   * runs to the next {@code |}, which is why a mask pattern may contain anything but a pipe.
   */
  private static Reference parseReference(String raw) {
    String[] parts = raw.split("\\|", -1);
    String name = parts[0].trim();
    List<Filter> filters = new ArrayList<>();
    for (int i = 1; i < parts.length; i++) {
      String piece = parts[i];
      int colon = piece.indexOf(':');
      if (colon < 0) {
        String kind = piece.trim();
        if (!kind.isEmpty()) {
          filters.add(new Filter(kind, null));
        }
      } else {
        String kind = piece.substring(0, colon).trim();
        if (!kind.isEmpty()) {
          filters.add(new Filter(kind, piece.substring(colon + 1).trim()));
        }
      }
    }
    return new Reference(name, filters);
  }

  /** Empty when the inject has no {@code %} slot at all. */
  private static Pattern pattern(String inject) {
    String key = inject == null || inject.isEmpty() ? "${{%}}" : inject;
    return PATTERN_CACHE
        .computeIfAbsent(
            key,
            k -> {
              Matcher shape = INJECT_SHAPE.matcher(k);
              if (!shape.matches()) {
                return Optional.empty();
              }
              return Optional.of(
                  Pattern.compile(
                      Pattern.quote(shape.group(1)) + "(.+?)" + Pattern.quote(shape.group(2))));
            })
        .orElse(null);
  }
}
