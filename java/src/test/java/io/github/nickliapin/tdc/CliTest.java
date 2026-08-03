package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.cli.Args;
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
import java.util.HexFormat;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The command line: what it accepts, what it writes, and what it exits with.
 *
 * <p>The exit code is part of the contract — a CI job branches on it — so every case asserts one.
 * The registry tests run against a zip on disk served over {@code file://} rather than the real
 * one: a test that needs the network is a test that fails on a train.
 */
class CliTest {

  private static final String CONFIG =
      """
      <tdc>
        <env count="3" seed="cli" local="en">
          <sequence name="Id"><gen type="increment" value="1"/></sequence>
          <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
        </env>
        <block>
          <line><data>${{Id}},${{Name}}</data></line>
        </block>
      </tdc>
      """;

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

  private String stdout() {
    return out.toString(StandardCharsets.UTF_8);
  }

  private String stderr() {
    return err.toString(StandardCharsets.UTF_8);
  }

  private static Path writeConfig(Path directory, String body) {
    try {
      Path path = directory.resolve("run.tdc");
      Files.writeString(path, body, StandardCharsets.UTF_8);
      return path;
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  // ── arguments ──────────────────────────────────────────────────────────────────────────────

  @Test
  void aBareFileIsTheInput() {
    assertEquals("users.tdc", Args.parse(List.of("users.tdc")).input());
  }

  /**
   * {@code --engine=2} and {@code --stream} are what the TypeScript CLI accepts; a config or a
   * script written against it has to keep working here.
   */
  @ParameterizedTest
  @ValueSource(strings = {"--engine 2", "--engine=2", "--stream"})
  void engineTwoHasSeveralSpellings(String flags) {
    List<String> argv = new java.util.ArrayList<>(List.of(flags.split(" ")));
    argv.add("x.tdc");
    assertEquals(2, Args.parse(argv).engine());
  }

  @Test
  void dataPathAccumulates() {
    Args.Options options =
        Args.parse(List.of("--data-path", "a", "--data-path=b", "x.tdc"));
    assertEquals(List.of("a", "b"), options.dataPaths());
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "--nope x.tdc",
        "--engine 9 x.tdc",
        "--mode sideways x.tdc",
        "--count -3 x.tdc",
        "--count many x.tdc",
        "--jobs 0 x.tdc",
        "--seed",
        "a.tdc b.tdc"
      })
  void refusesWhatItCannotObey(String flags) {
    assertThrows(Args.UsageException.class, () -> Args.parse(List.of(flags.split(" "))));
  }

  // ── generating ─────────────────────────────────────────────────────────────────────────────

  @Test
  void writesToStdout(@TempDir Path dir) {
    Path config = writeConfig(dir, CONFIG);
    assertEquals(0, Main.run(List.of(config.toString())));
    assertEquals(List.of("1,James", "2,Robert", "3,John"), stdout().lines().toList());
  }

  @Test
  void writesToAFile(@TempDir Path dir) throws IOException {
    Path config = writeConfig(dir, CONFIG);
    Path target = dir.resolve("out.csv");
    assertEquals(0, Main.run(List.of(config.toString(), "-o", target.toString())));
    assertEquals(List.of("1,James", "2,Robert", "3,John"), Files.readAllLines(target));
    assertEquals("", stdout());
  }

  @Test
  void countOverridesTheConfig(@TempDir Path dir) {
    Path config = writeConfig(dir, CONFIG);
    assertEquals(0, Main.run(List.of(config.toString(), "--count", "1")));
    assertEquals("1,James", stdout().strip());
  }

  @Test
  void aMissingFileIsAnErrorNotACrash(@TempDir Path dir) {
    assertEquals(1, Main.run(List.of(dir.resolve("nope.tdc").toString())));
    assertTrue(stderr().contains("tdcv2:"));
  }

  @Test
  void anInvalidConfigReportsItsCode(@TempDir Path dir) {
    Path config =
        writeConfig(dir, CONFIG.replace("person.male.firstName", "nosuch.path.at.all"));
    assertEquals(1, Main.run(List.of(config.toString())));
    assertTrue(stderr().contains("TDC071"), stderr());
  }

  @Test
  void noInputIsAUsageError() {
    assertEquals(2, Main.run(List.of()));
    assertTrue(stderr().contains("input file is required"));
  }

  @Test
  void helpAndVersionSucceed() {
    assertEquals(0, Main.run(List.of("--help")));
    assertTrue(stdout().contains("The Data Constructor"));
    assertEquals(0, Main.run(List.of("--version")));
    assertTrue(stdout().contains("tdcv2 "));
  }

  // ── check ──────────────────────────────────────────────────────────────────────────────────

  @Test
  void checkSaysAValidConfigIsValid(@TempDir Path dir) {
    Path config = writeConfig(dir, CONFIG);
    assertEquals(0, Main.run(List.of("check", config.toString())));
    assertTrue(stderr().contains("is valid"));
    // Nothing on stdout: `check` is for a hook, and a hook's stdout is noise.
    assertEquals("", stdout());
  }

  @Test
  void checkReportsAnInvalidConfig(@TempDir Path dir) {
    Path config =
        writeConfig(dir, CONFIG.replace("person.male.firstName", "nosuch.path.at.all"));
    assertEquals(1, Main.run(List.of("check", config.toString())));
    assertTrue(stderr().contains("TDC071"));
  }

  // ── init ───────────────────────────────────────────────────────────────────────────────────

  @Test
  void initWritesAProjectConfig(@TempDir Path dir) throws IOException {
    assertEquals(0, Init.run(List.of("--yes"), dir));
    String written = Files.readString(dir.resolve("tdcv2.config.json"));
    // The store is stored RELATIVE, so the file survives being checked into git.
    assertTrue(written.contains("\"packStore\": \"./tdcv2-packs\""), written);
    assertTrue(written.contains("\"locale\": \"en\""), written);
    assertTrue(Files.isDirectory(dir.resolve("tdcv2-packs")));
  }

  @Test
  void initHonoursTheLocaleFlag(@TempDir Path dir) throws IOException {
    assertEquals(0, Init.run(List.of("--yes", "--locale", "ru"), dir));
    assertTrue(Files.readString(dir.resolve("tdcv2.config.json")).contains("\"locale\": \"ru\""));
  }

  @Test
  void initRefusesToClobber(@TempDir Path dir) {
    Init.run(List.of("--yes"), dir);
    assertEquals(2, Init.run(List.of("--yes"), dir));
    assertTrue(stderr().contains("already exists"));
  }

  @Test
  void initForceOverwrites(@TempDir Path dir) throws IOException {
    Init.run(List.of("--yes"), dir);
    assertEquals(0, Init.run(List.of("--yes", "--force", "--locale", "de"), dir));
    assertTrue(Files.readString(dir.resolve("tdcv2.config.json")).contains("\"locale\": \"de\""));
  }

  @Test
  void initRejectsAnUnknownFlag(@TempDir Path dir) {
    assertEquals(2, Init.run(List.of("--sideways"), dir));
    assertTrue(stderr().contains("unknown option for init"));
  }

  // ── pack ───────────────────────────────────────────────────────────────────────────────────

  /** A registry on disk, served over {@code file://}. Same shape as the real one. */
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
  void packWithoutAConfigSaysToRunInit(@TempDir Path dir) {
    assertEquals(2, Pack.run(List.of("list"), dir));
    assertTrue(stderr().contains("run `tdcv2 init` first"), stderr());
  }

  @Test
  void packLifecycle(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    String url = buildRegistry(Files.createDirectories(dir.resolve("registry")));
    Init.run(List.of("--yes"), project);
    out.reset();

    assertEquals(0, Pack.run(List.of("list", "--registry=" + url), project));
    assertTrue(stdout().contains("demo"));

    assertEquals(0, Pack.run(List.of("add", "demo", "--registry=" + url), project));
    // One entry, naming the store itself — the bundle no longer has a folder of its own.
    String registered = Files.readString(project.resolve("tdcv2.config.json"));
    assertTrue(registered.contains("\"./tdcv2-packs\""), registered);
    assertTrue(Files.isRegularFile(project.resolve("tdcv2-packs/demo/person/lastName.txt")));

    out.reset();
    assertEquals(0, Pack.run(List.of("list", "--registry=" + url), project));
    assertTrue(stdout().contains("installed"));

    assertEquals(0, Pack.run(List.of("remove", "demo"), project));
    // The last bundle out takes the store's registration with it.
    assertTrue(
        Files.readString(project.resolve("tdcv2.config.json")).contains("\"dataPaths\": []"),
        Files.readString(project.resolve("tdcv2.config.json")));
    assertFalse(Files.exists(project.resolve("tdcv2-packs/demo")));
  }

  @Test
  void anInstalledPackIsUsable(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    String url = buildRegistry(Files.createDirectories(dir.resolve("registry")));
    Init.run(List.of("--yes"), project);
    Pack.run(List.of("add", "demo", "--registry=" + url), project);
    out.reset();

    Path config =
        writeConfig(
            project,
            """
            <tdc><env count="2" seed="s" local="en">
            <sequence name="L"><gen type="template" value="demo.person.lastName"/></sequence>
            </env><block><line><data>${{L}}</data></line></block></tdc>
            """);
    assertEquals(0, Main.run(List.of(config.toString())), stderr());
    stdout().lines().forEach(line -> assertTrue(line.equals("Ivanov") || line.equals("Petrov")));
  }

  @Test
  void anUnknownBundleListsWhatThereIs(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    String url = buildRegistry(Files.createDirectories(dir.resolve("registry")));
    Init.run(List.of("--yes"), project);

    assertEquals(2, Pack.run(List.of("add", "nosuch", "--registry=" + url), project));
    assertTrue(stderr().contains("Available: demo"), stderr());
  }

  @Test
  void aTamperedArchiveIsRefused(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    Path registry = Files.createDirectories(dir.resolve("registry"));
    String url = buildRegistry(registry);
    // The bytes change, the published digest does not. Data quietly altered on the way would
    // produce a dataset nobody could tell was wrong, so it must not install.
    Files.write(registry.resolve("bundles/demo.zip"), "not a zip at all".getBytes(StandardCharsets.UTF_8));
    Init.run(List.of("--yes"), project);

    assertEquals(2, Pack.run(List.of("add", "demo", "--registry=" + url), project));
    assertTrue(stderr().contains("bytes"), stderr());
    assertFalse(Files.exists(project.resolve("tdcv2-packs/demo")));
  }

  @Test
  void removingSomethingAbsentIsACleanNoOp(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    Init.run(List.of("--yes"), project);

    // Exit 0, not 1: `remove` is asked for to reach a state, and that state already holds.
    assertEquals(0, Pack.run(List.of("remove", "demo"), project));
    assertTrue(stderr().contains("nothing to remove"));
  }

  @Test
  void anUnknownSubcommandIsAUsageError(@TempDir Path dir) throws IOException {
    Path project = Files.createDirectories(dir.resolve("project"));
    Init.run(List.of("--yes"), project);

    assertEquals(2, Pack.run(List.of("frobnicate"), project));
    assertTrue(stderr().contains("unknown pack command"));
  }
}
