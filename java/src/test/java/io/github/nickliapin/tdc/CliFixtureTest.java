package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.cli.Init;
import io.github.nickliapin.tdc.cli.Main;
import io.github.nickliapin.tdc.cli.Pack;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The shared CLI fixture, run against this implementation.
 *
 * <p>{@code fixtures/cross-language/cli.json} is the command line's contract, and the other two
 * implementations run the same file. Tests written separately for each language can agree with
 * themselves and still disagree with each other; this is the only kind that cannot.
 */
class CliFixtureTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final JsonNode DOCUMENT = load();

  private static JsonNode load() {
    Path fixtures = Path.of(System.getProperty("tdc.fixtures", "../fixtures"));
    try {
      return MAPPER.readTree(Files.readString(fixtures.resolve("cross-language/cli.json")));
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read the shared CLI fixture", e);
    }
  }

  /** A case runs here unless it names implementations and this is not one of them. */
  private static boolean appliesHere(JsonNode testCase) {
    JsonNode only = testCase.get("only");
    if (only == null) {
      return true;
    }
    for (JsonNode name : only) {
      if ("java".equals(name.asText())) {
        return true;
      }
    }
    return false;
  }

  static Stream<JsonNode> cases() {
    List<JsonNode> out = new ArrayList<>();
    for (JsonNode testCase : DOCUMENT.get("cases")) {
      if (appliesHere(testCase)) {
        out.add(testCase);
      }
    }
    return out.stream();
  }

  private final ByteArrayOutputStream out = new ByteArrayOutputStream();
  private final ByteArrayOutputStream err = new ByteArrayOutputStream();
  private PrintStream originalOut;
  private PrintStream originalErr;

  @BeforeEach
  void captureStreams() {
    originalOut = System.out;
    originalErr = System.err;
    System.setOut(new PrintStream(out, true, StandardCharsets.UTF_8));
    System.setErr(new PrintStream(err, true, StandardCharsets.UTF_8));
  }

  @AfterEach
  void restoreStreams() {
    System.setOut(originalOut);
    System.setErr(originalErr);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  void fixtureCase(JsonNode testCase, @TempDir Path dir) throws IOException {
    String registry = testCase.path("registry").asBoolean() ? buildRegistry(dir.resolve("registry")) : null;

    JsonNode files = testCase.get("files");
    if (files != null) {
      Iterator<Map.Entry<String, JsonNode>> entries = files.fields();
      while (entries.hasNext()) {
        Map.Entry<String, JsonNode> entry = entries.next();
        String contents = entry.getValue().asText();
        // A leading @ names one of the shared configs, so a config used by three cases is written
        // once and cannot drift between them.
        String body =
            contents.startsWith("@")
                ? DOCUMENT.get("configs").get(contents.substring(1)).asText()
                : contents;
        Path target = dir.resolve(entry.getKey());
        Files.createDirectories(target.getParent());
        Files.writeString(target, body, StandardCharsets.UTF_8);
      }
    }

    List<String> argv = new ArrayList<>();
    for (JsonNode arg : testCase.get("argv")) {
      argv.add(resolve(arg.asText(), dir, registry));
    }

    // `init` and `pack` act on a working directory rather than on a named file, so the fixture
    // hands them the temp directory — a JVM cannot change its own.
    String command = testCase.path("command").asText("main");
    int code =
        switch (command) {
          case "init" -> Init.run(argv, dir);
          case "pack" -> Pack.run(argv, dir);
          default -> Main.run(argv);
        };

    String stdout = out.toString(StandardCharsets.UTF_8);
    String stderr = err.toString(StandardCharsets.UTF_8);
    assertEquals(testCase.get("exit").asInt(), code, "exit code; stderr was:\n" + stderr);

    if (testCase.has("stderr")) {
      assertEquals(resolve(testCase.get("stderr").asText(), dir, registry), stderr);
    }
    if (testCase.has("stdout")) {
      assertEquals(testCase.get("stdout").asText(), stdout);
    }
    for (JsonNode fragment : testCase.path("stdoutContains")) {
      assertTrue(stdout.contains(resolve(fragment.asText(), dir, registry)), stdout);
    }
    if (testCase.has("stdoutMatches")) {
      assertTrue(
          Pattern.compile(testCase.get("stdoutMatches").asText(), Pattern.MULTILINE)
              .matcher(stdout)
              .find(),
          stdout);
    }
    for (JsonNode fragment : testCase.path("stderrContains")) {
      assertTrue(stderr.contains(resolve(fragment.asText(), dir, registry)), stderr);
    }

    JsonNode wrote = testCase.get("wrote");
    if (wrote != null) {
      Iterator<Map.Entry<String, JsonNode>> entries = wrote.fields();
      while (entries.hasNext()) {
        Map.Entry<String, JsonNode> entry = entries.next();
        assertEquals(entry.getValue().asText(), Files.readString(dir.resolve(entry.getKey())));
      }
    }
    JsonNode wroteContains = testCase.get("wroteContains");
    if (wroteContains != null) {
      Iterator<Map.Entry<String, JsonNode>> entries = wroteContains.fields();
      while (entries.hasNext()) {
        Map.Entry<String, JsonNode> entry = entries.next();
        String written = Files.readString(dir.resolve(entry.getKey()));
        for (JsonNode fragment : entry.getValue()) {
          assertTrue(written.contains(fragment.asText()), written);
        }
      }
    }
  }

  private static String resolve(String text, Path dir, String registry) {
    String result =
        text.replace("{dir}", dir.toString())
            .replace("{version}", io.github.nickliapin.tdc.cli.Main.VERSION);
    return registry == null ? result : result.replace("{registry}", registry);
  }

  /** The demo registry every implementation's runner builds, byte for byte the same. */
  private static String buildRegistry(Path root) throws IOException {
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(buffer)) {
      zip.putNextEntry(new ZipEntry("demo/packs/demo/person/lastName.txt"));
      zip.write("Ivanov\nPetrov\n".getBytes(StandardCharsets.UTF_8));
      zip.closeEntry();
    }
    byte[] data = buffer.toByteArray();

    Files.createDirectories(root.resolve("bundles"));
    Files.write(root.resolve("bundles/demo.zip"), data);
    Files.writeString(
        root.resolve("index.json"),
        """
        {
          "schemaVersion": 1,
          "bundles": [{
            "id": "demo", "name": "Demo pack", "description": "two surnames",
            "file": "bundles/demo.zip", "bytes": %d,
            "sha256": "%s", "locale": "demo"
          }]
        }
        """
            .formatted(data.length, sha256(data)));

    // A second, deliberately broken registry beside the honest one: the same archive, advertised
    // at a size it does not have. It lives under its own path so the honest catalogue — which
    // cases assert byte for byte — keeps listing exactly one bundle.
    Files.createDirectories(root.resolve("broken/bundles"));
    Files.write(root.resolve("broken/bundles/demo.zip"), data);
    Files.writeString(
        root.resolve("broken/index.json"),
        """
        {
          "schemaVersion": 1,
          "bundles": [{
            "id": "demo", "name": "Demo pack", "description": "two surnames",
            "file": "bundles/demo.zip", "bytes": %d,
            "sha256": "%s", "locale": "demo"
          }]
        }
        """
            .formatted(data.length + 999, sha256(data)));
    return root.toUri().toString();
  }

  private static String sha256(byte[] data) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  @Test
  void theFixtureIsNotEmpty() {
    // A runner that silently found nothing would pass every implementation.
    assertTrue(cases().count() >= 25, "only " + cases().count() + " cases ran");
    List<String> names = new ArrayList<>();
    for (JsonNode testCase : DOCUMENT.get("cases")) {
      assertFalse(names.contains(testCase.get("name").asText()), "duplicate case name");
      names.add(testCase.get("name").asText());
    }
  }

  @Test
  void nothingIsSkipped() {
    // Every case runs here unless it NAMES the implementations it runs in and
    // this port is not among them — the reference moving ahead of the ports,
    // recorded in the fixture rather than deleted from it. Anything else
    // failing to run would still fail here.
    long skipped = 0;
    for (JsonNode testCase : DOCUMENT.get("cases")) {
      if (!appliesHere(testCase)) {
        skipped++;
      }
    }
    assertEquals(DOCUMENT.get("cases").size() - skipped, cases().count());
  }
}
