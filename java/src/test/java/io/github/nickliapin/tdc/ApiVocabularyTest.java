package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * The object a finished run hands back answers to the SAME names in all five implementations.
 *
 * <p>There was no guard on this surface and it drifted: Python had no {@code to_string}, Java no
 * {@code toArray}, C# neither {@code GetAt} nor {@code Iterate}, Rust neither {@code to_array} nor
 * {@code get_at}. Each was reasonable in its own language and wrong for a reader crossing between
 * them — which is the only way this library is ever read, because it exists to be used beside the
 * generator.
 *
 * <p>The fixture is the vocabulary; this test asks Java to answer to it.
 */
final class ApiVocabularyTest {

  private static final Path FIXTURE =
      Path.of("..", "fixtures", "cross-language", "api.json").toAbsolutePath().normalize();

  @TestFactory
  List<DynamicTest> theSharedNameExists() {
    JsonNode doc;
    try {
      doc = new ObjectMapper().readTree(Files.readString(FIXTURE));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }

    JsonNode members = doc.get("members");
    // A fixture that says nothing would let every name below pass by saying nothing.
    assertTrue(members.size() > 5, "the vocabulary is not empty");

    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode member : members) {
      String name = member.get("java").asText();
      String concept = member.get("concept").asText();
      tests.add(
          DynamicTest.dynamicTest(
              name + " — " + concept,
              () -> {
                boolean found = false;
                for (var method : TDC.class.getMethods()) {
                  if (method.getName().equals(name)) {
                    found = true;
                    break;
                  }
                }
                assertTrue(found, "TDC has no method named " + name);
              }));
    }
    return tests;
  }

  /** Each reader, read to the end — an iterator that is never drained checks nothing. */
  private static final Map<String, BiConsumer<TDC, Integer>> READERS =
      Map.of(
          "the whole run as text", (tdc, index) -> tdc.toString(),
          "every record, materialised", (tdc, index) -> tdc.toArray(),
          "every record, one at a time", (tdc, index) -> tdc.iterate().forEach(row -> {}),
          "one record by position", (tdc, index) -> tdc.getAt(index),
          "the run as columns rather than rows", (tdc, index) -> tdc.toColumns());

  @TestFactory
  List<DynamicTest> aFailingEachAssertionStopsEveryReader() throws IOException {
    JsonNode rule = new ObjectMapper().readTree(Files.readString(FIXTURE)).get("everyReaderKeepsEachAssert");
    String config = rule.get("config").asText();
    String message = rule.get("message").asText();
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode reader : rule.get("readers")) {
      String concept = reader.get("concept").asText();
      int index = reader.has("index") ? reader.get("index").asInt() : 0;
      tests.add(
          DynamicTest.dynamicTest(
              concept,
              () -> {
                BiConsumer<TDC, Integer> read = READERS.get(concept);
                assertNotNull(read, "no reader mapped for " + concept);
                TDC tdc = TDC.options().configString(config).build();
                RuntimeException thrown =
                    assertThrows(RuntimeException.class, () -> read.accept(tdc, index));
                assertTrue(
                    thrown.getMessage().contains(message),
                    "expected \"" + message + "\", got: " + thrown.getMessage());
              }));
    }
    return tests;
  }
}
