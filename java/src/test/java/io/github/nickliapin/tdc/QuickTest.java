package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.quick.Quick;
import io.github.nickliapin.tdc.quick.TdcQuickException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The quick API: one value, one call, no config.
 *
 * <p>The values are pinned to the TypeScript implementation's, not merely to themselves. That is
 * the point of the feature existing here at all — a name in a Java unit test and a name in a
 * TypeScript fixture should come from the same list, in the same order, under the same seed. The
 * constants below were read out of the published npm package.
 */
class QuickTest {

  private static Quick demo() {
    return Quick.tdc().seed("demo").locale("en");
  }

  @Test
  @DisplayName("agrees with the TypeScript implementation, value for value")
  void agreesWithTheReference() {
    Quick tdc = demo();
    assertEquals("Jones", tdc.get("person.lastName"));
    assertEquals("Robert", tdc.get("person.male.firstName"));
    assertEquals("Pharmaceuticals", tdc.get("company.industry"));
    assertEquals("3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9", tdc.get("common.id.uuid"));
    assertEquals("DE62299399441396459682", tdc.get("common.finance.iban"));
    assertEquals("699209702", tdc.get("usa.docs.ssn"));
  }

  @Test
  @DisplayName("a call takes the next value rather than re-rendering row one")
  void aCallAdvancesTheStream() {
    // The bug this prevents: a call that means "render one row" returns the same value forever,
    // so a loop of calls produces one name repeated.
    Quick tdc = demo();
    List<String> drawn = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      drawn.add(tdc.get("person.lastName"));
    }
    assertEquals(List.of("Jones", "Bush", "Armstrong", "Andrews", "Jimenez"), drawn);
  }

  @Test
  @DisplayName("many() is the same stream as repeated calls")
  void manyIsTheSameStream() {
    assertEquals(
        List.of("Jones", "Bush", "Armstrong", "Andrews", "Jimenez"),
        demo().many("person.lastName", 5));
  }

  @Test
  @DisplayName("two addresses are two streams")
  void addressesDrawIndependently() {
    Quick tdc = demo();
    tdc.get("company.industry");
    tdc.get("company.industry");
    assertEquals("Jones", tdc.get("person.lastName"));
  }

  @Test
  @DisplayName("the stream continues past one batch, in step with the reference")
  void theStreamCrossesTheBatchBoundary() {
    // BATCH_ROWS values come from one underlying run; the next batch reopens under a derived
    // seed. That boundary is where two implementations drift, so these four straddle it.
    List<String> many =
        Quick.tdc().seed("batch").locale("en").many("person.lastName", Quick.BATCH_ROWS + 88);
    assertEquals(Quick.BATCH_ROWS + 88, many.size());
    assertEquals(List.of("Nguyen", "Miller", "Gilbert", "Reyes"), many.subList(510, 514));
  }

  @Test
  @DisplayName("seed() and locale() return a new object")
  void seedAndLocaleDoNotMutate() {
    // Two tests must be able to hold two seeds at once without either leaking into the other.
    Quick one = Quick.tdc().seed("a").locale("en");
    Quick two = Quick.tdc().seed("b").locale("en");
    String firstOfOne = one.get("person.lastName");
    assertNotEquals(firstOfOne, two.get("person.lastName"));

    // The stream belongs to the OBJECT, not to the seed.
    assertNotEquals(firstOfOne, one.get("person.lastName"));
    assertEquals(firstOfOne, Quick.tdc().seed("a").locale("en").get("person.lastName"));
  }

  @Test
  @DisplayName("the locale decides what a bare address means")
  void theLocaleDecides() {
    String english = Quick.tdc().seed("l").locale("en").get("person.lastName");
    assertTrue(english.chars().allMatch(c -> c < 128), english);
  }

  @Test
  @DisplayName("an engine generator is reached by name")
  void engineGenerators() {
    assertEquals("66", Quick.tdc().seed("demo").gen("number", Map.of("value", "18..80")));
    assertEquals(
        List.of("332", "591", "349", "665"),
        Quick.tdc().seed("x").genMany("number", Map.of("value", "1..1000"), 4));
  }

  @Test
  @DisplayName("a misspelled address names the nearest one")
  void aMisspelledAddress() {
    TdcQuickException caught =
        assertThrows(
            TdcQuickException.class, () -> Quick.tdc().seed("e").locale("en").get("usa.docs.sn"));
    assertTrue(caught.getMessage().contains("Did you mean \"usa.docs.ssn\""), caught.getMessage());
  }

  @Test
  @DisplayName("a missing pack says so instead of proposing another language")
  void aMissingPack() {
    // The jar carries a starter set; the rest are downloaded. Answering `af.person.lastName`
    // with "did you mean en.person.lastName?" offers English to someone who asked for Afrikaans.
    TdcQuickException caught =
        assertThrows(
            TdcQuickException.class,
            () -> Quick.tdc().seed("m").locale("en").get("af.person.lastName"));
    String message = caught.getMessage();
    assertTrue(message.contains("\"af\" pack is not installed"), message);
    assertTrue(message.contains("tdcv2 pack add af"), message);
    assertFalse(message.contains("Did you mean"), message);
  }

  @Test
  @DisplayName("a count that is not a positive whole number is refused")
  void aBadCount() {
    assertThrows(TdcQuickException.class, () -> demo().many("person.lastName", 0));
  }

  @Test
  @DisplayName("no bundled address collides with a reserved name")
  void reservedNamesAreFree() {
    // The API answers to these words, so a pack category called one of them would be
    // unreachable. This says so when the pack is added rather than when a user cannot reach it.
    Set<String> addresses = DataPacks.bundled().addressList();
    Set<String> roots = new HashSet<>();
    for (String address : addresses) {
      roots.add(address.split("\\.", 2)[0]);
    }
    for (String reserved : Quick.RESERVED_ROOT_NAMES) {
      if (reserved.equals("lang") || reserved.equals("country")) {
        continue;
      }
      assertFalse(roots.contains(reserved), reserved);
    }
  }

  /**
   * The one file all five implementations answer to.
   *
   * <p>The constants above say what the values are; this says that the OTHER FOUR agree, because
   * every implementation reads this same file. It is generated from the reference, so a change to
   * the batch size, the derived seed or the synthesised config shows up here in whichever
   * implementation made it — rather than in a user's diff six months later.
   */
  @Test
  @DisplayName("matches the shared quick vectors")
  void matchesTheSharedQuickVectors() throws Exception {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    Path fixture = Path.of(dir).resolve("cross-language/quick-vectors.json");
    JsonNode root = new ObjectMapper().readTree(Files.readString(fixture));

    assertEquals(Quick.BATCH_ROWS, root.get("batchRows").asInt());

    for (JsonNode c : root.get("addresses")) {
      List<String> expected = new ArrayList<>();
      c.get("expected").forEach(v -> expected.add(v.asText()));
      List<String> drawn =
          Quick.tdc()
              .seed(c.get("seed").asText())
              .locale(c.get("locale").asText())
              .many(c.get("address").asText(), c.get("count").asInt());
      assertEquals(expected, drawn, c.get("address").asText());
    }

    for (JsonNode c : root.get("generators")) {
      List<String> expected = new ArrayList<>();
      c.get("expected").forEach(v -> expected.add(v.asText()));
      java.util.Map<String, String> attrs = new java.util.LinkedHashMap<>();
      c.get("attrs").fields().forEachRemaining(e -> attrs.put(e.getKey(), e.getValue().asText()));
      List<String> drawn =
          Quick.tdc()
              .seed(c.get("seed").asText())
              .genMany(c.get("type").asText(), attrs, c.get("count").asInt());
      assertEquals(expected, drawn, c.get("type").asText());
    }
  }
}
