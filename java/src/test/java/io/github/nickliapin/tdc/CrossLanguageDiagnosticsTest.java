package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.parser.TdcParserFacade;
import io.github.nickliapin.tdc.validator.Validator;
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
 * The shared diagnostic cases: the same config must be refused, or accepted, the same way.
 *
 * <p>Compared: the severity, the stable code, and where the diagnostic points. Not the wording —
 * a message is edited for clarity over time, and holding two implementations to a sentence would
 * make every improvement a breaking change.
 *
 * <p>The position is part of the contract because it is what an editor underlines. A port that
 * reports the right code at the wrong place has not told the user what is wrong with their
 * config; it has told them which file to go looking in.
 */
class CrossLanguageDiagnosticsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path dir() {
    String fixtures = System.getProperty("tdc.fixtures");
    assertTrue(fixtures != null && !fixtures.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(fixtures).resolve("cross-language/diagnostics");
  }

  private static Stream<Arguments> cases() throws IOException {
    List<Arguments> out = new ArrayList<>();
    try (Stream<Path> files = Files.list(dir())) {
      for (Path file : files.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
        JsonNode doc = JSON.readTree(Files.readString(file));
        for (JsonNode node : doc.get("cases")) {
          out.add(
              Arguments.of(
                  file.getFileName().toString().replace(".json", "") + " / " + node.get("name").asText(),
                  node));
        }
      }
    }
    assertTrue(!out.isEmpty(), "no diagnostic cases found in " + dir());
    return out.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @DisplayName("reports the same diagnostics as the reference")
  void matchesTheReference(String name, JsonNode node) {
    List<String> want = new ArrayList<>();
    for (JsonNode line : node.get("expected")) {
      want.add(line.asText());
    }

    TdcParserFacade.Result parsed = TdcParserFacade.parse(node.get("config").asText());
    List<String> got = new ArrayList<>();
    if (!parsed.ok()) {
      // A parse error stops the run: there is no tree to validate, and the parser's own
      // complaint is the only honest thing to report.
      for (var problem : parsed.problems()) {
        got.add("error PARSE " + problem.line() + ":" + problem.column());
      }
    } else {
      // A case may need a real file on disk — TDC062 is about a CSV column that is not in
      // the header, and there is no way to say that without a header for it to be absent
      // from. `dataPath` names a folder beside the fixtures, spelled as the rendering cases
      // spell it.
      Path baseDir =
          node.hasNonNull("dataPath") ? dir().resolve(node.get("dataPath").asText()) : null;
      for (Diagnostic d : Validator.validate(
          parsed.tree(), baseDir, io.github.nickliapin.tdc.packs.DataPacks.bundled())) {
        got.add(d.signature());
      }
    }

    assertEquals(want, got, name + ": " + node.get("description").asText());
  }
}
