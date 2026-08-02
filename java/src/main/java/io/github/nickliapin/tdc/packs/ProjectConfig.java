package io.github.nickliapin.tdc.packs;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * {@code tdcv2.config.json} — where a project's data packs live, written down instead of guessed.
 *
 * <p>A pack downloaded by the CLI lands in a folder the config names. If this implementation did
 * not read that file, a config using a downloaded pack would work in one language and fail in
 * another, which is a portability bug of the worst kind: nothing is wrong with the config, only
 * with which runtime is asked to run it.
 *
 * <p>Resolution is a cascade, later levels overriding earlier ones for the same address:
 * bundled, then the global config, then the project's, then whatever the caller passed in.
 * Paths accumulate — every root is searched — while a scalar like {@code locale} takes the value
 * from the highest level that set one. A relative path is relative to the config file that
 * contains it, the way a compiler's configuration behaves.
 */
public final class ProjectConfig {

  public static final String PROJECT_CONFIG_NAME = "tdcv2.config.json";

  /** What the cascade resolved to, plus the files that contributed, low to high. */
  public record Resolved(List<Path> dataPaths, String locale, Path packStore, List<Path> sources) {}

  /** A config file that exists but cannot be used. Never silently ignored. */
  public static final class ConfigException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    ConfigException(String message) {
      super(message);
    }
  }

  private ProjectConfig() {}

  /** The cascade, starting from a directory — usually the one the run was launched in. */
  public static Resolved load(Path cwd) {
    List<Path> dataPaths = new ArrayList<>();
    List<Path> sources = new ArrayList<>();
    String locale = null;
    Path packStore = null;

    Path globalPath = globalConfigPath();
    if (globalPath != null && Files.isRegularFile(globalPath)) {
      FileConfig g = read(globalPath);
      dataPaths.addAll(g.dataPaths);
      if (g.locale != null) {
        locale = g.locale;
      }
      if (g.packStore != null) {
        packStore = g.packStore;
      }
      sources.add(globalPath);
    }

    Path projectPath = findProjectConfig(cwd);
    if (projectPath != null) {
      FileConfig p = read(projectPath);
      dataPaths.addAll(p.dataPaths);
      if (p.locale != null) {
        locale = p.locale; // the project overrides the global one
      }
      if (p.packStore != null) {
        packStore = p.packStore;
      }
      sources.add(projectPath);
    }

    return new Resolved(List.copyOf(dataPaths), locale, packStore, List.copyOf(sources));
  }

  /**
   * The global config's location, following each platform's own convention.
   *
   * <p>The same places the CLI writes to, because a config only one of them can find is worse
   * than no config at all.
   */
  public static Path globalConfigPath() {
    String home = System.getProperty("user.home");
    if (home == null || home.isBlank()) {
      return null;
    }
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    if (os.contains("win")) {
      String appData = System.getenv("APPDATA");
      Path base =
          appData != null && !appData.isBlank()
              ? Paths.get(appData)
              : Paths.get(home, "AppData", "Roaming");
      return base.resolve("tdcv2").resolve("config.json");
    }
    String xdg = System.getenv("XDG_CONFIG_HOME");
    Path base = xdg != null && !xdg.isBlank() ? Paths.get(xdg) : Paths.get(home, ".config");
    return base.resolve("tdcv2").resolve("config.json");
  }

  /** The nearest {@code tdcv2.config.json} at or above this directory, or {@code null}. */
  public static Path findProjectConfig(Path cwd) {
    Path dir = cwd == null ? Paths.get("").toAbsolutePath() : cwd.toAbsolutePath().normalize();
    while (dir != null) {
      Path candidate = dir.resolve(PROJECT_CONFIG_NAME);
      if (Files.isRegularFile(candidate)) {
        return candidate;
      }
      dir = dir.getParent();
    }
    return null;
  }

  /** One config file's contribution: absolute paths, and whatever scalars it set. */
  private record FileConfig(List<Path> dataPaths, String locale, Path packStore) {}

  private static FileConfig read(Path path) {
    Object parsed;
    try {
      parsed = Json.parse(Files.readString(path));
    } catch (IOException e) {
      throw new ConfigException("cannot read config \"" + path + "\": " + e.getMessage());
    } catch (Json.SyntaxException e) {
      throw new ConfigException("config \"" + path + "\" is not valid JSON: " + e.getMessage());
    }
    if (!(parsed instanceof Map)) {
      throw new ConfigException("config \"" + path + "\" must be a JSON object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> root = (Map<String, Object>) parsed;

    Path base = path.getParent();
    List<Path> dataPaths = new ArrayList<>();
    Object paths = root.get("dataPaths");
    if (paths != null) {
      if (!(paths instanceof List)) {
        throw new ConfigException(
            "config \"" + path + "\": \"dataPaths\" must be an array of strings");
      }
      for (Object entry : (List<?>) paths) {
        if (!(entry instanceof String text) || text.trim().isEmpty()) {
          throw new ConfigException(
              "config \"" + path + "\": \"dataPaths\" entries must be non-empty strings");
        }
        dataPaths.add(against(base, text));
      }
    }

    String locale = text(root.get("locale"), path, "locale");
    String store = text(root.get("packStore"), path, "packStore");

    return new FileConfig(dataPaths, locale, store == null ? null : against(base, store));
  }

  /** A scalar string setting: absent, or present and non-empty. Nothing in between. */
  private static String text(Object value, Path path, String field) {
    if (value == null) {
      return null;
    }
    if (!(value instanceof String s) || s.trim().isEmpty()) {
      throw new ConfigException(
          "config \"" + path + "\": \"" + field + "\" must be a non-empty string");
    }
    return s.trim();
  }

  /**
   * Add pack roots to a config's {@code dataPaths}, creating the file if there is none.
   *
   * <p>Written relative when the path sits under the config's own folder, the way the
   * command-line tool writes them, so a checked-in config keeps working on another machine.
   * Existing settings are preserved and duplicates are dropped.
   */
  public static boolean register(Path configPath, List<Path> packRoots) {
    Path configDir = configPath.toAbsolutePath().getParent();
    Map<String, Object> document = document(configPath);
    List<String> entries = entries(document);

    boolean added = false;
    for (Path root : packRoots) {
      // De-duped by RESOLVED path, so an entry written "./x" and the same folder named
      // absolutely do not both land in the file.
      Path target = root.toAbsolutePath().normalize();
      boolean present = false;
      for (String entry : entries) {
        if (against(configDir, entry).equals(target)) {
          present = true;
          break;
        }
      }
      if (!present) {
        entries.add(storable(configDir, target));
        added = true;
      }
    }

    document.put("dataPaths", new ArrayList<Object>(entries));
    write(configPath, configDir, document);
    return added;
  }

  /** How {@code target} would be written down in this config — relative to it, or absolute. */
  public static String storedPath(Path configPath, Path target) {
    return storable(configPath.toAbsolutePath().getParent(), target);
  }

  /**
   * The config as it is written, or an empty one.
   *
   * <p>Kept WHOLE, and rewritten in place: every key the file already had survives in the order
   * it was written, including keys this version knows nothing about. Rebuilding the document from
   * the three settings we happen to parse would silently delete anything else a project put there.
   */
  private static Map<String, Object> document(Path path) {
    if (!Files.isRegularFile(path)) {
      return new java.util.LinkedHashMap<>();
    }
    Object parsed;
    try {
      parsed = Json.parse(Files.readString(path));
    } catch (IOException e) {
      throw new ConfigException("cannot read config \"" + path + "\": " + e.getMessage());
    } catch (Json.SyntaxException e) {
      throw new ConfigException("config \"" + path + "\" is not valid JSON: " + e.getMessage());
    }
    if (!(parsed instanceof Map)) {
      throw new ConfigException("config \"" + path + "\" must be a JSON object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> map = (Map<String, Object>) parsed;
    return map;
  }

  /** The document's {@code dataPaths}, as strings — anything else in the array is dropped. */
  private static List<String> entries(Map<String, Object> document) {
    List<String> out = new ArrayList<>();
    if (document.get("dataPaths") instanceof List<?> list) {
      for (Object item : list) {
        if (item instanceof String s) {
          out.add(s);
        }
      }
    }
    return out;
  }

  /**
   * The inverse of {@link #register}: pack roots dropped from a config's {@code dataPaths}.
   *
   * <p>Matched by resolved path, so an entry written relative and one written absolute both go.
   * Returns whether the file changed. Removing a root does not remove data — a bundled pack
   * covering the same addresses simply resurfaces, being a lower-priority root.
   */
  public static boolean unregister(Path configPath, List<Path> packRoots) {
    if (!Files.isRegularFile(configPath)) {
      return false;
    }
    Path configDir = configPath.toAbsolutePath().getParent();
    Map<String, Object> document = document(configPath);
    List<String> entries = entries(document);

    List<Path> targets = new ArrayList<>();
    for (Path root : packRoots) {
      targets.add(root.toAbsolutePath().normalize());
    }

    List<String> kept = new ArrayList<>();
    for (String entry : entries) {
      if (!targets.contains(against(configDir, entry))) {
        kept.add(entry);
      }
    }
    if (kept.size() == entries.size()) {
      return false;
    }

    document.put("dataPaths", new ArrayList<Object>(kept));
    write(configPath, configDir, document);
    return true;
  }

  /** The whole document, two-space indented — the shape every implementation writes. */
  private static void write(Path configPath, Path configDir, Map<String, Object> document) {
    StringBuilder json = new StringBuilder();
    writeValue(json, document, 0);
    json.append('\n');
    try {
      Files.createDirectories(configDir);
      Files.writeString(configPath, json.toString());
    } catch (IOException e) {
      throw new ConfigException("cannot write config \"" + configPath + "\": " + e.getMessage());
    }
  }

  private static void writeValue(StringBuilder out, Object value, int depth) {
    String pad = "  ".repeat(depth + 1);
    String closePad = "  ".repeat(depth);
    if (value instanceof Map<?, ?> map) {
      if (map.isEmpty()) {
        out.append("{}");
        return;
      }
      out.append("{\n");
      int i = 0;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        out.append(pad).append('"').append(escape(String.valueOf(entry.getKey()))).append("\": ");
        writeValue(out, entry.getValue(), depth + 1);
        out.append(++i == map.size() ? "\n" : ",\n");
      }
      out.append(closePad).append('}');
    } else if (value instanceof List<?> list) {
      if (list.isEmpty()) {
        out.append("[]");
        return;
      }
      out.append("[\n");
      for (int i = 0; i < list.size(); i++) {
        out.append(pad);
        writeValue(out, list.get(i), depth + 1);
        out.append(i == list.size() - 1 ? "\n" : ",\n");
      }
      out.append(closePad).append(']');
    } else if (value instanceof String s) {
      out.append('"').append(escape(s)).append('"');
    } else if (value instanceof Number || value instanceof Boolean) {
      out.append(value);
    } else {
      out.append("null");
    }
  }

  /**
   * Relative when it sits under the config's folder; absolute when it does not.
   *
   * <p>The relative form keeps the leading {@code ./} the reference writes. It is the same path
   * either way, but a config is a file people read and diff across implementations, so "the same"
   * should also LOOK the same.
   */
  private static String storable(Path configDir, Path target) {
    Path absolute = target.toAbsolutePath().normalize();
    Path base = configDir.toAbsolutePath().normalize();
    if (absolute.equals(base)) {
      return ".";
    }
    if (absolute.startsWith(base)) {
      return "./" + base.relativize(absolute).toString().replace('\\', '/');
    }
    return absolute.toString();
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  private static Path against(Path base, String value) {
    Path p = Paths.get(value.trim());
    return p.isAbsolute() ? p : base.resolve(p).normalize();
  }
}
