package io.github.nickliapin.tdc.output;

import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Writing a run's output so a failed run leaves the destination as it found it.
 *
 * <p>The output is written to {@code <path>.partial} beside the destination and moved over it only
 * on {@link #commit()}; closed without a commit, the partial file is removed and the destination
 * is untouched. The move is within one directory, so within one filesystem, and therefore atomic: a
 * reader sees the old file or the new one, never half of either.
 *
 * <p>Measured before this class, on all five implementations: a run that failed with {@code -o
 * out.csv} destroyed an existing {@code out.csv} — four truncated it to nothing, one deleted it.
 *
 * <p>A symbolic link is resolved first and its TARGET written, so the link stays a link. A
 * destination that exists and is not a regular file ({@code -o /dev/stdout}, a named pipe) cannot
 * be replaced by a move, so it is written directly, by the name it was given — and so is one whose
 * directory refuses a file beside it ({@code /dev/stdout} redirected to a file resolves to {@code
 * /dev/fd/1}). Both are written exactly as they were before this class.
 */
public final class AtomicFile implements Closeable {
  private final OutputStream out;
  private final Path temp;
  private final Path target;
  private boolean done;

  private AtomicFile(OutputStream out, Path temp, Path target) {
    this.out = out;
    this.temp = temp;
    this.target = target;
  }

  /** The partial file beside a destination. */
  public static Path partialPath(Path path) {
    return path.resolveSibling(path.getFileName() + ".partial");
  }

  /** Open {@code path} for a run's output. */
  public static AtomicFile open(Path path) throws IOException {
    boolean exists = Files.exists(path);
    Path target = exists ? path.toRealPath() : path;
    if (!exists || Files.isRegularFile(target)) {
      Path temp = partialPath(target);
      try {
        return new AtomicFile(Files.newOutputStream(temp), temp, target);
      } catch (IOException e) {
        // No file can be made beside it: written in place, below.
      }
    }
    return new AtomicFile(Files.newOutputStream(path), null, target);
  }

  /** Where the output goes until it is committed. */
  public OutputStream stream() {
    return out;
  }

  /** The finished output takes the destination's place. */
  public void commit() throws IOException {
    out.close();
    done = true;
    if (temp == null) {
      return;
    }
    try {
      Files.move(
          temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (AtomicMoveNotSupportedException e) {
      Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
    }
  }

  /** Without a commit: the partial file goes, and the destination stays as it was. */
  @Override
  public void close() throws IOException {
    if (done) {
      return;
    }
    done = true;
    try {
      out.close();
    } finally {
      if (temp != null) {
        Files.deleteIfExists(temp);
      }
    }
  }
}
