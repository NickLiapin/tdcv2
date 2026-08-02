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
}
