package io.github.nickliapin.tdc.packs;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * The pack store's own books, and the moves that keep them true.
 *
 * <p>Bundles are axis-pure — one language ({@code en}), or one country ({@code usa}), or {@code
 * common} — because language and country are independent dimensions that compose (US English =
 * common + en + usa). They all unpack into ONE tree:
 *
 * <pre>
 *   &lt;store&gt;/.tdcv2-installed.json
 *   &lt;store&gt;/common/…
 *   &lt;store&gt;/en/…
 *   &lt;store&gt;/countries/usa/…
 * </pre>
 *
 * <p>The address path is the only level that has to exist, so it is the only level there is. The
 * store is a single scan root, registered in {@code dataPaths} once however many bundles land in
 * it, and a bundle is no longer identifiable by a folder named after it — which is what the
 * bookkeeping file is for: it records the paths each bundle owns, so {@code pack remove} deletes
 * exactly those and {@code pack list} knows what is installed.
 *
 * <p>The network and the unzip live in {@link PackRegistry}; the decisions — what a bundle owns,
 * what the record means, what an old store has to become — are here, where they can be checked
 * without touching the wire.
 */
public final class PackStore {

  /**
   * The store's bookkeeping file.
   *
   * <p>A DOTFILE because it sits at the root of a scan root, and the pack loader skips ignored
   * NAMES rather than unknown extensions — a plain {@code installed.json} here would be read as a
   * pack at address {@code installed}.
   */
  public static final String INSTALLED_FILE = ".tdcv2-installed.json";

  /** Bumped only if the record's shape changes in a way older tools misread. */
  public static final int SCHEMA_VERSION = 1;

  private PackStore() {}

  /** One bundle as the store has it. */
  public record InstalledBundle(
      String id, List<String> paths, String version, String sha256, int files) {}

  /** The bookkeeping file's contents. */
  public record InstalledRecord(int schemaVersion, List<InstalledBundle> bundles) {}

  /** One bundle's tree, moved out of its old folder. */
  public record Move(String id, String from, List<String> to, int files) {}

  /**
   * What {@link #migrate} did, for the caller to report.
   *
   * <p>{@code leftovers} are files that were in a bundle's old folder but OUTSIDE its {@code
   * packs/} tree. They belong to no pack address, so they are left exactly where they are rather
   * than being guessed at or deleted. {@code registered} is the store as it was written into
   * {@code dataPaths}, or null when it was already there.
   */
  public record Migration(
      Path store,
      List<Move> moves,
      List<String> leftovers,
      int droppedDataPaths,
      String registered) {}

  /** Where the bookkeeping file lives. */
  public static Path installedFile(Path store) {
    return store.resolve(INSTALLED_FILE);
  }

