package io.github.nickliapin.tdc.output;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A run's output reaches its destination whole, or not at all.
 *
 * <p>The shared CLI fixture pins what matters most — a failed run leaves the previous file byte
 * for byte, for text, Parquet and a parallel run. These pin the edges a config cannot reach: a
 * link stays a link, a device is written in place, and closing without a commit takes the partial
 * file with it.
 */
class AtomicFileTest {
  @TempDir Path dir;

  @Test
  void replacesTheDestinationOnlyOnCommit() throws IOException {
    Path out = dir.resolve("out.csv");
    Files.writeString(out, "old\n");
    try (AtomicFile file = AtomicFile.open(out)) {
      file.stream().write("new\n".getBytes(StandardCharsets.UTF_8));
      assertEquals("old\n", Files.readString(out));
      assertTrue(Files.exists(AtomicFile.partialPath(out)));
      file.commit();
    }
    assertEquals("new\n", Files.readString(out));
    assertFalse(Files.exists(AtomicFile.partialPath(out)));
  }

  @Test
  void closedWithoutACommitLeavesTheDestinationAndNoPartialFile() throws IOException {
    Path out = dir.resolve("out.csv");
    Files.writeString(out, "old\n");
    try (AtomicFile file = AtomicFile.open(out)) {
      file.stream().write("half of a ".getBytes(StandardCharsets.UTF_8));
    }
    assertEquals("old\n", Files.readString(out));
    assertFalse(Files.exists(AtomicFile.partialPath(out)));
  }

  @Test
  void writesThroughASymbolicLinkWhichStaysALink() throws IOException {
    Path real = dir.resolve("real.csv");
    Path link = dir.resolve("link.csv");
    Files.writeString(real, "old\n");
    Files.createSymbolicLink(link, real);
    try (AtomicFile file = AtomicFile.open(link)) {
      file.stream().write("new\n".getBytes(StandardCharsets.UTF_8));
      file.commit();
    }
    assertTrue(Files.isSymbolicLink(link));
    assertEquals("new\n", Files.readString(real));
  }

  @Test
  void writesADeviceInPlace() throws IOException {
    try (AtomicFile file = AtomicFile.open(Path.of("/dev/null"))) {
      file.stream().write('x');
      file.commit();
    }
  }
}
