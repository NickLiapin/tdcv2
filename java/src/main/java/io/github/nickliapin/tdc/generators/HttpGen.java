package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.prng.Prng;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="http" src="https://…">} — values from a service the user runs.
 *
 * <p>The escape hatch. Some values cannot come from a list or a pattern: a real tokeniser, a
 * model, a legacy system that owns the numbering. Rather than grow the DSL until it can express
 * every such thing, a config can point at a service and let it answer.
 *
 * <p>One call carries a whole batch, never one row. That is what keeps a million rows to a
 * handful of requests instead of a million, and it is why the wire format is line-based: the
 * inputs go up one per line and the values come back one per line, in the same order.
 *
 * <p>An http column is <b>not reproducible</b> — the service decides the values, and the engine
 * cannot promise what it does not control. What it can do is hand the service what it needs to
 * be reproducible on its own, which is the derived seed below.
 */
public final class HttpGen {

  private static final long DEFAULT_TIMEOUT_MS = 30_000;

  /** What {@code on_error} may say. */
  public enum OnError {
    FAIL,
    EMPTY
  }

  /** Why a call failed. */
  public enum FailureKind {
    STATUS,
    RATE_LIMITED,
    TIMEOUT,
    NETWORK,
    COUNT_MISMATCH,
    TOO_LARGE
  }

  /**
   * The most of a reply this client will hold. The wire contract is one value per line for
   * {@code count} rows — a bounded, known-small answer — so a body past the cap is a misbehaving
   * service, and reading it out would trade an error message for exhausted memory. The same limit
   * lives in the other four implementations.
   */
  static final int MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

  public static final class ServiceException extends RuntimeException {

    private static final long serialVersionUID = 1L;
    public final FailureKind kind;
    public final String url;
    public final Integer status;

    ServiceException(String message, FailureKind kind, String url, Integer status) {
      super(message);
      this.kind = kind;
      this.url = url;
      this.status = status;
    }
  }

