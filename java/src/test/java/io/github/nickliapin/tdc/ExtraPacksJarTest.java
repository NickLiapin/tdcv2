package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.packs.DataPacks;
import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A second jar of packs on the classpath, found the way Java finds anything else.
 *
 * <p>Java already has a package manager. Adding a locale should therefore be a dependency, not a
 * separate command-line tool that downloads files into a folder — and certainly not one written
 * in another language. This is what makes that possible: the pack index is read from EVERY jar
 * that carries one, so an extra artifact simply adds to what resolves.
 */
class ExtraPacksJarTest {

  @Test
  @DisplayName("packs in a second jar resolve alongside the bundled ones")
  void findsPacksInAnotherJar(@TempDir Path dir) throws Exception {
    Path jar = dir.resolve("tdcv2-packs-xx.jar");
    try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(jar))) {
      // The same layout the build produces: a tree of packs plus the index that names them.
      write(out, "tdc/packs/index.txt", "xx/person/firstName.txt\n");
      write(out, "tdc/packs/xx/person/firstName.txt", "Ilmatar\nVäinö\n");
    }

    ClassLoader withExtra =
        new URLClassLoader(new URL[] {jar.toUri().toURL()}, getClass().getClassLoader());
    ClassLoader original = Thread.currentThread().getContextClassLoader();
    try {
      Thread.currentThread().setContextClassLoader(withExtra);
      DataPacks packs = DataPacks.bundled();

      assertEquals(
          java.util.List.of("Ilmatar", "Väinö"),
          packs.load("person.firstName", "xx").values(),
          "the added jar's pack should resolve");
      // And nothing is lost: the jar this library ships in still answers for everything it did.
      assertTrue(packs.exists("person.male.firstName", "en"), "the bundled packs should still resolve");
    } finally {
      Thread.currentThread().setContextClassLoader(original);
    }
  }

  private static void write(JarOutputStream out, String name, String body) throws IOException {
    out.putNextEntry(new JarEntry(name));
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    out.write(bytes, 0, bytes.length);
    out.closeEntry();
  }
}
