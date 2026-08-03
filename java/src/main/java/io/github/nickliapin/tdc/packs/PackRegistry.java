package io.github.nickliapin.tdc.packs;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Data packs, fetched on demand from the registry every implementation shares.
 *
 * <p>The pack collection is a body of DATA with its own release rhythm, and it grows without
 * bound — every locale, every country, eventually every corpus. It lives in one repository, and
 * each library ships only a starter set: locale-agnostic packs, one language, one country.
 * Everything past that is downloaded.
 *
 * <p>One registry for all of them is the point. A locale added there appears in TypeScript, in
 * Java and in Python at once, and there is exactly one place to publish to. This class is the
 * Java client for it — the same {@code index.json}, the same bundle zips, the same digests, and
 * the same store layout, so a project can be set up by whichever implementation happens to be at
 * hand and used by any of the others.
 */
public final class PackRegistry {

  /** Where the bundles live. The same default the command-line tool uses. */
  public static final String DEFAULT_BASE_URL =
      "https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master";

  /** The folder inside a bundle that is a pack scan root. */
  public static final String BUNDLE_PACKS_DIR = "packs";

  private static final Duration TIMEOUT = Duration.ofSeconds(60);

  /** Anything that stops a bundle being installed, said plainly. */
  public static final class PackException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public PackException(String message) {
      super(message);
    }

