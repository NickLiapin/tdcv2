package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.packs.PackRegistry;
import io.github.nickliapin.tdc.packs.PackStore;
import io.github.nickliapin.tdc.packs.ProjectConfig;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The store's books, and what a bundle is allowed to claim in them.
 *
 * <p>The same cases the reference pins, ported one for one: five implementations write this file
 * and read each other's, so the answers here are a contract rather than this port's opinion.
 */
class PackStoreTest {

  private static PackStore.InstalledBundle entry(String id, String... paths) {
    return new PackStore.InstalledBundle(id, List.of(paths), "", "aa", 2);
  }

  @Test
  @DisplayName("a bundle claims the one subtree it fills")
  void claimsOneSubtree() {
    assertEquals(
        List.of("ru"), PackStore.ownedPaths(List.of("ru/person/lastName.txt", "ru/city/name.txt")));
  }

  @Test
  @DisplayName("a country claims itself, never the shared countries/ folder above it")
  void neverClaimsTheSharedFolder() {
    assertEquals(
        List.of("countries/russia"),
        PackStore.ownedPaths(
            List.of("countries/russia/docs/inn.txt", "countries/russia/tax/x.txt")));
  }

  @Test
  @DisplayName("files that share no parent claim each top-level entry")
  void claimsEachTopLevelEntry() {
    assertEquals(
        List.of("countries", "en"),
        PackStore.ownedPaths(List.of("en/a.txt", "countries/usa/b.txt")));
  }

  @Test
  @DisplayName("a lone file at the root is claimed as itself")
  void claimsALoneFile() {
    assertEquals(List.of("loose.txt"), PackStore.ownedPaths(List.of("loose.txt")));
  }

  @Test
  @DisplayName("a bundle claims no more than it actually fills")
  void underClaimsOnPurpose() {
    // A one-file country stub owns the folder holding that file, not the whole country — the
    // answer follows the files, so removal can never take more than the bundle brought.
    assertEquals(
        List.of("countries/andorra/docs"),
        PackStore.ownedPaths(List.of("countries/andorra/docs/nid.txt")));
  }

  @Test
  @DisplayName("no files, nothing claimed")
  void claimsNothingForNoFiles() {
    assertEquals(List.of(), PackStore.ownedPaths(List.of()));
  }

  @Test
  @DisplayName("a nested path and the root itself are inside; an escaping one is not")
  void guardsZipSlip(@TempDir Path dir) {
    assertTrue(PackStore.isPathInside(dir.resolve("a/b"), dir));
    assertTrue(PackStore.isPathInside(dir, dir));
    assertFalse(PackStore.isPathInside(dir.resolve("../../etc/passwd"), dir));
    assertFalse(PackStore.isPathInside(Path.of("/other"), dir.resolve("a")));
  }

  @Test
  @DisplayName("a missing store is an empty one, not an error")
  void missingStoreIsEmpty(@TempDir Path dir) {
    assertEquals(List.of(), PackStore.installedIds(dir.resolve("nope")));
  }

  @Test
  @DisplayName("the record round-trips through the dotfile, ids sorted")
  void roundTrips(@TempDir Path store) throws IOException {
    PackStore.write(
        store,
        new PackStore.InstalledRecord(
            1, List.of(entry("usa", "countries/usa"), entry("en", "en"))));

    assertEquals(List.of("en", "usa"), PackStore.installedIds(store));
    assertEquals(List.of("en"), PackStore.read(store).bundles().get(0).paths());
    // The name matters: the store is a scan root, and the loader skips ignored NAMES, so anything
    // without a leading dot here would load as a pack.
    assertTrue(PackStore.INSTALLED_FILE.startsWith("."));
    assertTrue(Files.readString(store.resolve(PackStore.INSTALLED_FILE)).endsWith("\n"));
  }

