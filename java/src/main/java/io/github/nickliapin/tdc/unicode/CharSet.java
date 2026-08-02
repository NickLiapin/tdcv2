package io.github.nickliapin.tdc.unicode;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The inline character set behind {@code <gen type="symbol" value="…">}.
 *
 * <p>Grammar: {@code [X-Y]} is an inclusive code-point range, every other character stands for
 * itself, and commas and spaces <em>outside</em> brackets are ignored so a long set can be
 * written with breathing room. To include a comma or a space, bracket it: {@code [,]}, {@code [
 * ]}. A hyphen at either end of a group is a literal hyphen.
 *
 * <p>It exists so that picking one of a handful of symbols does not require a regular
 * expression. The result keeps first-seen order and drops duplicates — order matters because
 * the set is indexed by a random draw, so two implementations that ordered it differently would
 * produce different characters from the same seed.
 */
public final class CharSet {

  private CharSet() {}

  public static List<String> parse(String spec) {
    List<String> chars = Alphabets.codePoints(spec);
    Set<String> out = new LinkedHashSet<>();
    int i = 0;
    while (i < chars.size()) {
      String c = chars.get(i);
      if ("[".equals(c)) {
        int end = -1;
        for (int j = i + 1; j < chars.size(); j++) {
          if ("]".equals(chars.get(j))) {
            end = j;
            break;
          }
        }
        if (end < 0) {
          throw new IllegalArgumentException("character set: unterminated \"[\" in \"" + spec + "\"");
        }
        expandGroup(chars.subList(i + 1, end), out, spec);
        i = end + 1;
        continue;
      }
      if (",".equals(c) || isSeparator(c)) {
        i++;
        continue;
      }
      out.add(c);
      i++;
    }
    return List.copyOf(out);
  }

  private static void expandGroup(List<String> group, Set<String> out, String spec) {
    int j = 0;
    while (j < group.size()) {
      String c = group.get(j);
      // A range needs all three tokens present, so a leading or trailing "-" stays literal.
      if (j + 2 < group.size() && "-".equals(group.get(j + 1))) {
        int lo = c.codePointAt(0);
        int hi = group.get(j + 2).codePointAt(0);
        if (hi < lo) {
          throw new IllegalArgumentException(
              "character set: reversed range \"" + c + "-" + group.get(j + 2) + "\" in \"" + spec + "\"");
        }
        for (int cp = lo; cp <= hi; cp++) {
          out.add(new String(Character.toChars(cp)));
        }
        j += 3;
        continue;
      }
      out.add(c);
      j++;
    }
  }

  private static boolean isSeparator(String c) {
    return " ".equals(c) || "\t".equals(c) || "\n".equals(c) || "\r".equals(c);
  }
}