  /**
   * {@code hex(HMAC-SHA256(secret, timestamp \n seed \n count \n body))}.
   *
   * <p>Everything that decides what comes back is inside: change the body, the count, the seed or
   * the minute, and the signature no longer matches. The secret is the key, so it is never sent —
   * which is what makes this safe over plain http on a trusted network, and what makes a captured
   * request useless tomorrow once the service checks the timestamp.
   */
  public static String signRequest(
      String secret, String timestamp, String seed, int count, String body) {
    String message = timestamp + "\n" + seed + "\n" + count + "\n" + body;
    try {
      javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
      mac.init(
          new javax.crypto.spec.SecretKeySpec(
              secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] digest = mac.doFinal(message.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder(digest.length * 2);
      for (byte b : digest) {
        out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
      }
      return out.toString();
    } catch (java.security.NoSuchAlgorithmException | java.security.InvalidKeyException e) {
      // HmacSHA256 is required of every Java runtime, so this cannot happen on a
      // working install — and a silently unsigned request would be worse than a stop.
      throw new IllegalStateException("HmacSHA256 is unavailable in this Java runtime", e);
    }
  }

  private static final HttpClient CLIENT =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

  private HttpGen() {}

  /**
   * Run one batch and return exactly {@code count} values.
   *
   * @param inputs one line per input value, in row order; {@code null} for a pure source
   */
  public static List<String> fetch(
      String src, int count, List<String> inputs, String seed, OnError onError, long timeoutMs) {
    return fetch(src, count, inputs, seed, onError, timeoutMs, null);
  }

  /**
   * The same, signed with an already-resolved {@code secret=}.
   *
   * @param secret the key to sign with, or {@code null} to send the request unsigned; the secret
   *     itself never goes on the wire — see {@link #signRequest}
   */
  public static List<String> fetch(
      String src,
      int count,
      List<String> inputs,
      String seed,
      OnError onError,
      long timeoutMs,
      String secret) {
    if (count <= 0) {
      return List.of();
    }
    String body = inputs == null ? "" : String.join("\n", inputs);

    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(src))
            .timeout(Duration.ofMillis(timeoutMs))
            .header("Content-Type", "text/plain")
            .header("X-TDC-Count", String.valueOf(count))
            .POST(HttpRequest.BodyPublishers.ofString(body));
    if (seed != null) {
      request.header("X-TDC-Seed", seed);
    }
    // `X-TDC-Input` closes an ambiguity the body alone cannot: `in=` naming a column of one empty
    // value sends an empty body, byte for byte what a pure source sends, and the service invented
    // a value where it had been asked to process one. Absent keeps the old reading, so a service
    // written before this header is unaffected.
    if (inputs != null) {
      request.header("X-TDC-Input", String.valueOf(inputs.size()));
    }
    if (secret != null && !secret.isEmpty()) {
      // The REAL clock, not the run's pinned `now`: the timestamp exists so a service can refuse
      // a request replayed tomorrow, and a config pinned to last year would otherwise be refused
      // by every service that checks.
      String timestamp = String.valueOf(System.currentTimeMillis() / 1000L);
      request.header("X-TDC-Timestamp", timestamp);
      request.header(
          "X-TDC-Signature",
          signRequest(secret, timestamp, seed == null ? "" : seed, count, body));
    }

    HttpResponse<java.io.InputStream> response;
    try {
      response = CLIENT.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
    } catch (java.net.http.HttpTimeoutException e) {
      return fail(new ServiceException("did not answer within " + timeoutMs + "ms",
          FailureKind.TIMEOUT, src, null), count, onError);
    } catch (IOException e) {
      return fail(new ServiceException("could not be reached (" + e.getMessage() + ")",
          FailureKind.NETWORK, src, null), count, onError);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return fail(new ServiceException("was interrupted", FailureKind.NETWORK, src, null),
          count, onError);
    }

    if (response.statusCode() == 429) {
      // The one failure on_error cannot soften. "Slow down" and "give me the whole column"
      // cannot both be honoured, and pretending otherwise yields quietly truncated data.
      closeQuietly(response);
      throw new ServiceException("returned 429 (rate limited)", FailureKind.RATE_LIMITED, src, 429);
    }
    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      closeQuietly(response);
      return fail(new ServiceException("returned " + response.statusCode(),
          FailureKind.STATUS, src, response.statusCode()), count, onError);
    }

    // Read through a hard cap, not to the end — see MAX_RESPONSE_BYTES.
    byte[] raw;
    try (java.io.InputStream in = response.body()) {
      raw = in.readNBytes(MAX_RESPONSE_BYTES + 1);
    } catch (IOException e) {
      return fail(new ServiceException("could not be read (" + e.getMessage() + ")",
          FailureKind.NETWORK, src, null), count, onError);
    }
    if (raw.length > MAX_RESPONSE_BYTES) {
      return fail(new ServiceException(
              "answered with more than " + MAX_RESPONSE_BYTES + " bytes — not a per-line reply",
              FailureKind.TOO_LARGE, src, response.statusCode()),
          count, onError);
    }

    List<String> lines = splitLines(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
    if (lines.size() != count) {
      return fail(new ServiceException(
              "returned " + lines.size() + " line(s) for a batch of " + count,
              FailureKind.COUNT_MISMATCH, src, response.statusCode()),
          count, onError);
    }
    return lines;
  }

  /** Drop an unread body without letting a close failure eclipse the real error. */
  private static void closeQuietly(HttpResponse<java.io.InputStream> response) {
    try {
      response.body().close();
    } catch (IOException ignored) {
      // The error being reported is the interesting one.
    }
  }

  private static List<String> fail(ServiceException e, int count, OnError onError) {
    if (onError == OnError.EMPTY) {
      List<String> blanks = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        blanks.add("");
      }
      return blanks;
    }
    throw e;
  }

  /** The reply, tolerating one trailing newline. */
  private static List<String> splitLines(String text) {
    if (text.isEmpty()) {
      return List.of();
    }
    String trimmed = text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
    return Arrays.asList(trimmed.split("\n", -1));
  }