  @Test
  @DisplayName("the record's bytes are the ones every implementation writes")
  void writesTheAgreedBytes(@TempDir Path store) throws IOException {
    PackStore.write(
        store,
        new PackStore.InstalledRecord(
            1, List.of(new PackStore.InstalledBundle("demo", List.of("demo/person"), "", "", 1))));

    assertEquals(
        """
        {
          "schemaVersion": 1,
          "bundles": [
            {
              "id": "demo",
              "paths": [
                "demo/person"
              ],
              "version": "",
              "sha256": "",
              "files": 1
            }
          ]
        }
        """,
        Files.readString(store.resolve(PackStore.INSTALLED_FILE)));
  }

  @Test
  @DisplayName("a tree nobody recorded is not \"installed\"")
  void anUnrecordedTreeIsNotInstalled(@TempDir Path store) throws IOException {
    Files.createDirectories(store.resolve("en/person"));
    assertEquals(List.of(), PackStore.installedIds(store));
  }

  @Test
  @DisplayName("a record claiming a path outside the store is refused")
  void refusesAnEscapingRecord(@TempDir Path store) throws IOException {
    Files.writeString(
        store.resolve(PackStore.INSTALLED_FILE),
        "{\"schemaVersion\":1,\"bundles\":[{\"id\":\"evil\",\"paths\":[\"../../etc\"]}]}");
    assertTrue(
        assertThrows(PackRegistry.PackException.class, () -> PackStore.read(store))
            .getMessage()
            .contains("outside the store"));
  }

  @Test
  @DisplayName("a malformed record is refused rather than reported as an empty store")
  void refusesAMalformedRecord(@TempDir Path store) throws IOException {
    Files.writeString(store.resolve(PackStore.INSTALLED_FILE), "{ not json");
    assertThrows(PackRegistry.PackException.class, () -> PackStore.read(store));
  }

  @Test
  @DisplayName("a record from a newer tdcv2 is refused")
  void refusesANewerRecord(@TempDir Path store) throws IOException {
    Files.writeString(
        store.resolve(PackStore.INSTALLED_FILE), "{\"schemaVersion\":2,\"bundles\":[]}");
    assertTrue(
        assertThrows(PackRegistry.PackException.class, () -> PackStore.read(store))
            .getMessage()
            .contains("newer tdcv2"));
  }

  @Test
  @DisplayName("with() replaces the same id; without() drops it")
  void replacesAndDrops() {
    PackStore.InstalledRecord one =
        PackStore.with(new PackStore.InstalledRecord(1, List.of()), entry("en", "en"));
    PackStore.InstalledRecord again =
        PackStore.with(one, new PackStore.InstalledBundle("en", List.of("en"), "", "aa", 9));

    assertEquals(1, again.bundles().size());
    assertEquals(9, again.bundles().get(0).files());
    assertEquals(List.of(), PackStore.without(again, "en").bundles());
    assertNull(PackStore.find(PackStore.without(again, "en"), "en"));
  }

  // ── the config's data paths ────────────────────────────────────────────────────────────────

  @Test
  @DisplayName("the per-bundle entries go; the store and everything outside it stay")
  void dropsThePerBundleEntries(@TempDir Path dir) throws IOException {
    Path config = dir.resolve("tdcv2.config.json");
    Files.writeString(
        config,
        "{\"packStore\":\"./p\","
            + "\"dataPaths\":[\"./p/en/packs\",\"./p/usa/packs\",\"./p\",\"./my-own-lists\"]}");

    assertEquals(2, ProjectConfig.removeDataPathsInside(config, dir.resolve("p")));
    // Read as bytes rather than through the cascade: the cascade would fold in whatever global
    // config the machine running the tests happens to have.
    assertEquals(
        """
        {
          "packStore": "./p",
          "dataPaths": [
            "./p",
            "./my-own-lists"
          ]
        }
        """,
        Files.readString(config));
  }

  @Test
  @DisplayName("a config with nothing inside the store is left alone")
  void keepsAConfigThatNeedsNothing(@TempDir Path dir) throws IOException {
    Path config = dir.resolve("tdcv2.config.json");
    String before = "{\"packStore\":\"./p\",\"dataPaths\":[\"./elsewhere\"]}";
    Files.writeString(config, before);

    assertEquals(0, ProjectConfig.removeDataPathsInside(config, dir.resolve("p")));
    assertEquals(before, Files.readString(config));
  }
}
