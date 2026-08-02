package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.format.Transforms;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The formatting layer, against the reference's own answers.
 *
 * <p>Masks and filters are small and full of decisions that are easy to get subtly wrong: which
 * end an index counts from, whether a range may run backwards, whether an out-of-range index is an
 * error or a gap. Each has a right answer, and the right answer is the reference's.
 *
 * <p>This fixture found a real one: {@code slice:-3} meant "the last three characters" in
 * TypeScript and Python and "all of them" here, because a negative index was being clamped to
 * zero. Nothing else caught it — the shared case fixtures happen not to use a negative slice, and
 * a filter that returns too much text still looks like text.
 */
class FilterVectorsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Stream<Arguments> vectors() throws IOException {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    Path file = Path.of(dir).resolve("cross-language/filter-vectors.json");

    JsonNode document = JSON.readTree(Files.readString(file));
    assertEquals(1, document.get("schemaVersion").asInt(), "unexpected schema version");

    List<Arguments> out = new ArrayList<>();
    for (JsonNode v : document.get("vectors")) {
      out.add(
          Arguments.of(
              v.get("kind").asText(),
              v.get("arg").asText(),
              v.get("input").asText(),
              v.get("expected").asText()));
    }
    assertTrue(!out.isEmpty(), "no vectors in " + file);
    return out.stream();
  }

  @ParameterizedTest(name = "{0} {1} on {2}")
  @MethodSource("vectors")
  @DisplayName("filters and masks match the reference")
  void matchesTheReference(String kind, String arg, String input, String expected) {
    assertEquals(expected, Transforms.applyFilter(kind, arg.isEmpty() ? null : arg, input));
  }
}
