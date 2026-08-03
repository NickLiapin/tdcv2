package io.github.nickliapin.tdc.packs;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Where pack files come from.
 *
 * <p>Two places, and both have to work. The library ships every pack inside its own jar so that
 * {@code person.male.firstName} resolves with no configuration at all — a library that needed a
 * data directory pointed at it before it could produce a single name would be a poor library.
 * The other place is a folder on disk, which is how this repository's tests read the same packs
 * the other implementations read, and how a user adds their own.
 */
public interface PackSource {

  /**
   * Whether a directory entry is repository noise rather than a pack.
   *
   * <p>The reference ignores a file's extension entirely when it turns a path into an address, so
   * a name is the only thing that can keep a locale manifest, a README or a {@code .DS_Store} out
   * of the registry — and this is the same short list {@code load.ts} keeps. Everything else is
   * data, whatever it is called.
   */
  static boolean isIgnoredEntry(String name) {
    if (name.equals("_locale.json") || name.startsWith(".")) {
      return true;
    }
    int dot = name.lastIndexOf('.');
    String stem = dot > 0 ? name.substring(0, dot) : name;
    stem = stem.toLowerCase(java.util.Locale.ROOT);
    return stem.equals("readme") || stem.equals("license") || stem.equals("changelog");
  }

  /** Whether a pack exists at this path, e.g. {@code en/person/lastName.txt}. */
  boolean has(String relativePath);

  List<String> readLines(String relativePath);

  /**
   * Every pack file this source can serve, as relative paths.
   *
   * <p>The address index is built from this. A file's header may place it at an address that has
   * nothing to do with its path, and the only way to know is to look inside every file — which is
   * why this exists and why the scan is deferred until a path lookup has already missed.
   */
  List<String> listFiles();

  /**
   * Whether a top-level folder by this name exists — {@code en}, {@code usa}, {@code common}.
   *
   * <p>This is how a dotted address is judged absolute or relative: {@code usa.ssn} names a
   * country pack directly, while {@code person.lastName} is relative to the active locale.
   */
  boolean hasTopLevel(String name);

  /**
   * Whether {@code countries/<name>} exists.
   *
   * <p>The {@code countries/} folder is a physical grouping, not part of an address: a pack at
   * {@code countries/usa/finance/aba_routing.txt} is addressed as {@code usa.finance.aba_routing}.
   * Without this, every country pack would look like a relative address and be searched for
   * under the active locale, where it is not.
   */
  boolean hasCountry(String name);

  /**
   * Where a file physically is, for a complaint that has to name it.
   *
   * <p>A relative path is ambiguous the moment two roots are layered, and "which file did you
   * mean" is the one thing such a message must not leave open. Packs read from inside the jar
   * have no path at all, which is why this can answer {@code null}.
   */
  default String locate(String relativePath) {
    return null;
  }

  /**
   * Several sources searched in order, the last one winning.
   *
   * <p>This is what lets a project's own packs shadow the bundled ones without replacing them: a
   * downloaded or hand-written pack at the same address is found first, and everything else still
   * resolves. The order is low priority to high, so the search runs backwards.
   */
  final class Layered implements PackSource {
    private final List<PackSource> sources;

    public Layered(List<PackSource> sources) {
      this.sources = List.copyOf(sources);
    }

    private PackSource owning(String relativePath) {
      for (int i = sources.size() - 1; i >= 0; i--) {
        if (sources.get(i).has(relativePath)) {
          return sources.get(i);
        }
      }
      return null;
    }

    @Override
    public boolean has(String relativePath) {
      return owning(relativePath) != null;
    }

    @Override
    public List<String> readLines(String relativePath) {
      PackSource source = owning(relativePath);
      if (source == null) {
        throw new IllegalStateException("no pack at " + relativePath);
      }
      return source.readLines(relativePath);
    }

    @Override
    public List<String> listFiles() {
      List<String> out = new ArrayList<>();
      Set<String> seen = new HashSet<>();
      for (PackSource source : sources) {
        for (String path : source.listFiles()) {
          if (seen.add(path)) {
            out.add(path);
          }
        }
      }
      return out;
    }

    @Override
    public boolean hasTopLevel(String name) {
      for (PackSource source : sources) {
        if (source.hasTopLevel(name)) {
          return true;
        }
      }
      return false;
    }

    @Override
    public boolean hasCountry(String name) {
      for (PackSource source : sources) {
        if (source.hasCountry(name)) {
          return true;
        }
      }
      return false;
    }

    @Override
    public String locate(String relativePath) {
      PackSource source = owning(relativePath);
      return source == null ? null : source.locate(relativePath);
    }
  }

  /** Packs from a directory. */
  final class Directory implements PackSource {
    private final Path root;

    public Directory(Path root) {
      this.root = root;
    }

