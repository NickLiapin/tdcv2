package io.github.nickliapin.tdc.packs;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * {@code _pack.json} — who wrote a folder of packs, under what licence, at what version.
 *
 * <p>The pack format is otherwise all content and no provenance: a folder of {@code .txt} lists
 * and {@code .tdc} generators says what it produces and nothing about where it came from. That is
 * fine while the only packs are the bundled ones, and stops being fine the moment somebody
 * downloads a folder from a colleague, a registry or a company share and has to answer "may we
 * ship data built from this?".
 *
 * <p>Everything here is OPTIONAL and nothing here reaches the generated data. A manifest cannot
 * change a single value: it describes the folder it sits in, and {@code tdcv2 pack info} is what
 * reads it back. A run never mentions it — the same seed gives the same bytes whether it parses or
 * not, so halting a generation over it would punish the run for something it does not depend on.
 */
public final class PackManifest {

  public static final String FILENAME = "_pack.json";

  /** The fields read back, in the order {@code pack info} prints them. */
  public static final List<String> FIELDS =
      List.of("name", "version", "license", "author", "homepage", "description");

  /** One folder's manifest, and where it was found. Fields keep {@link #FIELDS} order. */
  public record Found(String folder, Map<String, String> manifest) {}

  /** What a sweep of the configured folders turned up. */
  public record Sweep(List<Found> found, List<String> broken) {}

  /** A manifest that would not parse, carried back rather than thrown. */
  public record Parsed(Map<String, String> manifest, String complaint) {}

  private PackManifest() {}

  /**
   * Parse a {@code _pack.json}: either the fields, or the complaint to raise.
   *
   * <p>Unknown keys are kept quietly: a manifest is metadata, and a folder written for a newer TDC
   * — or for a company's own tooling beside it — must not stop working here because it carries a
   * field this version has no use for. What is refused is a field that IS known and holds the
   * wrong kind of thing, because that one was meant for this reader and will not arrive.
   */
  public static Parsed parse(String content, String folder) {
    Object root;
    try {
      root = Json.parse(content);
    } catch (RuntimeException e) {
      return new Parsed(
          null,
          FILENAME + " in \"" + folder + "\" is not valid JSON (" + e.getMessage()
              + "); nothing in this folder is described until it is fixed");
    }
    if (!(root instanceof Map<?, ?> table)) {
      return new Parsed(
          null,
          FILENAME + " in \"" + folder + "\" must be a JSON object, e.g. {\"license\": \"MIT\"}");
    }

    Map<String, String> manifest = new LinkedHashMap<>();
    for (String field : FIELDS) {
      Object value = table.get(field);
      if (value == null) {
        continue;
      }
      if (!(value instanceof String text)) {
        String kind =
            value instanceof List ? "a list"
                : value instanceof Map ? "an object"
                    : value instanceof Boolean ? "a boolean" : "a number";
        return new Parsed(
            null,
            FILENAME + " in \"" + folder + "\" has \"" + field + "\" as " + kind
                + ", and it must be text");
      }
      if (!text.isBlank()) {
        manifest.put(field, text);
      }
    }
    return new Parsed(manifest, null);
  }

  /**
   * Look for {@code _pack.json} in each root and in each of its top-level folders.
   *
   * <p>Two depths rather than a full walk, and deliberately: a manifest describes a FOLDER OF
   * PACKS, which is either a data path somebody configured or one locale inside it. Walking deeper
   * would invite a manifest per {@code .txt} file, and the question this answers — who wrote this
   * data, and under what licence — is not one a single list of city names has its own answer to.
   */
  public static Sweep sweep(
      List<String> roots,
      Function<String, String> read,
      Function<String, List<String>> folders,
      BiFunction<String, String, String> join) {
    List<Found> found = new ArrayList<>();
    List<String> broken = new ArrayList<>();
    List<String> seen = new ArrayList<>();

    for (String root : roots) {
      List<String> candidates = new ArrayList<>();
      candidates.add(root);
      for (String name : folders.apply(root)) {
        candidates.add(join.apply(root, name));
      }
      for (String folder : candidates) {
        if (seen.contains(folder)) {
          continue; // a root listed twice describes itself once
        }
        seen.add(folder);
        String content = read.apply(join.apply(folder, FILENAME));
        if (content == null) {
          continue;
        }
        Parsed parsed = parse(content, folder);
        if (parsed.complaint() != null) {
          broken.add(parsed.complaint());
        } else {
          found.add(new Found(folder, parsed.manifest()));
        }
      }
    }
    return new Sweep(found, broken);
  }

  /**
   * How a found folder is printed: relative to where the command was run when it sits inside,
   * absolute otherwise.
   *
   * <p>A project's own packs live under the project, so the reader sees {@code mypacks/en} rather
   * than sixty characters of temp path — and a store somewhere else in the filesystem still says
   * where it really is.
   */
  public static String displayFolder(String folder, String cwd) {
    if (!folder.startsWith(cwd)) {
      return folder;
    }
    String rest = folder.substring(cwd.length());
    while (rest.startsWith("/")) {
      rest = rest.substring(1);
    }
    return rest.isEmpty() ? "." : rest;
  }
}
