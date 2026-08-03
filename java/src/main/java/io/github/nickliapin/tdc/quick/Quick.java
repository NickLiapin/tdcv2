package io.github.nickliapin.tdc.quick;

import io.github.nickliapin.tdc.TDC;
import io.github.nickliapin.tdc.packs.DataPacks;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * The quick API: one value, one call, no config file.
 *
 * <pre>{@code
 * Quick tdc = Quick.tdc();
 *
 * tdc.get("person.male.firstName");     // John
 * tdc.get("usa.docs.ssn");              // 690070001, check digits and all
 * tdc.many("person.lastName", 10);      // ten of them
 * tdc.seed("demo").locale("ru").get("person.lastName");
 * tdc.gen("number", Map.of("value", "20..30"));
 * }</pre>
 *
 * <p>ONE RULE, the same as in the other four implementations: the address is spelled the way the
 * pack spells it. {@code person.male.firstName} here is {@code person.male.firstName} in a config,
 * in the reference, and in TypeScript, Python, C# and Rust.
 *
 * <p>WHY A STRING AND NOT {@code tdc.person().male().firstName()}. That shape needs a generated
 * method per address, and a generated surface can only ever cover the packs shipped in the jar.
 * Most packs are downloaded at runtime — ten languages and ninety-odd countries — so
 * {@code tdc.lang().ru()} would simply not exist for the pack a user had just installed, while
 * {@code get("ru.person.lastName")} works the moment the download finishes. TypeScript, Python and
 * C# reach the same place through a proxy their languages provide and Java does not; the address
 * itself is identical in all five.
 *
 * <p>A leading segment may be left out, exactly as in a config: then the address is read against
 * the active locale. {@code get("person.lastName")} gives Williams under {@code en} and Иванов
 * under {@code ru}. To name a pack outright, write it: {@code get("ru.person.lastName")}.
 *
 * <p>WHAT THIS IS NOT. Every call is independent. Nothing here ties one value to another — no
 * {@code <switch>} on a drawn column, no {@code parent=}, no {@code uniq}. A coherent record is a
 * config; this is the drawer of loose values that a faker occupies, answered from the same data
 * packs.
 *
 * <p>{@link #seed} and {@link #locale} each return a NEW object rather than changing this one, so
 * two tests can hold different seeds at once and neither leaks into the other.
 */
public final class Quick {

  /**
   * Rows per underlying run.
   *
   * <p>Part of the cross-language contract: change it and every seeded value changes, because the
   * draw depends on the declared count. The batch size, the {@code #} in the derived seed and the
   * sequence name {@code V} all match {@code typescript/src/quick/draw.ts} exactly, which is what
   * makes the same seed give the same value in every implementation.
   */
  public static final int BATCH_ROWS = 512;

  /**
   * Words the API answers to at the ROOT of an address, so no data CATEGORY may be called one of
   * them. {@code location.country} is fine — {@code country} there is a leaf.
   */
  public static final Set<String> RESERVED_ROOT_NAMES =
      Set.of("gen", "seed", "locale", "lang", "country");

  /**
   * Words the API answers to at EVERY level of an address, so no segment anywhere may be called one
   * of them. There is exactly one, and a test holds the bundled packs to it.
   *
   * <p>Nothing in THIS implementation would break: Java spells an address as a string, so a segment
   * called {@code many} reaches the data like any other. The packs are shared, though, and in
   * TypeScript, Python and C# the same segment is a member name that the proxy answers to itself —
   * {@code tdc.person.many} would draw values rather than walk into the category. The set lives in
   * all five so that the pack that would break the other three is refused where it is added.
   */
  public static final Set<String> RESERVED_PATH_NAMES = Set.of("many");

  private static final class Cursor {
    private int batch;
    private Iterator<TDC.Row> rows;
  }

  private final String seed;
  private final String locale;
  private final Map<String, Cursor> cursors = new LinkedHashMap<>();

  private Quick(String seed, String locale) {
    this.seed = seed;
    this.locale = locale;
  }

  /**
   * The default entry point: random per process, locale from the project config.
   *
   * <p>Without {@link #seed} the quick API is random per process, the way a faker is — a test that
   * wants the same values twice asks for them by name.
   */
  public static Quick tdc() {
    byte[] bytes = new byte[8];
    new SecureRandom().nextBytes(bytes);
    return new Quick(HexFormat.of().formatHex(bytes), null);
  }

  /**
   * The API under a chosen seed, straight away.
   *
   * <p>{@code Quick.tdc().seed("demo")} reaches the same place, but only after drawing eight bytes
   * from a {@link SecureRandom} that the next call discards. Named {@code seeded} rather than
   * {@code seed} because a static and an instance method cannot share a signature; Rust spells this
   * {@code Quick::seeded} for the same reason.
   */
  public static Quick seeded(String value) {
    return new Quick(value, null);
  }

  /** The same API under a chosen seed. */
  public Quick seed(String value) {
    return new Quick(value, locale);
  }

  /** The same API under a chosen locale, which is what a bare address is read against. */
  public Quick locale(String value) {
    return new Quick(seed, value);
  }

  /** One value from a pack address. */
  public String get(String address) {
    return get(address, Map.of());
  }

  /** One value from a pack address, with parameters for the generator behind it. */
  public String get(String address, Map<String, String> params) {
    return many(address, 1, params).get(0);
  }

  /** Several values from one address, continuing the same stream. */
  public List<String> many(String address, int count) {
    return many(address, count, Map.of());
  }

  /** Several values from one address, with parameters. */
  public List<String> many(String address, int count, Map<String, String> params) {
    Map<String, String> attrs = new LinkedHashMap<>();
    attrs.put("value", address);
    attrs.putAll(params);
    return draw("template", attrs, count);
  }

  /**
   * One value from an engine generator — the ones that take attributes rather than an address.
   *
   * <p>{@code gen("number", Map.of("value", "20..30"))}. They are reached by name rather than
   * living at the top level because the pack categories are already called {@code date},
   * {@code text} and {@code word}.
   */
  public String gen(String type, Map<String, String> attrs) {
    return draw(type, new LinkedHashMap<>(attrs), 1).get(0);
  }

  /**
   * One value from an engine generator named by its main value alone.
   *
   * <p>{@code gen("number", "20..30")} for {@code gen("number", Map.of("value", "20..30"))}, which
   * is what nearly every call wants — {@code value} is the one attribute most generators have.
   * TypeScript, Python and C# all read a bare string the same way.
   */
  public String gen(String type, String value) {
    return gen(type, Map.of("value", value));
  }

  /** Several values from one engine generator, continuing the same stream. */
  public List<String> genMany(String type, Map<String, String> attrs, int count) {
    return draw(type, new LinkedHashMap<>(attrs), count);
  }

  /** Several values from one engine generator named by its main value alone. */
  public List<String> genMany(String type, String value, int count) {
    return genMany(type, Map.of("value", value), count);
  }

  /**
   * Streams held open per generator, for one seed and one locale.
   *
   * <p>Keyed by the generator and its attributes: two different addresses draw independently, and
   * the same address asked twice continues where it left off. That is forced by a measured fact —
   * values depend on the row COUNT, not only on the seed, so a call cannot mean "render one row"
   * or a loop of calls returns the same value forever.
   */
  private List<String> draw(String genType, Map<String, String> attrs, int count) {
    if (count < 1) {
      throw new TdcQuickException("count must be a positive whole number, got " + count);
    }
    String key = keyOf(genType, attrs);
    Cursor cursor = cursors.get(key);
    if (cursor == null) {
      cursor = new Cursor();
      cursor.batch = 0;
      cursor.rows = open(genType, attrs, 0);
      cursors.put(key, cursor);
    }

    List<String> out = new ArrayList<>(count);
    while (out.size() < count) {
      if (!cursor.rows.hasNext()) {
        cursor.batch++;
        cursor.rows = open(genType, attrs, cursor.batch);
        continue;
      }
      // One sequence, one column: the row is { V: <the value> }. A compound row cannot appear
      // here — this layer never builds one.
      String value = cursor.rows.next().get("V");
      out.add(value == null ? "" : value);
    }
    return out;
  }

  private Iterator<TDC.Row> open(String genType, Map<String, String> attrs, int batch) {
    String batchSeed = batch == 0 ? seed : seed + "#" + batch;
    try {
      return TDC.options()
          .configString(configFor(genType, attrs, locale, batchSeed))
          .build()
          .iterate()
          .iterator();
    } catch (RuntimeException error) {
      throw explain(genType, attrs, error);
    }
  }

  /**
   * Turn an engine diagnostic about a config the caller never wrote into a sentence about the call
   * they did write — but only when the address really is what went wrong.
   *
   * <p>Rewriting every failure hides the one line that says what is actually wrong: an attribute
   * the validator refused came back as {@code unknown address "common.internet.email". Did you
   * mean "common.internet.email"?}, which is nonsense.
   */
  private RuntimeException explain(
      String genType, Map<String, String> attrs, RuntimeException error) {
    if (!"template".equals(genType)) {
      return error;
    }
    String address = attrs.getOrDefault("value", "");
    String activeLocale = locale == null ? "en" : locale;
    List<String> known = knownAddresses();

    String missing = uninstalledPack(address, known);
    if (missing != null) {
      // The command as a JAVA user can run it. Maven puts nothing on the PATH, so the `tdcv2`
      // the other four implementations name does not exist here until someone aliases it — and
      // advice that cannot be typed is advice that sends the reader to the README instead. The
      // aliased spelling stays in the sentence because it is the form the docs and the other
      // four messages use, and because every implementation's test looks for it.
      return new TdcQuickException(
          "the \"" + missing + "\" pack is not installed, so \"" + address
              + "\" cannot be drawn. Install it with `java -jar tdcv2-cli.jar pack add " + missing
              + "` — or `tdcv2 pack add " + missing + "` if you have aliased the CLI jar — after"
              + " `java -jar tdcv2-cli.jar init` once, to say where packs go.");
    }
    if (known.contains(address) || known.contains(activeLocale + "." + address)) {
      return error;
    }
    String near = nearest(address, activeLocale, known);
    String hint = near == null ? "" : ". Did you mean \"" + near + "\"?";
    return new TdcQuickException(
        "unknown address \"" + address + "\" (locale \"" + activeLocale + "\")" + hint);
  }

  private static List<String> knownAddresses() {
    try {
      return new ArrayList<>(
          DataPacks.forProject(java.nio.file.Path.of(System.getProperty("user.dir"))).addressList());
    } catch (RuntimeException ignored) {
      // A broken project config must not hide the real error behind its own.
      return List.of();
    }
  }

  /**
   * The pack an address names, when that pack is real but not on this machine.
   *
   * <p>The jar carries a starter set and the registry carries the other hundred-odd, so {@code
   * ru.person.lastName} fails not because {@code ru} is a typo but because {@code ru} has not been
   * downloaded. The test is structural rather than a table of locale codes, so it holds for packs
   * that do not exist yet: nothing at all under the first segment, but the REST of the address
   * resolves somewhere.
   */
  private static String uninstalledPack(String address, List<String> known) {
    int dot = address.indexOf('.');
    if (dot <= 0 || dot == address.length() - 1) {
      return null;
    }
    String head = address.substring(0, dot);
    String tail = address.substring(dot + 1);
    String prefix = head + ".";
    for (String candidate : known) {
      if (candidate.startsWith(prefix)) {
        return null;
      }
    }
    String suffix = "." + tail;
    for (String candidate : known) {
      if (candidate.equals(tail) || candidate.endsWith(suffix)) {
        return head;
      }
    }
    return null;
  }

  /**
   * The nearest reachable address to what was typed, compared against the address as written AND
   * against its locale-qualified form: {@code person.firstNam} and {@code en.person.firstNam} are
   * the same typo seen from two sides.
   */
  private static String nearest(String typed, String locale, List<String> known) {
    String qualified = locale + "." + typed;
    String best = null;
    int bestScore = Integer.MAX_VALUE;
    for (String address : known) {
      int score = Math.min(distance(typed, address), distance(qualified, address));
      if (score < bestScore) {
        bestScore = score;
        best = address;
      }
    }
    // Three edits away is a different address, not a typo.
    return bestScore <= 3 ? best : null;
  }

  private static int distance(String a, String b) {
    int[] prev = new int[b.length() + 1];
    for (int j = 0; j <= b.length(); j++) {
      prev[j] = j;
    }
    for (int i = 1; i <= a.length(); i++) {
      int carry = prev[0];
      prev[0] = i;
      for (int j = 1; j <= b.length(); j++) {
        int keep = prev[j];
        prev[j] =
            Math.min(
                Math.min(prev[j] + 1, prev[j - 1] + 1),
                carry + (a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1));
        carry = keep;
      }
    }
    return prev[b.length()];
  }

  private static String configFor(
      String genType, Map<String, String> attrs, String locale, String seed) {
    StringBuilder rendered = new StringBuilder();
    for (Map.Entry<String, String> attr : attrs.entrySet()) {
      rendered.append(' ').append(attr.getKey()).append("=\"").append(escape(attr.getValue())).append('"');
    }
    String local = locale == null ? "" : " local=\"" + escape(locale) + "\"";
    return "<tdc><env count=\"" + BATCH_ROWS + "\" seed=\"" + escape(seed) + "\"" + local + ">"
        + "<sequence name=\"V\"><gen type=\"" + genType + "\"" + rendered + "/></sequence></env>"
        + "<block><line><data>${{V}}</data></line></block></tdc>";
  }

  private static String escape(String value) {
    if (value.indexOf('"') >= 0) {
      throw new TdcQuickException("a double quote is not allowed in a generator value: " + value);
    }
    return value;
  }

  private static String keyOf(String genType, Map<String, String> attrs) {
    StringBuilder key = new StringBuilder(genType).append('|');
    boolean first = true;
    for (Map.Entry<String, String> attr : new TreeMap<>(attrs).entrySet()) {
      if (!first) {
        key.append('&');
      }
      key.append(attr.getKey()).append('=').append(attr.getValue());
      first = false;
    }
    return key.toString();
  }

  @Override
  public String toString() {
    return locale == null
        ? "<tdcv2 quick seed=" + seed + ">"
        : "<tdcv2 quick seed=" + seed + " locale=" + locale + ">";
  }
}
