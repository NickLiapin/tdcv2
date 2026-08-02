package io.github.nickliapin.tdc.packs;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads data packs off disk.
 *
 * <p>A pack is a text file: an optional {@code ---} header, then one value per line. With
 * {@code weighted: true} each line is {@code value,count} instead, and the counts become exact
 * proportions rather than probabilities — the same machinery {@code percent=} uses. That is
 * why a run of 30,000 rows from the SSA name file contains precisely as many Jameses as the
 * census says, not approximately.
 */
public final class DataPacks {

  /**
   * A loaded pack.
   *
   * <p>{@code percents} is null unless the pack is weighted. {@code generator} is null unless
   * the pack is a generator rather than a list — some packs describe how to build a value
   * instead of listing values, because listing every UUID is not a thing anyone can do.
   */
  public record Entry(List<String> values, double[] percents, String generator) {
    public boolean weighted() {
      return percents != null;
    }

    public boolean isGenerator() {
      return generator != null;
    }
  }

  private final PackSource source;
  private final Map<String, Entry> cache = new HashMap<>();

  /**
   * address -&gt; relative file path, built on the first miss and kept.
   *
   * <p>Null until then: most runs resolve every address straight from its path and never pay for
   * the scan.
   */
  private Map<String, String> addressIndex;

  /**
   * Folders searched by {@code src="@data/…"}, and by a relative {@code src=} the config's own
   * folder does not hold. Highest priority last, as the layers are.
   *
   * <p>They live here because they answer the same question the packs do and come from the same
   * place — {@code --data-path} on the command line, {@code dataPaths} in the project config —
   * and because every engine and the validator is already handed a {@code DataPacks}, so nothing
   * new has to be threaded through fifteen signatures.
   */
  private final List<Path> dataRoots;

  /** The folders a file source may name. Empty when none were configured. */
  public List<Path> dataRoots() {
    return dataRoots;
  }

  public DataPacks(PackSource source, List<Path> dataRoots) {
    this.source = source;
    this.dataRoots = List.copyOf(dataRoots);
  }

  public DataPacks(PackSource source) {
    this(source, List.of());
  }

  public DataPacks(Path root) {
    this(new PackSource.Directory(root));
  }

  /** The packs the library ships with — the default, and no configuration needed to use it. */
  public static DataPacks bundled() {
    return new DataPacks(new PackSource.Classpath());
  }

  /**
   * The bundled packs plus whatever {@code tdcv2.config.json} adds, searched from here upward.
   *
   * <p>A pack downloaded into a project belongs to the project, not to whichever runtime happens
   * to read it. Honouring the same config file the CLI writes is what keeps a config that uses a
   * downloaded pack working in every implementation rather than only the one that fetched it.
   */
  public static DataPacks forProject(Path cwd) {
    return forProject(cwd, List.of());
  }

  /**
   * The same, plus roots named at the call site — the command line's {@code --data-path}.
   *
   * <p>They go on last, so they shadow both the config's roots and the bundled packs. Something
   * typed for this one run should beat something written down for every run.
   */
  public static DataPacks forProject(Path cwd, List<Path> extraRoots) {
    List<PackSource> layers = new ArrayList<>();
    layers.add(new PackSource.Classpath());
    ProjectConfig.Resolved config = ProjectConfig.load(cwd);
    for (Path dir : config.dataPaths()) {
      if (Files.isDirectory(dir)) {
        layers.add(new PackSource.Directory(dir));
      }
    }
    // The pack STORE is deliberately not a scan root. Bundles land in `<store>/<id>/` and each
    // registers its own `packs` folder in `dataPaths`; scanning the store as well would make every
    // installed bundle's ID look like a top-level namespace, so `france.docs.nir` would be looked
    // up as `france/docs/nir.txt` instead of `countries/france/docs/nir.txt` and a country pack
    // would stop resolving the moment it was installed.
    for (Path root : extraRoots) {
      if (Files.isDirectory(root)) {
        layers.add(new PackSource.Directory(root));
      }
    }

    List<Path> roots = new ArrayList<>(config.dataPaths());
    roots.addAll(extraRoots);
    return layers.size() == 1
        ? new DataPacks(new PackSource.Classpath(), roots)
        : new DataPacks(new PackSource.Layered(layers), roots);
  }

  /**
   * Install a bundle from the shared registry into this project, and register it.
   *
   * <p>The one call a Java project needs to add a locale: it downloads, verifies the digest,
   * unpacks into the project's pack store, and writes the path into {@code tdcv2.config.json} so
   * the next run finds it — and so any other implementation working in the same project finds it
   * too. The registry is shared, so this is not a Java-only mechanism reimplemented; it is the
   * same catalogue, the same archives and the same store the command-line tool uses.
   *
   * @param cwd the project to install into — a directory holding, or under, its config file
   * @param bundleIds the ids to install, e.g. {@code "ru"}, {@code "usa"}, {@code "common"}
   * @return the packs, with everything just installed already resolvable
   */
  public static DataPacks install(Path cwd, String... bundleIds) {
    return install(cwd, new PackRegistry(), bundleIds);
  }

