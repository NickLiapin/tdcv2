package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
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
}