  /**
   * Read the store's books.
   *
   * <p>A missing file means an empty store; a malformed one is an ERROR rather than an empty
   * store, because "nothing is installed" would make {@code pack remove} claim there is nothing to
   * delete while the files sit there.
   */
  public static InstalledRecord read(Path store) {
    Path path = installedFile(store);
    if (!Files.isRegularFile(path)) {
      return new InstalledRecord(SCHEMA_VERSION, List.of());
    }
    Object parsed;
    try {
      parsed = Json.parse(Files.readString(path, StandardCharsets.UTF_8));
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read the pack store record " + path, e);
    } catch (Json.SyntaxException e) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\" is not valid JSON: " + e.getMessage()
              + ". Delete it and re-add your bundles.",
          e);
    }
    if (!(parsed instanceof Map)) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\" must be a JSON object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> root = (Map<String, Object>) parsed;

    if (!(root.get("schemaVersion") instanceof Double version)) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\": \"schemaVersion\" must be a number");
    }
    int schemaVersion = (int) Math.round(version);
    if (schemaVersion > SCHEMA_VERSION) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\" was written by a newer tdcv2 (schemaVersion "
              + schemaVersion + ") — update tdcv2");
    }
    if (!(root.get("bundles") instanceof List<?> raw)) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\": \"bundles\" must be an array");
    }
    List<InstalledBundle> bundles = new ArrayList<>();
    for (int i = 0; i < raw.size(); i++) {
      bundles.add(parseBundle(raw.get(i), i, path, store));
    }
    return new InstalledRecord(schemaVersion, sortById(bundles));
  }

  private static InstalledBundle parseBundle(Object raw, int i, Path path, Path store) {
    if (!(raw instanceof Map)) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\": bundles[" + i + "] must be an object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> b = (Map<String, Object>) raw;

    String id = text(b.get("id"), path, "bundles[" + i + "].id");
    if (!(b.get("paths") instanceof List<?> rawPaths)) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\": bundles[" + i + "].paths must be an array");
    }
    List<String> paths = new ArrayList<>();
    for (int j = 0; j < rawPaths.size(); j++) {
      String value = text(rawPaths.get(j), path, "bundles[" + i + "].paths[" + j + "]");
      // Everything in here is deleted verbatim by `pack remove`, so a hand-edited or hostile
      // record must not be able to point outside the store.
      if (Paths.get(value).isAbsolute() || !isPathInside(resolve(store, value), store)) {
        throw new PackRegistry.PackException(
            "pack store record \"" + path + "\": bundle \"" + id
                + "\" claims a path outside the store: \"" + value + "\"");
      }
      paths.add(value);
    }
    return new InstalledBundle(
        id,
        List.copyOf(paths),
        b.get("version") instanceof String v ? v : "",
        b.get("sha256") instanceof String s ? s : "",
        b.get("files") instanceof Double f ? (int) Math.round(f) : 0);
  }

  private static String text(Object value, Path path, String what) {
    if (!(value instanceof String s) || s.trim().isEmpty()) {
      throw new PackRegistry.PackException(
          "pack store record \"" + path + "\": " + what + " must be a non-empty string");
    }
    return s;
  }

  /**
   * Ids sorted by plain byte comparison.
   *
   * <p>Never a locale-aware collator: five implementations write this file and it is checked in
   * and diffed, so an ordering that depended on the machine's language would make the same set of
   * bundles produce different bytes in different places.
   */
  private static List<InstalledBundle> sortById(List<InstalledBundle> bundles) {
    List<InstalledBundle> out = new ArrayList<>(bundles);
    out.sort(Comparator.comparing(InstalledBundle::id));
    return List.copyOf(out);
  }

  /** Write the store's books, ids sorted so re-installing the same set is a no-diff. */
  public static void write(Path store, InstalledRecord record) {
    try {
      Files.createDirectories(store);
      Files.writeString(installedFile(store), render(record), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot write the pack store record in " + store, e);
    }
  }

  /**
   * The record's bytes, spelled out rather than handed to a general writer.
   *
   * <p>Five implementations write this file and it is compared byte for byte: two-space indent,
   * a trailing newline, the keys in one fixed order, and {@code files} as an integer — which a
   * writer whose numbers are all doubles would render as {@code 1.0}.
   */
  private static String render(InstalledRecord record) {
    List<InstalledBundle> bundles = sortById(record.bundles());
    StringBuilder out = new StringBuilder();
    out.append("{\n  \"schemaVersion\": ").append(SCHEMA_VERSION).append(",\n  \"bundles\": ");
    if (bundles.isEmpty()) {
      return out.append("[]\n}\n").toString();
    }
    out.append("[\n");
    for (int i = 0; i < bundles.size(); i++) {
      InstalledBundle bundle = bundles.get(i);
      out.append("    {\n      \"id\": ").append(quote(bundle.id())).append(",\n      \"paths\": ");
      if (bundle.paths().isEmpty()) {
        out.append("[]");
      } else {
        out.append("[\n");
        for (int j = 0; j < bundle.paths().size(); j++) {
          out.append("        ").append(quote(bundle.paths().get(j)));
          out.append(j == bundle.paths().size() - 1 ? "\n" : ",\n");
        }
        out.append("      ]");
      }
      out.append(",\n      \"version\": ").append(quote(bundle.version()));
      out.append(",\n      \"sha256\": ").append(quote(bundle.sha256()));
      out.append(",\n      \"files\": ").append(bundle.files()).append('\n');
      out.append(i == bundles.size() - 1 ? "    }\n" : "    },\n");
    }
    return out.append("  ]\n}\n").toString();
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) {
            out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
          } else {
            out.append(c);
          }
        }
      }
    }
    return out.append('"').toString();
  }

  /** The record with {@code entry} put in place of any earlier install of the same id. */
  public static InstalledRecord with(InstalledRecord record, InstalledBundle entry) {
    List<InstalledBundle> bundles = new ArrayList<>();
    for (InstalledBundle bundle : record.bundles()) {
      if (!bundle.id().equals(entry.id())) {
        bundles.add(bundle);
      }
    }
    bundles.add(entry);
    return new InstalledRecord(SCHEMA_VERSION, sortById(bundles));
  }

  /** The record without {@code id}. */
  public static InstalledRecord without(InstalledRecord record, String id) {
    List<InstalledBundle> bundles = new ArrayList<>();
    for (InstalledBundle bundle : record.bundles()) {
      if (!bundle.id().equals(id)) {
        bundles.add(bundle);
      }
    }
    return new InstalledRecord(SCHEMA_VERSION, List.copyOf(bundles));
  }

  /** One bundle out of a record, or null if the store never wrote it down. */
  public static InstalledBundle find(InstalledRecord record, String id) {
    for (InstalledBundle bundle : record.bundles()) {
      if (bundle.id().equals(id)) {
        return bundle;
      }
    }
    return null;
  }

  /**
   * Bundle ids the store has, from its books.
   *
   * <p>A missing store means nothing installed, not an error. A tree somebody unpacked by hand is
   * not "installed" either: nothing records what it owns, so nothing could remove it cleanly.
   */
  public static List<String> installedIds(Path store) {
    List<String> ids = new ArrayList<>();
    for (InstalledBundle bundle : read(store).bundles()) {
      ids.add(bundle.id());
    }
    ids.sort(String::compareTo);
    return List.copyOf(ids);
  }

  /**
   * The paths a bundle owns, given every file it carries (store-relative, {@code /}-separated).
   *
   * <p>Usually one path: every file of {@code ru} sits under {@code ru/}, every file of {@code
   * russia} under {@code countries/russia/}, so the longest shared directory IS the subtree the
   * bundle owns — and {@code countries/}, which several bundles share, is correctly not claimed by
   * any of them. A bundle whose files diverge at the top level owns each of those top-level
   * entries instead, which keeps the answer an antichain: no owned path contains another.
   */
  public static List<String> ownedPaths(List<String> files) {
    if (files.isEmpty()) {
      return List.of();
    }
    List<String> common = null;
    for (String file : files) {
      List<String> parts = new ArrayList<>(List.of(file.split("/", -1)));
      parts.remove(parts.size() - 1); // the file's own name
      if (common == null) {
        common = parts;
        continue;
      }
      int i = 0;
      while (i < common.size() && i < parts.size() && common.get(i).equals(parts.get(i))) {
        i++;
      }
      common = new ArrayList<>(common.subList(0, i));
      if (common.isEmpty()) {
        break;
      }
    }
    if (common != null && !common.isEmpty()) {
      return List.of(String.join("/", common));
    }
    // Nothing shared above the top level, so the bundle owns each top-level entry it touches.
    TreeSet<String> tops = new TreeSet<>();
    for (String file : files) {
      String top = file.split("/", -1)[0];
      if (!top.isEmpty()) {
        tops.add(top);
      }
    }
    return List.copyOf(new ArrayList<>(tops));
  }

  /** True if {@code child} is the same as, or nested under, {@code parent}. Guards zip-slip. */
  public static boolean isPathInside(Path child, Path parent) {
    return child.toAbsolutePath().normalize().startsWith(parent.toAbsolutePath().normalize());
  }

  /** A store-relative, {@code /}-separated path resolved against the store. */
  public static Path resolve(Path store, String relative) {
    Path out = store;
    for (String part : relative.split("/", -1)) {
      if (!part.isEmpty()) {
        out = out.resolve(part);
      }
    }
    return out;
  }

  /**
   * Every file under {@code dir}, as {@code /}-separated paths relative to it, sorted.
   *
   * <p>Dotfiles included: {@code _locale.json} and anything else the packs carry has to travel
   * with them, and deciding what is "really" data is the loader's job.
   */
  public static List<String> walkRelative(Path dir) {
    if (!Files.isDirectory(dir)) {
      return List.of();
    }
    List<String> out = new ArrayList<>();
    try (java.util.stream.Stream<Path> walk = Files.walk(dir)) {
      walk.filter(Files::isRegularFile)
          .forEach(p -> out.add(dir.relativize(p).toString().replace('\\', '/')));
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read " + dir, e);
    }
    out.sort(String::compareTo);
    return out;
  }

  /** Delete {@code dir} and every empty parent up to (but never including) {@code stopAt}. */
  public static void pruneEmptyDirs(Path dir, Path stopAt) {
    Path current = dir.toAbsolutePath().normalize();
    Path root = stopAt.toAbsolutePath().normalize();
    while (!current.equals(root) && isPathInside(current, root)) {
      try (java.util.stream.Stream<Path> entries = Files.list(current)) {
        if (entries.findAny().isPresent()) {
          return;
        }
      } catch (IOException e) {
        return;
      }
      try {
        Files.delete(current);
      } catch (IOException e) {
        return;
      }
      current = current.getParent();
      if (current == null) {
        return;
      }
    }
  }

  /**
   * Delete the paths a bundle owns, and any parent left empty behind them.
   *
   * <p>The record is a file on disk and may have been edited, so a path that does not resolve
   * inside the store is not deleted on its say-so.
   */
  public static void deleteOwnedPaths(Path store, List<String> paths) {
    for (String relative : paths) {
      Path target = resolve(store, relative);
      if (!isPathInside(target, store)
          || target.toAbsolutePath().normalize().equals(store.toAbsolutePath().normalize())) {
        throw new PackRegistry.PackException(
            "refusing to delete \"" + relative + "\": it is not inside the pack store");
      }
      deleteTree(target);
      Path parent = target.getParent();
      if (parent != null) {
        pruneEmptyDirs(parent, store);
      }
    }
  }

  /** Depth-first, so a directory goes only once its contents have. Absent is not a failure. */
  private static void deleteTree(Path root) {
    if (!Files.exists(root)) {
      return;
    }
    try (java.util.stream.Stream<Path> walk = Files.walk(root)) {
      walk.sorted(Comparator.reverseOrder())
          .forEach(
              path -> {
                try {
                  Files.deleteIfExists(path);
                } catch (IOException e) {
                  throw new UncheckedIOException(e);
                }
              });
    } catch (IOException e) {
      throw new UncheckedIOException("cannot remove \"" + root + "\"", e);
    }
  }

  // ── migrating a store written by an older tdcv2 ─────────────────────────────────────────────

  /** Bundle folders in the old layout: {@code <store>/<id>/packs/…}. */
  public static List<String> legacyBundleIds(Path store) {
    if (!Files.isDirectory(store)) {
      return List.of();
    }
    List<String> ids = new ArrayList<>();
    try (java.util.stream.Stream<Path> entries = Files.list(store)) {
      entries
          .filter(p -> Files.isDirectory(p.resolve(PackRegistry.BUNDLE_PACKS_DIR)))
          .forEach(p -> ids.add(p.getFileName().toString()));
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read the pack store " + store, e);
    }
    ids.sort(String::compareTo);
    return List.copyOf(ids);
  }

  /**
   * Move a store written by an older tdcv2 into the flat layout, in place.
   *
   * <p>Returns null when there is nothing to move. Everything is PLANNED before anything moves: a
   * store half in one layout and half in the other is worse than one that refused and said why,
   * and the refusal costs the user only the two minutes it takes to move the offending file
   * themselves.
   *
   * <p>Anyone who ran {@code pack add} before the flat store has {@code <store>/<id>/packs/…} on
   * disk and one {@code dataPaths} entry per bundle in their config; both are fixed here, so the
   * first {@code tdcv2 pack} after an upgrade is all it takes.
   */
  public static Migration migrate(Path store, Path configPath) {
    List<String> ids = legacyBundleIds(store);
    if (ids.isEmpty()) {
      return null;
    }

    Map<Path, Path> planned = new LinkedHashMap<>();
    Map<Path, String> claimedBy = new LinkedHashMap<>();
    Map<String, List<String>> perBundle = new LinkedHashMap<>();
    List<String> conflicts = new ArrayList<>();
    List<String> leftovers = new ArrayList<>();

    for (String id : ids) {
      Path packsRoot = legacyPacksRoot(store, id);
      List<String> rels = walkRelative(packsRoot);
      perBundle.put(id, rels);
      // Read before anything moves: a bundle whose tree lands back under its own name
      // (`ru/packs/ru` → `ru`) would otherwise report its own data as a leftover the moment it
      // arrived.
      for (String rel : walkRelative(store.resolve(id))) {
        if (!rel.startsWith(PackRegistry.BUNDLE_PACKS_DIR + "/")) {
          leftovers.add(id + "/" + rel);
        }
      }
      for (String rel : rels) {
        Path destination = resolve(store, rel);
        if (!isPathInside(destination, store)) {
          conflicts.add(id + ": \"" + rel + "\" would land outside the store");
          continue;
        }
        Path key = destination.toAbsolutePath().normalize();
        String claimed = claimedBy.get(key);
        if (claimed != null) {
          conflicts.add(rel + ": claimed by both \"" + claimed + "\" and \"" + id + "\"");
          continue;
        }
        if (Files.exists(destination)) {
          conflicts.add(rel + ": something is already there");
          continue;
        }
        // Landing inside another bundle's old folder would move a file out from under a move
        // still to come.
        boolean insideAnother = false;
        for (String other : ids) {
          if (!other.equals(id) && isPathInside(destination, legacyPacksRoot(store, other))) {
            insideAnother = true;
            break;
          }
        }
        if (insideAnother) {
          conflicts.add(rel + ": it would land inside another bundle's old folder");
          continue;
        }
        claimedBy.put(key, id);
        planned.put(destination, resolve(packsRoot, rel));
      }
    }

    if (!conflicts.isEmpty()) {
      StringBuilder message = new StringBuilder();
      message
          .append("cannot move the pack store \"")
          .append(store)
          .append("\" to the flat layout — ")
          .append(conflicts.size())
          .append(" path(s) collide:\n");
      for (int i = 0; i < Math.min(5, conflicts.size()); i++) {
        message.append("  ").append(conflicts.get(i)).append('\n');
      }
      if (conflicts.size() > 5) {
        message.append("  … and ").append(conflicts.size() - 5).append(" more\n");
      }
      message.append(
          "Nothing was moved. Clear those paths, or delete the store and run "
              + "`tdcv2 pack add` again.");
      throw new PackRegistry.PackException(message.toString());
    }

    for (Map.Entry<Path, Path> move : planned.entrySet()) {
      moveFile(move.getValue(), move.getKey());
    }

    InstalledRecord record = read(store);
    List<Move> moves = new ArrayList<>();
    for (Map.Entry<String, List<String>> bundle : perBundle.entrySet()) {
      String id = bundle.getKey();
      List<String> rels = bundle.getValue();
      List<String> paths = ownedPaths(rels);
      record = with(record, new InstalledBundle(id, paths, "", "", rels.size()));
      moves.add(
          new Move(id, id + "/" + PackRegistry.BUNDLE_PACKS_DIR, paths, rels.size()));
      pruneEmptyTree(legacyPacksRoot(store, id));
      pruneEmptyTree(store.resolve(id));
    }
    write(store, record);

    int dropped = ProjectConfig.removeDataPathsInside(configPath, store);
    String stored = ProjectConfig.storedPath(configPath, store);
    boolean added = ProjectConfig.register(configPath, List.of(store));
    return new Migration(
        store, List.copyOf(moves), List.copyOf(leftovers), dropped, added ? stored : null);
  }

  private static Path legacyPacksRoot(Path store, String id) {
    return store.resolve(id).resolve(PackRegistry.BUNDLE_PACKS_DIR);
  }

  /** Move one file, falling back to copy-and-delete if the store spans two devices. */
  private static void moveFile(Path from, Path to) {
    try {
      Files.createDirectories(to.getParent());
      Files.move(from, to);
    } catch (IOException e) {
      try {
        Files.copy(from, to);
        Files.delete(from);
      } catch (IOException fallback) {
        throw new UncheckedIOException("cannot move " + from + " to " + to, fallback);
      }
    }
  }

  /**
   * Delete every empty directory in {@code dir}'s subtree, and {@code dir} itself if that leaves
   * it empty. Returns whether {@code dir} is gone.
   *
   * <p>Moving files out leaves the whole shape of the old tree behind, and empty folders in a scan
   * root are noise a user then has to wonder about.
   */
  private static boolean pruneEmptyTree(Path dir) {
    List<Path> entries = new ArrayList<>();
    try (java.util.stream.Stream<Path> list = Files.list(dir)) {
      list.forEach(entries::add);
    } catch (IOException e) {
      return false;
    }
    boolean empty = true;
    for (Path entry : entries) {
      if (!Files.isDirectory(entry) || !pruneEmptyTree(entry)) {
        empty = false;
      }
    }
    if (!empty) {
      return false;
    }
    try {
      Files.delete(dir);
      return true;
    } catch (IOException e) {
      return false;
    }
  }
}
