package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.cli.Pack;
import io.github.nickliapin.tdc.packs.Json;
import io.github.nickliapin.tdc.packs.PackRegistry;
import io.github.nickliapin.tdc.packs.PackStore;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Upgrading a store that was written by an older tdcv2.
 *
 * <p>Before the flat store, {@code pack add} unpacked to {@code <store>/<id>/packs/…} and wrote one
 * {@code dataPaths} entry per bundle. Anyone who installed a pack has that on disk and in their
 * config, and neither {@code list} nor {@code remove} can read it any more — so the first {@code
 * tdcv2 pack} after the upgrade has to move it, in place, and say so. These tests are the ones that
 * stand between an existing user and a store they would have to delete and download again.
 */
class PackMigrateTest {

  private final ByteArrayOutputStream err = new ByteArrayOutputStream();
  private PrintStream originalOut;
  private PrintStream originalErr;
  private ByteArrayOutputStream out = new ByteArrayOutputStream();

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

  /**
   * A project as the old {@code pack add ru russia} left it: two bundle folders, each with its own
   * {@code packs/} root, and two {@code dataPaths} entries pointing inside them.
   */
  private static Path oldProject(Path dir, Map<String, String> extra) throws IOException {
    Path store = dir.resolve("tdcv2-packs");
    put(store.resolve("ru/packs/ru/person/lastName.txt"), "---\nlocale: ru\n---\nИванов\n");
    put(store.resolve("ru/packs/ru/city/name.txt"), "---\nlocale: ru\n---\nОмск\n");
    put(store.resolve("ru/packs/ru/_locale.json"), "{\"code\":\"ru\"}\n");
    put(
        store.resolve("russia/packs/countries/russia/docs/inn.txt"),
        "---\naddress: russia.docs.inn\n---\n7707083893\n");
    put(
        store.resolve("russia/packs/countries/russia/bank/bic.txt"),
        "---\naddress: russia.bank.bic\n---\n044525225\n");
    for (Map.Entry<String, String> file : extra.entrySet()) {
      put(store.resolve(file.getKey()), file.getValue());
    }
    put(
        dir.resolve("tdcv2.config.json"),
        """
        {
          "packStore": "./tdcv2-packs",
          "locale": "ru",
          "dataPaths": [
            "./tdcv2-packs/ru/packs",
            "./tdcv2-packs/russia/packs"
          ],
          "keepThis": true
        }
        """);
    return store;
  }

  private static void put(Path path, String body) throws IOException {
    Files.createDirectories(path.getParent());
    Files.writeString(path, body, StandardCharsets.UTF_8);
  }

  private static List<String> ownedPathsOf(PackStore.InstalledRecord record) {
    List<String> out = new ArrayList<>();
    for (PackStore.InstalledBundle bundle : record.bundles()) {
      out.add(bundle.id() + "=" + String.join(",", bundle.paths()));
    }
    return out;
  }

  @Test
  @DisplayName("the old layout is recognised, and a flat store is left alone")
  void recognisesTheOldLayout(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of());
    assertEquals(List.of("ru", "russia"), PackStore.legacyBundleIds(store));