  /** The same, against a registry of the caller's choosing — a mirror, or a private one. */
  public static DataPacks install(Path cwd, PackRegistry registry, String... bundleIds) {
    Path project = cwd == null ? Path.of("").toAbsolutePath() : cwd.toAbsolutePath();
    Path configPath = ProjectConfig.findProjectConfig(project);
    Path configDir = configPath == null ? project : configPath.getParent();
    ProjectConfig.Resolved resolved = ProjectConfig.load(project);
    Path store =
        resolved.packStore() != null ? resolved.packStore() : configDir.resolve("tdcv2-packs");

    PackRegistry.Index index = registry.index();
    List<Path> roots = new ArrayList<>();
    for (String id : bundleIds) {
      roots.add(registry.install(index.find(id), store));
    }
    ProjectConfig.register(configPath == null ? configDir.resolve(ProjectConfig.PROJECT_CONFIG_NAME) : configPath, roots);
    return forProject(project);
  }

  /**
   * Resolve a dotted path against a locale and load it.
   *
   * <p>The rule the reference uses: if the first segment names a locale, a country, or a
   * reserved bucket, the path is already absolute; otherwise the active locale is prepended,
   * so {@code person.lastName} under {@code en} is {@code en/person/lastName.txt}.
   *
   * <p>This checks the first segment against the folders that actually exist, which is a
   * narrower rule than the reference's fixed lists. It agrees with them for every pack on
   * disk, and it fails loudly rather than guessing when it does not.
   */
  /**
   * Whether an address resolves, without loading it.
   *
   * <p>The validator asks this so a misspelled address is caught before the run rather than on
   * its first row.
   */
  public boolean exists(String dottedPath, String locale) {
    try {
      load(dottedPath, locale);
      return true;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * Whether a pack generator apportions a share over the whole column.
   *
   * <p>A {@code percent=} anywhere in a generator's body — on its {@code <mix>}, on a {@code
   * <gen>}, on a compound field — makes its quota a property of the run rather than of a row.
   * The router asks this before sending a config to an engine that resolves one row at a time.
   */
  public boolean needsWholeColumn(String dottedPath, String locale) {
    Entry entry = load(dottedPath, locale);
    if (!entry.isGenerator()) {
      return false;
    }
    String body = entry.generator();
    io.github.nickliapin.tdc.parser.ConfigBuilder.PackGenerator composed;
    try {
      composed = io.github.nickliapin.tdc.parser.ConfigBuilder.parsePackBody(body);
    } catch (RuntimeException e) {
      // A single bare <gen>: it declares a share only through its own percent=.
      return body.contains("percent=");
    }
    for (io.github.nickliapin.tdc.model.Config.SequenceSpec spec : composed.sequences()) {
      if (spec.isMix() && declares(spec.mix().percent())) {
        return true;
      }
      if (spec.gen() != null && declares(spec.gen().attrs().get("percent"))) {
        return true;
      }
      // A local sequence holding a lone <gen> has no fields at all, which is the ordinary shape
      // inside a pack body — most of them are one generator and a check digit.
      if (spec.fields() != null) {
        for (io.github.nickliapin.tdc.model.Config.Field field : spec.fields()) {
          if (field.gen() != null && declares(field.gen().attrs().get("percent"))) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private static boolean declares(String percent) {
    return percent != null && !percent.trim().isEmpty();
  }

  public Entry load(String dottedPath, String locale) {
    String key = dottedPath + "|" + locale;
    Entry cached = cache.get(key);
    if (cached != null) {
      return cached;
    }

    String first = dottedPath.split("\\.", 2)[0];
    String file;
    if (source.hasTopLevel(first)) {
      // A locale or a reserved bucket: the address is already absolute.
      file = dottedPath.replace('.', '/') + ".txt";
    } else if (source.hasCountry(first)) {
      // A country: absolute too, but its files live under the countries/ grouping, which is
      // not part of the address anyone writes.
      file = "countries/" + dottedPath.replace('.', '/') + ".txt";
    } else {
      // Relative to the active locale, so `person.lastName` under `ru` is a Russian surname.
      file = (locale + "." + dottedPath).replace('.', '/') + ".txt";
    }

    if (!source.has(file)) {
      // The path did not answer, so ask the headers: a file may declare its own `address:` and
      // then live anywhere at all — which is how someone keeps a flat folder of their own lists.
      String placed = addresses().get(absoluteAddress(dottedPath, locale));
      if (placed == null || !source.has(placed)) {
        throw new IllegalArgumentException(
            "unknown template path \""
                + dottedPath
                + "\" (looked for "
                + file
                + " in "
                + source
                + ")");
      }
      Entry placedEntry = parse(source.readLines(placed), placed);
      cache.put(key, placedEntry);
      return placedEntry;
    }

    Entry entry = parse(source.readLines(file), file);
    cache.put(key, entry);
    return entry;
  }

  /** The address as the index holds it: locale-prefixed unless already absolute. */
  private String absoluteAddress(String dottedPath, String locale) {
    String first = dottedPath.split("\\.", 2)[0];
    return source.hasTopLevel(first) || source.hasCountry(first)
        ? dottedPath
        : locale + "." + dottedPath;
  }

  /**
   * Every pack file's address, read from its header — built once, kept.
   *
   * <p>A header may carry {@code address:} (authoritative) and {@code locale:} (used only when the
   * path-derived address has no locale of its own). A file that resolves to neither a locale, a
   * country nor a reserved bucket is not addressable and is left out, which is the rule the
   * reference applies.
   */
  /**
   * Every address these packs can answer to, in no particular order.
   *
   * <p>The quick API needs the whole list rather than a yes-or-no about one address: to say "did
   * you mean" it has to compare what was typed against all of them. Building the index is the cost
   * of the first call only.
   */
  public java.util.Set<String> addressList() {
    return java.util.Set.copyOf(addresses().keySet());
  }

  private Map<String, String> addresses() {
    if (addressIndex != null) {
      return addressIndex;
    }
    Map<String, String> index = new HashMap<>();
    for (String file : source.listFiles()) {
      Map<String, String> header = headerOf(source.readLines(file));
      String declared = header.get("address");
      String address;
      if (declared != null && !declared.isBlank()) {
        address = declared.trim();
      } else {
        String derived = file.substring(0, file.length() - ".txt".length()).replace('/', '.');
        if (derived.startsWith("countries.")) {
          derived = derived.substring("countries.".length());
        }
        String head = derived.split("\\.", 2)[0];
        if (source.hasTopLevel(head) || source.hasCountry(head)) {
          address = derived;
        } else {
          // Not under a locale folder: the header's own `locale:` is the only thing that can say
          // where this belongs.
          String declaredLocale = header.get("locale");
          if (declaredLocale == null || declaredLocale.isBlank()) {
            continue;
          }
          address = declaredLocale.trim() + "." + derived;
        }
      }
      index.put(address, file);
    }
    addressIndex = index;
    return index;
  }

  /** Just the {@code ---} fenced header, for the address scan: no body, no validation. */
  private static Map<String, String> headerOf(List<String> lines) {
    Map<String, String> header = new HashMap<>();
    if (lines.isEmpty() || !"---".equals(lines.get(0).trim())) {
      return header;
    }
    for (int i = 1; i < lines.size(); i++) {
      String line = lines.get(i).trim();
      if ("---".equals(line)) {
        break;
      }
      if (line.isEmpty() || line.startsWith("#")) {
        continue;
      }
      int colon = line.indexOf(':');
      if (colon > 0) {
        header.put(
            line.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT),
            line.substring(colon + 1).trim());
      }
    }
    return header;
  }

  private static Entry parse(List<String> lines, String file) {
    Map<String, String> header = new HashMap<>();
    int start = 0;
    if (!lines.isEmpty() && "---".equals(lines.get(0).trim())) {
      int end = 1;
      while (end < lines.size() && !"---".equals(lines.get(end).trim())) {
        String line = lines.get(end);
        int colon = line.indexOf(':');
        if (colon > 0) {
          header.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
        }
        end++;
      }
      start = end + 1;
    }

    List<String> body = new ArrayList<>();
    for (int i = start; i < lines.size(); i++) {
      String line = lines.get(i);
      if (!line.isBlank()) {
        body.add(line);
      }
    }

    // `generator: tdc` marks a pack whose body is a <gen> tag rather than a list of values.
    // Some things cannot be listed — a UUID, an account number — so the pack ships the rule.
    if ("tdc".equals(header.get("generator"))) {
      return new Entry(List.of(), null, String.join("\n", body));
    }

    if (!"true".equals(header.get("weighted"))) {
      return new Entry(List.copyOf(body), null, null);
    }

    String delimiter = header.getOrDefault("delimiter", ",");
    List<String> values = new ArrayList<>(body.size());
    List<Double> counts = new ArrayList<>(body.size());
    double total = 0;
    for (String line : body) {
      int at = line.lastIndexOf(delimiter);
      if (at < 0) {
        throw new IllegalArgumentException(
            "weighted pack " + file + ": line \"" + line + "\" has no count");
      }
      double weight = Double.parseDouble(line.substring(at + delimiter.length()).trim());
      // A zero weight means "never drawn". Dropping it rather than carrying it at zero
      // probability is what the reference does, and census files are full of them.
      if (weight == 0) {
        continue;
      }
      values.add(line.substring(0, at));
      counts.add(weight);
      total += weight;
    }
    if (values.isEmpty()) {
      throw new IllegalArgumentException("weighted pack " + file + " has no positive counts");
    }

    double[] percents = new double[counts.size()];
    for (int i = 0; i < counts.size(); i++) {
      // Written exactly as the reference computes it. Reordering these operations changes
      // the last bits of the double, which changes a Hamilton remainder, which changes which
      // row gets a leftover — and the output stops matching.
      percents[i] = (counts.get(i) / total) * 100;
    }
    return new Entry(List.copyOf(values), percents, null);
  }
}
