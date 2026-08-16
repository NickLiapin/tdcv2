package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.packs.DataPacks;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * A pack generator that DRAWS from a weighted list is a whole-column quota.
 *
 * <p>A weighted list is laid out to an exact Hamilton quota over the run, so each value takes its
 * measured share of the rows. That is a plan for a COLUMN. Asked for a single row, the plan is
 * computed over a column of one and that row goes to the largest share — every time, for every
 * seed.
 *
 * <p>{@code percent=} written INSIDE a pack body was already marked whole-column and routed
 * accordingly. A weighted list the body merely draws FROM was not: the body says {@code <gen
 * type="template" value="hu.person.lastName"/>} and nothing in that line says the list on the other
 * end carries weights. So the pack ran a row at a time and returned rank 1 for ever — eight rows of
 * {@code hu.person.male.fullName} gave 1 distinct value instead of 8.
 *
 * <p>Twelve shipped full-name packs across six locales were in that state — Czech, Dutch,
 * Hungarian, Serbian, Persian, Hebrew — plus one Chinese street name. German and Polish were fine,
 * and the only difference was that their name lists carry no weights, which is why nothing looked
 * wrong.
 */
class WeightedInPackTest {

  private static List<String> draw(String locale, String address, int count) {
    String config =
        ("<tdc><env count=\"%d\" seed=\"weighted-in-pack\" local=\"%s\">"
                + "<sequence name=\"P\"><gen type=\"template\" value=\"%s\"/></sequence>"
                + "</env><block><line><data>${{P}}</data></line></block></tdc>")
            .formatted(count, locale, address);
    return TDC.options().configString(config).build().toString().lines().toList();
  }

  private static int distinct(String locale, String address, int count) {
    Set<String> seen = new LinkedHashSet<>(draw(locale, address, count));
    return seen.size();
  }

  @ParameterizedTest(name = "{1}")
  @CsvSource({
    "hu, hu.person.male.fullName",
    "hu, hu.person.female.fullName",
    "cs, cs.person.male.fullName",
    "cs, cs.person.female.fullName",
    "nl, nl.person.male.fullName",
    "nl, nl.person.female.fullName",
    "sr, sr.person.male.fullName",
    "sr, sr.person.female.fullName",
    "fa, fa.person.male.fullName",
    "fa, fa.person.female.fullName",
    "he, he.person.male.fullName",
    "he, he.person.female.fullName",
    "zh-cn, china.geo.streetName",
  })
  @DisplayName("a pack drawing a weighted list varies across rows")
  void variesAcrossRows(String locale, String address) {
    List<String> rows = draw(locale, address, 40);
    int count = new LinkedHashSet<>(rows).size();
    assertTrue(
        count > 5,
        address
            + " returned \""
            + rows.get(0)
            + "\" on "
            + (rows.size() - count + 1)
            + " of 40 rows — the whole-column quota ran over a column of one");
  }

  /**
   * The flag itself. The engines already knew what to do with {@code needsWholeColumn}; the bug was
   * that nothing set it for a body that only DRAWS weights, so this is the assertion that pins the
   * fix rather than the symptom.
   */
  @ParameterizedTest(name = "{1}")
  @CsvSource({
    "hu, hu.person.male.fullName",
    "cs, cs.person.male.fullName",
    "nl, nl.person.male.fullName",
    "sr, sr.person.male.fullName",
    "fa, fa.person.male.fullName",
    "he, he.person.female.fullName",
    "zh-cn, china.geo.streetName",
  })
  @DisplayName("a pack drawing a weighted list is marked whole-column")
  void markedWholeColumn(String locale, String address) {
    assertTrue(
        DataPacks.bundled().needsWholeColumn(address, locale),
        address + " draws a weighted list and is not flagged");
  }

  /**
   * The counter-case, so the flag is not simply true for everything. German and Polish name lists
   * carry no weights and the generator bodies are otherwise identical to the Hungarian one, so they
   * must stay per-row buildable — being marked would cost them the streaming engines for nothing.
   */
  @Test
  @DisplayName("a pack over unweighted lists is left alone")
  void unweightedPacksStayPerRow() {
    for (String address : List.of("de.person.male.fullName", "pl.person.male.fullName")) {
      String locale = address.substring(0, 2);
      assertFalse(
          DataPacks.bundled().needsWholeColumn(address, locale),
          address + " was flagged whole-column and draws no weights");
      assertTrue(distinct(locale, address, 40) > 5, address + " stopped varying");
    }
  }

