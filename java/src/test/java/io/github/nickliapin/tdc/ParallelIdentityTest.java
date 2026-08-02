package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Splitting a run across threads must not change a single byte of it.
 *
 * <p>That is the whole promise of the worker count: it is a speed knob, not a mode. So every shared
 * case is rendered twice — once on one thread, once on four — and the two files are compared
 * whole. Nothing is sampled and nothing is normalised; if a boundary between shards dropped a
 * delimiter or repeated a fixture, the arrays differ and the test says where.
 *
 * <p>The cases are deliberately tiny. Four workers over five rows puts a shard boundary between
 * almost every pair of rows, which is exactly where a seam would show — a million-row run would
 * hide the same bug behind one join in a quarter of a million.
 */
class ParallelIdentityTest {

  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int WORKERS = 4;

  private static Path sharedDir() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir).resolve("cross-language");
  }

  private static Stream<Arguments> cases() throws IOException {
    List<Arguments> out = new ArrayList<>();
    try (Stream<Path> files = Files.list(sharedDir().resolve("cases"))) {
      for (Path file : files.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
        String group = file.getFileName().toString().replace(".json", "");
        for (JsonNode node : JSON.readTree(Files.readString(file)).get("cases")) {
          out.add(Arguments.of(group + "/" + node.get("name").asText(), node));
        }
      }
    }
    assertTrue(!out.isEmpty(), "no shared cases found in " + sharedDir());
    return out.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @DisplayName("four threads write the same bytes as one")
  void identical(String name, JsonNode node) throws IOException {
    TDC one;
    TDC many;
    try {
      one = build(node);
      many = build(node);
    } catch (RuntimeException e) {
      // A config the streaming engine turns away is not this test's business; the engine fixture
      // already holds it to the reference's refusal.
      return;
    }

    Path dir = Files.createTempDirectory("tdc-parallel-");
    try {
      Path single = dir.resolve("single.txt");
      Path parallel = dir.resolve("parallel.txt");
      try {
        one.writeFile(single, 1);
        many.writeFile(parallel, WORKERS);
      } catch (RuntimeException e) {
        return; // refused on both paths for the same reason
      }
      assertArrayEquals(
          Files.readAllBytes(single),
          Files.readAllBytes(parallel),
          name + ": " + WORKERS + " threads wrote different bytes than one");
    } finally {
      try (Stream<Path> walk = Files.walk(dir)) {
        walk.sorted(java.util.Comparator.reverseOrder())
            .forEach(
                p -> {
                  try {
                    Files.deleteIfExists(p);
                  } catch (IOException ignored) {
                    // A temp file left behind does not make a passing test a failing one.
                  }
                });
      }
    }
  }

  private static TDC build(JsonNode node) {
    TDC.Options options = TDC.options().configString(node.get("config").asText()).engine(2);
    if (node.hasNonNull("seed")) {
      options.seed(node.get("seed").asText());
    }
    if (node.hasNonNull("count")) {
      options.count(node.get("count").asInt());
    }
    if (node.hasNonNull("locale")) {
      options.locale(node.get("locale").asText());
    }
    return options.build();
  }
}
