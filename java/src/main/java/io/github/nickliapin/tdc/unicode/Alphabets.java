package io.github.nickliapin.tdc.unicode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The named alphabets a config can ask for by name.
 *
 * <p>Spelled out as explicit code-point ranges rather than looked up through Unicode character
 * properties. Property tables ship with the runtime and change between versions of it, so a
 * config that drew Cyrillic letters could quietly draw a different set of them after an upgrade,
 * and two languages' runtimes would never agree. A range written here means the same thing
 * everywhere, forever.
 */
public final class Alphabets {

  private static final Map<String, List<String>> REGISTRY = new LinkedHashMap<>();

  static {
    List<String> latinLower = between('a', 'z');
    List<String> latinUpper = between('A', 'Z');
    List<String> digits = between('0', '9');

    // Ё sits outside the alphabetical block in Unicode but inside it in the alphabet, so it is
    // spliced back into place rather than appended.
    List<String> cyrLower = new ArrayList<>(between('а', 'е'));
    cyrLower.add("ё");
    cyrLower.addAll(between('ж', 'я'));
    List<String> cyrUpper = new ArrayList<>(between('А', 'Е'));
    cyrUpper.add("Ё");
    cyrUpper.addAll(between('Ж', 'Я'));

    REGISTRY.put("latin.lower", latinLower);
    REGISTRY.put("latin.upper", latinUpper);
    REGISTRY.put("latin.letters", concat(latinUpper, latinLower));
    REGISTRY.put("digits.ascii", digits);
    REGISTRY.put("digits.fullwidth", between('０', '９'));
    REGISTRY.put("cyrillic.ru.lower", List.copyOf(cyrLower));
    REGISTRY.put("cyrillic.ru.upper", List.copyOf(cyrUpper));
    REGISTRY.put("cyrillic.ru.letters", concat(cyrUpper, cyrLower));
    REGISTRY.put("greek.letters", codePoints("ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω"));
    REGISTRY.put("hebrew.letters", between('א', 'ת'));
    REGISTRY.put("arabic.letters", between('ء', 'ي'));
    REGISTRY.put("kana.hiragana", between('ぁ', 'ゖ'));
    REGISTRY.put("kana.katakana", between('ァ', 'ヺ'));
    REGISTRY.put("cjk.unified.basic", between('一', '鿿'));
    REGISTRY.put("roman.upper", codePoints("IVXLCDM"));
    REGISTRY.put("roman.lower", codePoints("ivxlcdm"));
  }

  private Alphabets() {}

  /** {@code null} when the name is unknown; callers report it with the list of known names. */
  public static List<String> chars(String name) {
    return REGISTRY.get(name);
  }

  public static List<String> names() {
    return List.copyOf(REGISTRY.keySet());
  }

  public static List<String> between(int start, int end) {
    if (start > end) {
      throw new IllegalArgumentException("invalid alphabet range");
    }
    List<String> out = new ArrayList<>(end - start + 1);
    for (int cp = start; cp <= end; cp++) {
      out.add(new String(Character.toChars(cp)));
    }
    return out;
  }

  /** One entry per code point, so characters outside the basic plane stay whole. */
  public static List<String> codePoints(String value) {
    List<String> out = new ArrayList<>();
    value.codePoints().forEach(cp -> out.add(new String(Character.toChars(cp))));
    return out;
  }

  private static List<String> concat(List<String> a, List<String> b) {
    List<String> out = new ArrayList<>(a.size() + b.size());
    out.addAll(a);
    out.addAll(b);
    return List.copyOf(out);
  }
}
