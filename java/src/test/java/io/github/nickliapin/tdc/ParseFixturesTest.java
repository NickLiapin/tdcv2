package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.parser.TdcParserFacade;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Every config in the golden fixture set has to parse cleanly with the shared grammar.
 *
 * <p>This is a smaller claim than "produces the right output" — rendering comes next — but it
 * is the one that proves the grammar is genuinely shared rather than merely copied. If a
 * fixture the TypeScript implementation reads every day fails to parse here, the two languages
 * have already diverged.
 */
class ParseFixturesTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path fixtures() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir);
  }

  /** The fixture list comes from the manifest the other implementations read. */
  private static Stream<Arguments> manifestFixtures() throws IOException {
    Path manifest = fixtures().resolve("cross-language/manifest.json");
    assertTrue(Files.exists(manifest), "missing manifest: " + manifest);
    JsonNode doc = JSON.readTree(Files.readString(manifest));

    List<Arguments> cases = new ArrayList<>();
    for (JsonNode entry : doc.get("runtimeFixtures")) {
      String name = entry.get("name").asText();
      // Manifest paths are relative to the manifest's own folder.
      Path source = manifest.getParent().resolve(entry.get("source").asText()).normalize();
      cases.add(Arguments.of(name, source));
    }
    return cases.stream();
  }

  @ParameterizedTest(name = "{0}")
  @DisplayName("golden fixtures parse with the shared grammar")
  @MethodSource("manifestFixtures")
  void fixtureParses(String name, Path source) throws IOException {
    assertTrue(Files.exists(source), name + ": source is missing at " + source);
    TdcParserFacade.Result result = TdcParserFacade.parse(Files.readString(source));
    assertTrue(
        result.ok(),
        () -> name + " failed to parse:\n  " + String.join("\n  ", result.problems().stream().map(Object::toString).toList()));
    assertTrue(result.tree().getChildCount() > 0, name + ": parsed to an empty tree");
  }

  @Test
  @DisplayName("every fixture in the manifest has a source and an expected output on disk")
  void manifestIsComplete() throws IOException {
    Path manifest = fixtures().resolve("cross-language/manifest.json");
    JsonNode doc = JSON.readTree(Files.readString(manifest));
    Path base = manifest.getParent();

    int seen = 0;
    for (JsonNode entry : doc.get("runtimeFixtures")) {
      String name = entry.get("name").asText();
      assertTrue(
          Files.exists(base.resolve(entry.get("source").asText()).normalize()),
          name + ": source missing");
      assertTrue(
          Files.exists(base.resolve(entry.get("expected").asText()).normalize()),
          name + ": expected output missing");
      seen++;
    }
    // A tripwire, not a preference: if the contract grows or shrinks, that should be a
    // deliberate edit here rather than a silently smaller test run.
    assertEquals(9, seen, "the cross-language contract changed size");
  }

  @Test
  @DisplayName("a broken config reports the error instead of parsing quietly")
  void syntaxErrorsAreReported() {
    // A generator that is never closed. ANTLR would normally print to the console and hand
    // back a best-effort tree; a data generator must not do that.
    TdcParserFacade.Result result =
        TdcParserFacade.parse("<tdc><env mode=\"memory\" count=\"1\"><sequence name=\"A\"><gen type=");
    assertFalse(result.ok(), "a malformed config was accepted");
    assertFalse(result.problems().isEmpty(), "no problem was reported");
  }
}