    @Override
    public boolean has(String relativePath) {
      return Files.exists(root.resolve(relativePath));
    }

    @Override
    public List<String> readLines(String relativePath) {
      try {
        return Files.readAllLines(root.resolve(relativePath), StandardCharsets.UTF_8);
      } catch (IOException e) {
        throw new UncheckedIOException("cannot read pack " + root.resolve(relativePath), e);
      }
    }

    @Override
    public List<String> listFiles() {
      if (!Files.isDirectory(root)) {
        return List.of();
      }
      try (java.util.stream.Stream<Path> walk = Files.walk(root)) {
        return walk.filter(Files::isRegularFile)
            .map(path -> root.relativize(path).toString().replace('\\', '/'))
            .filter(path -> java.util.Arrays.stream(path.split("/")).noneMatch(
                PackSource::isIgnoredEntry))
            .sorted()
            .toList();
      } catch (IOException e) {
        throw new UncheckedIOException("cannot list packs under " + root, e);
      }
    }

    @Override
    public boolean hasTopLevel(String name) {
      return Files.isDirectory(root.resolve(name));
    }

    @Override
    public boolean hasCountry(String name) {
      return Files.isDirectory(root.resolve("countries").resolve(name));
    }

    @Override
    public String locate(String relativePath) {
      Path path = root.resolve(relativePath);
      return Files.isRegularFile(path) ? path.toString() : null;
    }

    @Override
    public String toString() {
      return root.toString();
    }
  }

  /** Packs from inside the jar. */
  final class Classpath implements PackSource {
    /** Where the build puts them. */
    static final String PREFIX = "tdc/packs/";

    private final Set<String> index;
    private final Set<String> topLevel;
    private final Set<String> countries;

    public Classpath() {
      // A jar has no directories to list, so the build writes down what it packed. Probing for
      // each candidate instead would make "does the locale `sv` exist?" unanswerable — the only
      // way to find out would be to guess a filename inside it.
      this.index = new HashSet<>(readIndex());
      this.topLevel = new HashSet<>();
      this.countries = new HashSet<>();
      for (String path : index) {
        int slash = path.indexOf('/');
        if (slash > 0) {
          topLevel.add(path.substring(0, slash));
        }
        if (path.startsWith("countries/")) {
          int next = path.indexOf('/', "countries/".length());
          if (next > 0) {
            countries.add(path.substring("countries/".length(), next));
          }
        }
      }
    }

    /**
     * Every pack index on the classpath, merged.
     *
     * <p>Plural on purpose. Java already has a package manager, so the natural way to add packs
     * is another dependency — a jar carrying its own {@code tdc/packs/} tree and its own index.
     * Reading only the first index would make every such jar invisible, and the failure would
     * look like a missing pack rather than a missing feature.
     */
    /**
     * The loader to ask.
     *
     * <p>The thread's context loader when there is one, because that is the application's view of
     * the classpath — in a container or a framework's launcher, the jar this class came from sees
     * a narrower one, and a pack the application added would be invisible from here. Falls back
     * to this class's own loader, which is right for a plain command line and for tests.
     */
    private static ClassLoader loader() {
      ClassLoader context = Thread.currentThread().getContextClassLoader();
      return context != null ? context : Classpath.class.getClassLoader();
    }

    private static List<String> readIndex() {
      List<String> out = new ArrayList<>();
      try {
        java.util.Enumeration<java.net.URL> found = loader().getResources(PREFIX + "index.txt");
        while (found.hasMoreElements()) {
          try (InputStream in = found.nextElement().openStream()) {
            out.addAll(readAll(in));
          }
        }
      } catch (IOException e) {
        throw new UncheckedIOException("cannot read the bundled pack index", e);
      }
      // No index at all means a jar built without packs. Every lookup then fails by name, which
      // is a far better outcome than silently producing rows with empty fields.
      return out;
    }

    @Override
    public boolean has(String relativePath) {
      return index.contains(relativePath);
    }

    @Override
    public List<String> readLines(String relativePath) {
      InputStream in =
          loader().getResourceAsStream(PREFIX + relativePath);
      if (in == null) {
        throw new IllegalArgumentException("bundled pack is missing: " + relativePath);
      }
      return readAll(in);
    }

    @Override
    public List<String> listFiles() {
      List<String> out = new ArrayList<>(index);
      out.sort(null);
      return out;
    }

    @Override
    public boolean hasTopLevel(String name) {
      return topLevel.contains(name);
    }

    @Override
    public boolean hasCountry(String name) {
      return countries.contains(name);
    }

    @Override
    public String toString() {
      return "bundled packs (" + index.size() + " files)";
    }
  }

  private static List<String> readAll(InputStream in) {
    List<String> out = new ArrayList<>();
    try (BufferedReader reader =
        new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        out.add(line);
      }
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read a bundled pack", e);
    }
    return out;
  }
}