    PackException(String message, Throwable cause) {
      super(message, cause);
    }
  }

  /** One downloadable bundle, as the registry's index describes it. */
  /**
   * One downloadable bundle, as the registry's index describes it.
   *
   * <p>{@code version} is what the registry calls this revision of the bundle. Optional: today's
   * index declares none, and the digest already tells two revisions apart — but the store writes
   * down whatever the registry did say, so a registry that starts versioning its bundles is
   * understood without a client change.
   *
   * <p>{@code regions} and {@code point} say where a country is: the continents it belongs to,
   * and roughly its middle as [longitude, latitude]. They come from the registry so the
   * interactive picker can group and plot a country without keeping a copy of world geography —
   * the picker exists in three languages, and three copies would be three copies that drift.
   * Empty and null for languages and for {@code common}, and for an index published before they
   * existed, which is why neither is required.
   */
  public record Bundle(
      String id,
      String name,
      String description,
      String file,
      long bytes,
      String sha256,
      String version,
      String locale,
      String country,
      List<String> contents,
      List<String> regions,
      double[] point) {}

  /** The catalogue. */
  public record Index(int schemaVersion, String description, List<Bundle> bundles) {

    /** A bundle by id, or a message naming what there is. */
    public Bundle find(String id) {
      for (Bundle bundle : bundles) {
        if (bundle.id().equals(id)) {
          return bundle;
        }
      }
      List<String> known = new ArrayList<>();
      for (Bundle bundle : bundles) {
        known.add(bundle.id());
      }
      throw new PackException(
          "unknown bundle \"" + id + "\". Available: " + (known.isEmpty() ? "(none)" : String.join(", ", known)));
    }
  }

  private final String baseUrl;
  private final HttpClient client;

  public PackRegistry() {
    this(DEFAULT_BASE_URL);
  }

  public PackRegistry(String baseUrl) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
  }

  /** The catalogue of what can be installed. */
  public Index index() {
    return parseIndex(new String(fetch(baseUrl + "/index.json"), StandardCharsets.UTF_8));
  }

  /**
   * Download a bundle, unpack it into the store, and write down what it owns.
   *
   * <p>The bytes are checked against the digest the registry published before anything is
   * written. Data that arrives corrupted, or altered on the way, is refused rather than unpacked
   * — a generator quietly fed the wrong names produces a dataset nobody can tell is wrong.
   *
   * <p>A bundle's zip nests everything under {@code <id>/packs/}, which is the bundler's business
   * and not the user's: both levels are stripped here so the address path lands directly in the
   * store and {@code ru/person/lastName.txt} is what appears under it. That layout is the
   * registry's, shared by every implementation, so getting it wrong here breaks packs published
   * for the others rather than only ours.
   *
   * @return the entry the store now holds for this bundle — the paths it owns, and how many files
   */
  public PackStore.InstalledBundle install(Bundle bundle, Path store) {
    try {
      Files.createDirectories(store);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot create the pack store " + store, e);
    }

    byte[] archive = fetch(baseUrl + "/" + bundle.file());
    // Length first: a download cut short in transit is the common case, and saying how short says
    // far more than "the hash did not match". The digest then covers everything else — including
    // an archive swapped for one of exactly the same size.
    if (bundle.bytes() > 0 && archive.length != bundle.bytes()) {
      throw new PackException(
          "bundle \"" + bundle.id() + "\": expected " + bundle.bytes() + " bytes, got "
              + archive.length);
    }
    String actual = sha256(archive);
    if (!actual.equalsIgnoreCase(bundle.sha256().trim())) {
      throw new PackException(
          "bundle \"" + bundle.id() + "\" failed its checksum — download corrupt or tampered; "
              + "not installed");
    }

    Map<String, byte[]> files = planExtract(archive, bundle.id(), store);
    List<String> rels = new ArrayList<>(files.keySet());
    rels.sort(String::compareTo);
    List<String> paths = PackStore.ownedPaths(rels);

    PackStore.InstalledRecord record = PackStore.read(store);
    assertNoOverlap(bundle.id(), paths, record);

    // Re-installing replaces rather than layers: without this, a bundle that dropped a file would
    // leave the old one behind for good, still answering to its address.
    PackStore.InstalledBundle previous = PackStore.find(record, bundle.id());
    if (previous != null) {
      PackStore.deleteOwnedPaths(store, previous.paths());
    }

    writeExtract(files, store);
    PackStore.InstalledBundle entry =
        new PackStore.InstalledBundle(
            bundle.id(),
            paths,
            bundle.version() == null ? "" : bundle.version(),
            bundle.sha256(),
            rels.size());
    PackStore.write(store, PackStore.with(record, entry));
    return entry;
  }

  /**
   * Refuse a bundle that would write into a path another one owns.
   *
   * <p>The registry's bundles are axis-pure and no two of them name the same path, so this never
   * fires on the real catalogue — it fires on a hand-built or renamed archive, where the
   * alternative is two bundles interleaved in one tree and a {@code pack remove} that takes half
   * of the other with it.
   */
  private static void assertNoOverlap(
      String id, List<String> paths, PackStore.InstalledRecord record) {
    for (PackStore.InstalledBundle other : record.bundles()) {
      if (other.id().equals(id)) {
        continue;
      }
      for (String mine : paths) {
        for (String theirs : other.paths()) {
          if (mine.equals(theirs)
              || mine.startsWith(theirs + "/")
              || theirs.startsWith(mine + "/")) {
            throw new PackException(
                "bundle \"" + id + "\" would write into \"" + mine + "\", which \"" + other.id()
                    + "\" already owns — remove \"" + other.id() + "\" first");
          }
        }
      }
    }
  }

  /** Bundle ids already in the store, from the books it keeps rather than from its folders. */
  public static List<String> installed(Path store) {
    return PackStore.installedIds(store);
  }

  // ── the wire ─────────────────────────────────────────────────────────────────────────────

  private byte[] fetch(String url) {
    URI uri;
    try {
      uri = URI.create(url);
    } catch (IllegalArgumentException e) {
      throw new PackException("not a usable registry address: " + url, e);
    }

    // A registry on the filesystem — a mounted share, an offline mirror, a test's temporary
    // folder. `HttpClient` refuses any scheme but http and https, and refuses it by throwing
    // rather than by returning a status, so the case is answered here instead.
    if ("file".equalsIgnoreCase(uri.getScheme())) {
      try {
        return Files.readAllBytes(java.nio.file.Path.of(uri));
      } catch (java.nio.file.NoSuchFileException e) {
        throw new PackException("not found: " + url, e);
      } catch (IOException e) {
        throw new PackException("cannot read " + url + " (" + e.getMessage() + ")", e);
      }
    }
    if (uri.getScheme() == null || !uri.getScheme().startsWith("http")) {
      throw new PackException(
          "registry \"" + url + "\" must be an http, https or file address");
    }

    HttpRequest request = HttpRequest.newBuilder(uri).timeout(TIMEOUT).GET().build();
    HttpResponse<byte[]> response;
    try {
      response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
    } catch (IOException e) {
      throw new PackException("cannot reach " + url + " (" + e.getMessage() + ")", e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new PackException("interrupted while fetching " + url, e);
    }
    if (response.statusCode() == 404) {
      throw new PackException("not found: " + url);
    }
    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      throw new PackException(url + " returned " + response.statusCode());
    }
    return response.body();
  }

  private static String sha256(byte[] data) {
    try {
      StringBuilder out = new StringBuilder();
      for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) {
        out.append(String.format("%02x", b));
      }
      return out.toString();
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is required by the platform", e);
    }
  }

  /**
   * Read a bundle zip and decide, before a single byte is written, what it would put where.
   *
   * <p>Every entry must carry the {@code <id>/packs/} prefix — an archive that is not the bundle
   * it claims to be, or that carries something beside its packs, is refused whole rather than
   * scattered into a shared tree that nothing could then take apart again. A zip can also name
   * {@code ../../etc/something}, and an extractor that trusts the name writes wherever it is told;
   * that is checked here rather than at the write, so an archive with one escaping path does not
   * first lay down the files that came before it.
   */
  private static Map<String, byte[]> planExtract(byte[] archive, String id, Path store) {
    String prefix = id + "/" + BUNDLE_PACKS_DIR + "/";
    Map<String, byte[]> files = new LinkedHashMap<>();
    try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(archive))) {
      ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) {
        String name = entry.getName();
        if (name.endsWith("/")) {
          continue;
        }
        if (!name.startsWith(prefix)) {
          throw new PackException(
              "bundle \"" + id + "\" carries \"" + name + "\", which is not under \"" + prefix
                  + "\" — refusing to unpack it");
        }
        String relative = name.substring(prefix.length());
        if (relative.isEmpty()) {
          continue;
        }
        if (!PackStore.isPathInside(PackStore.resolve(store, relative), store)) {
          throw new PackException("bundle \"" + id + "\" contains an unsafe path: " + relative);
        }
        files.put(relative, readAll(zip));
      }
    } catch (IOException e) {
      throw new PackException("bundle \"" + id + "\" is not a valid zip: " + e.getMessage(), e);
    }
    if (files.isEmpty()) {
      throw new PackException("bundle \"" + id + "\" has no files under \"" + prefix + "\"");
    }
    return files;
  }

  /** Write a planned extract into the store. Every path was checked by the plan. */
  private static void writeExtract(Map<String, byte[]> files, Path store) {
    for (Map.Entry<String, byte[]> file : files.entrySet()) {
      Path destination = PackStore.resolve(store, file.getKey());
      try {
        Files.createDirectories(destination.getParent());
        Files.write(destination, file.getValue());
      } catch (IOException e) {
        throw new UncheckedIOException("cannot write " + destination, e);
      }
    }
  }

  private static byte[] readAll(InputStream in) throws IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buffer = new byte[1 << 16];
    int read;
    while ((read = in.read(buffer)) > 0) {
      out.write(buffer, 0, read);
    }
    return out.toByteArray();
  }

  // ── the index ────────────────────────────────────────────────────────────────────────────

  /** Parse and check a registry index. Malformed input is a clear error, never a guess. */
  public static Index parseIndex(String text) {
    Object parsed;
    try {
      parsed = Json.parse(text);
    } catch (RuntimeException e) {
      throw new PackException("registry index is not valid JSON: " + e.getMessage(), e);
    }
    if (!(parsed instanceof Map)) {
      throw new PackException("registry index must be a JSON object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> root = (Map<String, Object>) parsed;

    Object version = root.get("schemaVersion");
    if (!(version instanceof Double)) {
      throw new PackException("registry index: \"schemaVersion\" must be a number");
    }
    int schemaVersion = (int) Math.round((Double) version);
    if (schemaVersion != 1) {
      throw new PackException(
          "registry index: unsupported schemaVersion " + schemaVersion + " — update tdcv2");
    }
    if (!(root.get("bundles") instanceof List)) {
      throw new PackException("registry index: \"bundles\" must be an array");
    }

    List<Bundle> bundles = new ArrayList<>();
    List<?> raw = (List<?>) root.get("bundles");
    for (int i = 0; i < raw.size(); i++) {
      bundles.add(parseBundle(raw.get(i), i));
    }
    return new Index(schemaVersion, optional(root.get("description"), "description"), bundles);
  }

  private static Bundle parseBundle(Object raw, int i) {
    if (!(raw instanceof Map)) {
      throw new PackException("registry index: bundles[" + i + "] must be an object");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> b = (Map<String, Object>) raw;

    Object bytes = b.get("bytes");
    if (!(bytes instanceof Double) || (Double) bytes < 0) {
      throw new PackException(
          "registry index: bundles[" + i + "].bytes must be a non-negative number");
    }
    List<String> contents = new ArrayList<>();
    if (b.get("contents") != null) {
      if (!(b.get("contents") instanceof List)) {
        throw new PackException("registry index: bundles[" + i + "].contents must be an array");
      }
      List<?> items = (List<?>) b.get("contents");
      for (int j = 0; j < items.size(); j++) {
        contents.add(required(items.get(j), "bundles[" + i + "].contents[" + j + "]"));
      }
    }
    return new Bundle(
        required(b.get("id"), "bundles[" + i + "].id"),
        required(b.get("name"), "bundles[" + i + "].name"),
        optionalOrEmpty(b.get("description")),
        required(b.get("file"), "bundles[" + i + "].file"),
        (long) (double) (Double) bytes,
        required(b.get("sha256"), "bundles[" + i + "].sha256").toLowerCase(Locale.ROOT),
        optional(b.get("version"), "bundles[" + i + "].version"),
        optional(b.get("locale"), "bundles[" + i + "].locale"),
        optional(b.get("country"), "bundles[" + i + "].country"),
        contents,
        regions(b.get("regions"), i),
        point(b.get("point"), i));
  }

  private static List<String> regions(Object value, int i) {
    if (value == null) {
      return List.of();
    }
    if (!(value instanceof List<?> list)) {
      throw new PackException("registry index: bundles[" + i + "].regions must be an array");
    }
    List<String> out = new ArrayList<>();
    for (int j = 0; j < list.size(); j++) {
      out.add(required(list.get(j), "bundles[" + i + "].regions[" + j + "]"));
    }
    return List.copyOf(out);
  }

  private static double[] point(Object value, int i) {
    if (value == null) {
      return null;
    }
    if (!(value instanceof List<?> list)
        || list.size() != 2
        || !(list.get(0) instanceof Double lon)
        || !(list.get(1) instanceof Double lat)) {
      throw new PackException(
          "registry index: bundles[" + i + "].point must be [longitude, latitude]");
    }
    return new double[] {lon, lat};
  }

  private static String required(Object value, String what) {
    if (!(value instanceof String s) || s.trim().isEmpty()) {
      throw new PackException("registry index: " + what + " must be a non-empty string");
    }
    return s;
  }

  private static String optional(Object value, String what) {
    return value == null ? null : required(value, what);
  }

  private static String optionalOrEmpty(Object value) {
    return value == null ? "" : String.valueOf(value);
  }
}