    Path flat = dir.resolve("flat");
    Files.createDirectories(flat.resolve("ru"));
    assertEquals(List.of(), PackStore.legacyBundleIds(flat));
  }

  @Test
  @DisplayName("each tree moves up, is recorded, and leaves one dataPaths entry")
  void movesRecordsAndRegisters(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of());
    Path config = dir.resolve("tdcv2.config.json");

    PackStore.Migration migration = PackStore.migrate(store, config);
    assertTrue(migration != null);

    // On disk: the address path and nothing above it.
    assertTrue(Files.readString(store.resolve("ru/person/lastName.txt")).contains("Иванов"));
    assertTrue(Files.exists(store.resolve("ru/_locale.json"))); // travels with its locale
    assertTrue(Files.exists(store.resolve("countries/russia/docs/inn.txt")));
    assertFalse(Files.exists(store.resolve("ru/packs")));
    assertFalse(Files.exists(store.resolve("russia")));

    // In the books: who owns what.
    PackStore.InstalledRecord record = PackStore.read(store);
    assertEquals(List.of("ru=ru", "russia=countries/russia"), ownedPathsOf(record));
    // Nothing to claim about an archive nobody kept.
    assertEquals("", record.bundles().get(0).sha256());
    assertEquals(3, record.bundles().get(0).files());

    // In the config: two per-bundle entries out, the store in, everything else kept.
    assertEquals(List.of("./tdcv2-packs"), dataPathsOf(config));
    String written = Files.readString(config);
    assertTrue(written.contains("\"keepThis\": true"), written);
    assertTrue(written.contains("\"locale\": \"ru\""), written);
    assertEquals(2, migration.droppedDataPaths());
    assertEquals("./tdcv2-packs", migration.registered());
  }

  @Test
  @DisplayName("the second run has nothing to do")
  void isANoOpTheSecondTime(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of());
    Path config = dir.resolve("tdcv2.config.json");
    PackStore.migrate(store, config);
    assertNull(PackStore.migrate(store, config));
  }

  @Test
  @DisplayName("files that were never pack data stay where they are, and are named")
  void leavesLeftoversAlone(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of("ru/sources/lastName.csv", "Иванов,100\n"));
    PackStore.Migration migration = PackStore.migrate(store, dir.resolve("tdcv2.config.json"));

    assertEquals(List.of("ru/sources/lastName.csv"), migration.leftovers());
    assertTrue(Files.exists(store.resolve("ru/sources/lastName.csv")));
    assertTrue(Files.exists(store.resolve("ru/person/lastName.txt")));
  }

  @Test
  @DisplayName("a taken destination refuses the whole move, having moved nothing")
  void refusesOnACollision(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of());
    Path config = dir.resolve("tdcv2.config.json");
    // Something already sits where `ru` has to land.
    put(store.resolve("ru/person/lastName.txt"), "somebody else\n");

    assertTrue(
        assertThrows(PackRegistry.PackException.class, () -> PackStore.migrate(store, config))
            .getMessage()
            .contains("collide"));

    // The old tree is untouched, so the user can look and decide.
    assertTrue(Files.exists(store.resolve("ru/packs/ru/person/lastName.txt")));
    assertEquals("somebody else\n", Files.readString(store.resolve("ru/person/lastName.txt")));
    assertEquals(
        List.of("./tdcv2-packs/ru/packs", "./tdcv2-packs/russia/packs"), dataPathsOf(config));
  }

  @Test
  @DisplayName("`tdcv2 pack` migrates before it does anything else, and reports on stderr")
  void migratesBeforeTheCommand(@TempDir Path dir) throws IOException {
    Path store = oldProject(dir, Map.of());

    assertEquals(0, Pack.run(List.of("remove", "russia"), dir));

    String stderr = err.toString(StandardCharsets.UTF_8);
    assertTrue(stderr.contains("used the old per-bundle layout"), stderr);
    assertTrue(stderr.contains("ru: ru/packs → ru (3 files)"), stderr);
    assertTrue(stderr.contains("dropped 2 per-bundle dataPaths entries"), stderr);

    // And the removal that followed acted on the migrated store.
    assertFalse(Files.exists(store.resolve("countries")));
    assertTrue(Files.exists(store.resolve("ru/person/lastName.txt")));
    assertEquals(List.of("ru"), PackStore.installedIds(store));
    assertEquals(List.of("./tdcv2-packs"), dataPathsOf(dir.resolve("tdcv2.config.json")));
  }

  /**
   * A config's {@code dataPaths} exactly as they are written.
   *
   * <p>Read as bytes rather than through the cascade, which would fold in whatever global config
   * the machine running the tests happens to have.
   */
  private static List<String> dataPathsOf(Path config) throws IOException {
    Object parsed = Json.parse(Files.readString(config, StandardCharsets.UTF_8));
    List<String> out = new ArrayList<>();
    for (Object entry : (List<?>) ((Map<?, ?>) parsed).get("dataPaths")) {
      out.add(String.valueOf(entry));
    }
    return out;
  }
}