  /**
   * A plain weighted LIST is not a generator and must not be flagged either. The streaming engines
   * lay a list's quota out by row index without holding the column, so marking one here would send
   * every config that names a census name file to the in-memory engine.
   */
  @Test
  @DisplayName("a plain weighted list is not a whole-column generator")
  void weightedListIsNotFlagged() {
    assertTrue(DataPacks.bundled().load("hu.person.lastName", "hu").weighted());
    assertFalse(
        DataPacks.bundled().needsWholeColumn("hu.person.lastName", "hu"),
        "a weighted list is laid out per row by index; only a GENERATOR over one needs the column");
  }

  /**
   * Two packs that reference each other. The walk is transitive, so without a guard it recurses
   * until the stack ends — and a {@code StackOverflowError} is not a {@code RuntimeException}, so
   * nothing between here and the CLI would catch it. The pack loader reports the cycle itself; this
   * walk only has to stop.
   */
  @Test
  @DisplayName("a reference cycle stops instead of recursing")
  void referenceCycleTerminates(@TempDir Path root) throws IOException {
    Path dir = root.resolve("xx");
    Files.createDirectories(dir);
    Files.writeString(
        dir.resolve("a.tdc"),
        "---\ngenerator: tdc\nlocale: xx\n---\n"
            + "<sequence name=\"s\"><gen type=\"template\" value=\"xx.b\"/></sequence>\n"
            + "<data>${{s}}</data>\n");
    Files.writeString(
        dir.resolve("b.tdc"),
        "---\ngenerator: tdc\nlocale: xx\n---\n"
            + "<sequence name=\"s\"><gen type=\"template\" value=\"xx.a\"/></sequence>\n"
            + "<data>${{s}}</data>\n");
    DataPacks packs = new DataPacks(root);
    assertFalse(packs.needsWholeColumn("xx.a", "xx"), "a cycle reaches no weighted list");
  }

  /**
   * And the ORDER the weights describe is honoured, not merely varied — a fix that shuffled the
   * values would pass every assertion above and still be wrong.
   *
   * <p>Deliberately not a share: {@code hu/person/lastName.txt} says in its own header that its
   * weights are a rank-decay curve rather than measured bearer counts, so the top four come out
   * near 2% each, not the ~11% real Hungarian data would give. Asserting a share would be testing
   * the curve and would go red the day someone replaces it with real counts.
   */
  @Test
  @DisplayName("the ranking the weights describe survives")
  void rankingSurvives() {
    List<String> rows = draw("hu", "hu.person.lastName", 2000);
    long head = rows.stream().filter(List.of("Nagy", "Kovács", "Tóth", "Szabó")::contains).count();
    long tail = rows.stream().filter(List.of("Szűcs", "Papp")::contains).count();
    assertTrue(head > tail, "head=" + head + " tail=" + tail);
  }

  private static final String FORCED =
      "<tdc><env count=\"40\" seed=\"stream\" local=\"hu\">"
          + "<sequence name=\"P\"><gen type=\"template\" value=\"hu.person.male.fullName\"/></sequence>"
          + "</env><block><line><data>${{P}}</data></line></block></tdc>";

  /**
   * The in-memory engine holds the column, so it apportions the quota and the names vary. Asserted
   * beside the two below so the trio reads as one contract rather than three unrelated checks.
   */
  @Test
  @DisplayName("engine 1 renders the apportioned names")
  void memoryEngineApportions() {
    Set<String> rows =
        new LinkedHashSet<>(
            TDC.options().configString(FORCED).engine(1).build().toString().lines().toList());
    assertTrue(rows.size() > 5, "the in-memory engine repeated one name " + rows);
  }

  /**
   * A streaming engine cannot apportion a quota row by row, so a config that NAMES one must be told
   * rather than quietly handed forty copies of the same name. The refusal is the answer here: an
   * engine asked for by name that silently ran somewhere else would hide what was asked about.
   */
  @Test
  @DisplayName("engine 2 refuses rather than repeating one name")
  void streamingEngineRefuses() {
    RuntimeException refusal =
        assertThrows(
            RuntimeException.class,
            () -> TDC.options().configString(FORCED).engine(2).build().toString(),
            "the streaming engine accepted a whole-column quota");
    assertTrue(
        String.valueOf(refusal.getMessage()).contains("whole column"),
        "unexpected refusal: " + refusal.getMessage());
  }

  /**
   * And engine 3 catches that refusal and falls back to memory, the way it already does for every
   * other construct the seekable path cannot do. The refusal has to be raised while the column is
   * CONSTRUCTED for this to work — raised at the row that reads it, it would escape the fallback's
   * try/catch and reach the caller instead.
   */
  @Test
  @DisplayName("engine 3 falls back to memory instead of propagating the refusal")
  void exactDiskEngineFallsBack() {
    Set<String> rows =
        new LinkedHashSet<>(
            TDC.options().configString(FORCED).engine(3).build().toString().lines().toList());
    assertTrue(rows.size() > 5, "the exact-on-disk engine repeated one name " + rows);
  }
}