  /**
   * The value sent as {@code X-TDC-Seed}: eight hex digits from the run's seed and the sequence
   * name, through the same hash the engine keys its own streams with.
   *
   * <p>Derived per sequence rather than passed through. Two http sequences pointed at one
   * service would otherwise receive the same seed, and a service that generates from it would
   * answer both with an identical column.
   */
  public static String seedFor(String envSeed, String sequenceName) {
    int a = Prng.cyrb128(envSeed + "|http|" + sequenceName)[0];
    return String.format("%08x", a & 0xFFFFFFFFL);
  }

  /** {@code timeout="30"} is thirty seconds. Anything unusable falls back to the default. */
  public static long timeoutMs(String raw) {
    if (raw == null) {
      return DEFAULT_TIMEOUT_MS;
    }
    try {
      double seconds = Double.parseDouble(raw.trim());
      return Double.isFinite(seconds) && seconds > 0 ? (long) (seconds * 1000) : DEFAULT_TIMEOUT_MS;
    } catch (NumberFormatException e) {
      return DEFAULT_TIMEOUT_MS;
    }
  }

  public static OnError onError(Map<String, String> attrs) {
    return "empty".equals(attrs.get("on_error")) ? OnError.EMPTY : OnError.FAIL;
  }

  /** Why a {@code secret=} could not be turned into bytes. The caller names the sequence. */
  public static final class SecretException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    SecretException(String message) {
      super(message);
    }
  }

  /**
   * {@code secret="…"} → the bytes to sign with.
   *
   * <p>The secret is the one thing in a run that must not travel: it never goes on the wire (only
   * a signature derived from it does) and it should not travel into version control either, which
   * is what a config does. So the two spellings that keep it out of the file come first, and the
   * literal is accepted — with TDC284 saying why it is a poor idea — rather than refused, because
   * a service on 127.0.0.1 for an afternoon is a real use.
   *
   * <p>An empty secret is refused wherever it came from: signing with nothing produces a signature
   * every caller could forge, which is worse than not signing at all.
   */
  public static String resolveSecret(String spec, java.nio.file.Path baseDir) {
    String trimmed = spec.trim();
    if (trimmed.startsWith("env:")) {
      String name = trimmed.substring(4).trim();
      if (name.isEmpty()) {
        throw new SecretException("secret=\"env:\" names no variable");
      }
      String value = System.getenv(name);
      if (value == null || value.trim().isEmpty()) {
        throw new SecretException(
            "secret=\"env:" + name + "\" — the environment variable is not set, or is empty");
      }
      return value.trim();
    }
    if (trimmed.startsWith("file:")) {
      String raw = trimmed.substring(5).trim();
      if (raw.isEmpty()) {
        throw new SecretException("secret=\"file:\" names no file");
      }
      java.nio.file.Path path = expandHome(raw);
      if (!path.isAbsolute() && baseDir != null) {
        path = baseDir.resolve(path);
      }
      String text;
      try {
        text = java.nio.file.Files.readString(path);
      } catch (IOException e) {
        throw new SecretException(
            "secret=\"file:" + raw + "\" could not be read (" + e.getMessage() + ")");
      }
      // Trimmed because a key file written by a person almost always ends in a newline, and a
      // signature that silently includes it agrees with nothing.
      String value = text.trim();
      if (value.isEmpty()) {
        throw new SecretException("secret=\"file:" + raw + "\" is empty");
      }
      return value;
    }
    if (trimmed.isEmpty()) {
      throw new SecretException("secret=\"\" is empty");
    }
    return trimmed;
  }

  private static java.nio.file.Path expandHome(String path) {
    String home = System.getProperty("user.home", "");
    if ("~".equals(path)) {
      return java.nio.file.Path.of(home);
    }
    return path.startsWith("~/") && !home.isEmpty()
        ? java.nio.file.Path.of(home, path.substring(2))
        : java.nio.file.Path.of(path);
  }

}
