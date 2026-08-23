package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The shared cases again, on the streaming engine.
 *
 * <p>The cases' own {@code expected} is what the in-memory engine produces, and the streaming
 * engine does not reproduce it — it draws by row index rather than in order, so the same seed
 * gives a different column. Both are right, and neither is the other's reference. What has to
 * hold is that this engine agrees with the reference implementation's version of the same
 * engine, which is what {@code fixtures/cross-language/engines.json} records.
 *
 * <p>Refusals are checked as strictly as values. A config the reference's streaming engine turns
 * away is one it cannot answer a row at a time, and a port that answers it anyway has not
 * implemented a feature — it has produced plausible wrong data, which is worse than stopping.
 */
class CrossLanguageEnginesTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path sharedDir() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir).resolve("cross-language");
  }

  /** Every shared case, keyed the way the engine fixture names them. */
  private static Map<String, JsonNode> sourceCases() throws IOException {
    Map<String, JsonNode> out = new HashMap<>();
    try (Stream<Path> files = Files.list(sharedDir().resolve("cases"))) {
      for (Path file : files.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
        String group = file.getFileName().toString().replace(".json", "");
        for (JsonNode node : JSON.readTree(Files.readString(file)).get("cases")) {
          out.put(group + "/" + node.get("name").asText(), node);
        }
      }
    }
    return out;
  }

  private static Stream<Arguments> cases() throws IOException {
    JsonNode document = JSON.readTree(Files.readString(sharedDir().resolve("engines.json")));
    Map<String, JsonNode> sources = sourceCases();

    List<Arguments> out = new ArrayList<>();
    for (JsonNode engineNode : document.get("engines")) {
      int engine = engineNode.asInt();
      JsonNode byCase = document.get("cases");
      for (Map.Entry<String, JsonNode> entry : byCase.properties()) {
        JsonNode source = sources.get(entry.getKey());
        assertTrue(
            source != null,
            "engines.json names a case the case files do not have: " + entry.getKey());
        out.add(
            Arguments.of(
                entry.getKey() + " [engine " + engine + "]",
                engine,
                source,
                entry.getValue().get("engine" + engine)));
      }
    }
    assertTrue(!out.isEmpty(), "no engine expectations found in " + sharedDir());
    return out.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @DisplayName("matches the reference on the streaming engine")
  void matchesReferenceEngine(String name, int engine, JsonNode source, JsonNode expectation) {
    // The reference's disk engines arrange this uniq group natively and the
    // arrangement differs from the in-memory one — machinery this port does not
    // carry yet. Skipped by name, so porting it is a deletion of this line.
    Assumptions.assumeFalse(
        expectation.hasNonNull("aheadOfPorts"),
        "the reference is ahead: native disk-engine uniq arrangement");

    boolean shouldRefuse = expectation.hasNonNull("refused");

    String actual;
    try {
      actual = render(source, engine);
    } catch (RuntimeException e) {
      if (shouldRefuse) {
        return;
      }
      throw new AssertionError(
          name + ": the reference renders this, but this refused it — " + e.getMessage(), e);
    }
    if (shouldRefuse) {
      fail(
          name
              + ": the reference refuses this ("
              + expectation.get("refused").asText()
              + "), but this produced:\n"
              + actual);
    }

    List<String> want = new ArrayList<>();
    for (JsonNode line : expectation.get("lines")) {
      want.add(line.asText());
    }
    String expected = want.isEmpty() ? "" : String.join("\n", want) + "\n";
    if (!expected.equals(actual)) {
      List<String> got = List.of(actual.split("\n", -1));
      for (int i = 0; i < Math.max(want.size(), got.size()); i++) {
        String w = i < want.size() ? want.get(i) : "<missing>";
        String g = i < got.size() ? got.get(i) : "<missing>";
        if (!w.equals(g)) {
          assertEquals(w, g, name + ": first difference at line " + (i + 1));
        }
      }
    }
    assertEquals(expected, actual, name);
  }

  private static String render(JsonNode node, int engine) {
    TDC.Options options =
        TDC.options().configString(node.get("config").asText()).engine(engine);
    if (node.hasNonNull("seed")) {
      options.seed(node.get("seed").asText());
    }
    if (node.hasNonNull("count")) {
      options.count(node.get("count").asInt());
    }
    if (node.hasNonNull("locale")) {
      options.locale(node.get("locale").asText());
    }
    if (node.hasNonNull("now")) {
      options.now(Instant.parse(node.get("now").asText()).toEpochMilli());
    }
    if (node.hasNonNull("dataPath")) {
      options.baseDir(sharedDir().resolve("cases").resolve(node.get("dataPath").asText()));
    }
    return options.build().toString();
  }
}
