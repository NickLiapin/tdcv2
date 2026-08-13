package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The shared behaviour cases, run against this implementation.
 *
 * <p>The cases live in {@code fixtures/cross-language/cases} and their expected output is
 * produced by the reference implementation, never written here. That is the difference between a
 * port that agrees with the reference and a port that agrees with what somebody remembered about
 * the reference: if the reference changes, its own suite fails on these same files, they are
 * regenerated deliberately, and this test fails until the port follows.
 *
 * <p>A case is a whole config rather than a call to one function, so it tests the wiring too — a
 * generator that computes correctly but is reached with the wrong attributes fails here.
 */
class CrossLanguageCasesTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path casesDir() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir).resolve("cross-language/cases");
  }

  private static Stream<Arguments> cases() throws IOException {
    List<Arguments> out = new ArrayList<>();
    try (Stream<Path> files = Files.list(casesDir())) {
      for (Path file : files.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
        JsonNode doc = JSON.readTree(Files.readString(file));
        for (JsonNode node : doc.get("cases")) {
          out.add(
              Arguments.of(
                  file.getFileName().toString().replace(".json", "")
                      + " / "
                      + node.get("name").asText(),
                  node));
        }
      }
    }
    assertTrue(!out.isEmpty(), "no shared cases found in " + casesDir());
    return out.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @DisplayName("matches the shared cross-language case")
  void matchesSharedCase(String name, JsonNode node) {
    TDC.Options options = TDC.options().configString(node.get("config").asText());
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
      // A case that reads the clock pins it, or it would pass today and fail tomorrow.
      options.now(Instant.parse(node.get("now").asText()).toEpochMilli());
    }
    if (node.hasNonNull("dataPath")) {
      // A case with a sample file beside it names the FOLDER holding it, so a relative `src=`
      // resolves the way the CLI resolves one beside a `.tdc`.
      options.baseDir(casesDir().resolve(node.get("dataPath").asText()));
    }

    List<String> want = new ArrayList<>();
    for (JsonNode line : node.get("expected")) {
      want.add(line.asText());
    }
    String expected = want.isEmpty() ? "" : String.join("\n", want) + "\n";
    String actual = options.build().toString();

    if (!expected.equals(actual)) {
      // The first differing line, with its description — a whole-blob diff of a hundred lines
      // says far less than "line 4 of the case about ordinal suffixes".
      List<String> got = Arrays.asList(actual.split("\n", -1));
      for (int i = 0; i < Math.max(want.size(), got.size()); i++) {
        String w = i < want.size() ? want.get(i) : "<missing>";
        String g = i < got.size() ? got.get(i) : "<missing>";
        if (!w.equals(g)) {
          assertEquals(
              w,
              g,
              name + " (" + node.get("description").asText() + "): first difference at line " + (i + 1));
        }
      }
    }
    assertEquals(expected, actual, name);
  }

  @Test
  @DisplayName("every case file is well formed and its expectations were generated")
  void casesAreComplete() throws IOException {
    int total = 0;
    try (Stream<Path> files = Files.list(casesDir())) {
      for (Path file : files.filter(f -> f.toString().endsWith(".json")).toList()) {
        JsonNode doc = JSON.readTree(Files.readString(file));
        assertEquals(1, doc.get("schemaVersion").asInt(), file + ": unexpected schema version");
        for (JsonNode node : doc.get("cases")) {
          total++;
          String name = node.get("name").asText();
          assertTrue(node.hasNonNull("description"), file + " / " + name + " has no description");
          assertTrue(node.hasNonNull("config"), file + " / " + name + " has no config");
          // An empty `expected` means the case was authored but never generated, which would
          // pass silently against a port that produced nothing at all.
          assertTrue(
              node.get("expected").size() > 0,
              file + " / " + name + ": expected is empty — run `npm run cases:update`");
        }
      }
    }
    assertTrue(total >= 70, "only " + total + " shared cases; the suite has shrunk");
  }
}
