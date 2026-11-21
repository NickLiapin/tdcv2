package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.github.nickliapin.tdc.generators.HttpGen;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@code <gen type="http">} against a service that really runs.
 *
 * <p>A stub would prove the client compiles. Only a socket proves it speaks the contract: the
 * count header, the body of inputs, the line-per-value reply, and each failure the policy has an
 * opinion about.
 */
class HttpGenTest {

  private HttpServer server;
  private String url;
  private final AtomicInteger calls = new AtomicInteger();
  private final List<String> seenSeeds = new ArrayList<>();

  @BeforeEach
  void start() throws IOException {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    url = "http://127.0.0.1:" + server.getAddress().getPort();
    server.start();
  }

  @AfterEach
  void stop() {
    server.stop(0);
  }

  /** Register a handler and return the full endpoint URL. */
  private String on(String path, Handler handler) {
    server.createContext(
        path,
        exchange -> {
          calls.incrementAndGet();
          String seed = exchange.getRequestHeaders().getFirst("X-TDC-Seed");
          if (seed != null) {
            seenSeeds.add(seed);
          }
          int count = Integer.parseInt(exchange.getRequestHeaders().getFirst("X-TDC-Count"));
          String body;
          try (InputStream in = exchange.getRequestBody()) {
            body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
          }
          handler.handle(exchange, count, body);
        });
    return url + path;
  }

  private interface Handler {
    void handle(HttpExchange exchange, int count, String body) throws IOException;
  }

  private static void reply(HttpExchange exchange, int status, String text) throws IOException {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    exchange.sendResponseHeaders(status, bytes.length);
    exchange.getResponseBody().write(bytes);
    exchange.close();
  }

  private TDC tdc(String endpoint, int count, String extra) {
    return TDC.options()
        .configString(
            ("<tdc><env mode=\"memory\" count=\"%d\" seed=\"http-demo\" local=\"en\">"
                    + "<sequence name=\"V\"><gen type=\"http\" src=\"%s\"%s/></sequence>"
                    + "</env><block><line><data>${{V}}</data></line></block></tdc>")
                .formatted(count, endpoint, extra))
        .build();
  }

  @Test
  @DisplayName("one call carries the whole batch, and the values come back in order")
  void oneCallPerColumn() {
    String endpoint =
        on("/values", (exchange, count, body) -> {
          StringBuilder out = new StringBuilder();
          for (int i = 0; i < count; i++) {
            out.append("v").append(i).append('\n');
          }
          reply(exchange, 200, out.toString());
        });

    assertEquals(
        List.of("v0", "v1", "v2", "v3", "v4"), tdc(endpoint, 5, "").toString().lines().toList());
    // A thousand rows would be a thousand requests if this were per-row. It is one.
    assertEquals(1, calls.get());
  }

  @Test
  @DisplayName("in= sends the other column as the request body, one line per row")
  void inputsTravelUp() {
    String endpoint =
        on("/upper", (exchange, count, body) -> {
          StringBuilder out = new StringBuilder();
          for (String line : body.split("\n", -1)) {
            out.append(line.toUpperCase()).append('\n');
          }
          reply(exchange, 200, out.toString());
        });

    TDC tdc =
        TDC.options()
            .configString(
                ("<tdc><env mode=\"memory\" count=\"3\" seed=\"http-demo\" local=\"en\">"
                        + "<sequence name=\"Word\"><gen type=\"text\" value=\"one,two,three\" order=\"sequential\"/></sequence>"
                        + "<sequence name=\"Loud\"><gen type=\"http\" src=\"%s\" in=\"Word\"/></sequence>"
                        + "</env><block><line><data>${{Word}}=${{Loud}}</data></line></block></tdc>")
                    .formatted(endpoint))
            .build();
    assertEquals(List.of("one=ONE", "two=TWO", "three=THREE"), tdc.toString().lines().toList());
  }

  @Test
  @DisplayName("each sequence gets its own derived seed, so two never receive the same one")
  void seedIsDerivedPerSequence() {
    String endpoint =
        on("/seeded", (exchange, count, body) -> {
          StringBuilder out = new StringBuilder();
          for (int i = 0; i < count; i++) {
            out.append("x\n");
          }
          reply(exchange, 200, out.toString());
        });

    TDC.options()
        .configString(
            ("<tdc><env mode=\"memory\" count=\"2\" seed=\"http-demo\" local=\"en\">"
                    + "<sequence name=\"A\"><gen type=\"http\" src=\"%s\"/></sequence>"
                    + "<sequence name=\"B\"><gen type=\"http\" src=\"%s\"/></sequence>"
                    + "</env><block><line><data>${{A}}${{B}}</data></line></block></tdc>")
                .formatted(endpoint, endpoint))
        .build()
        .toString();

    assertEquals(2, seenSeeds.size());
    // Passing the run's seed through would give both the same one, and a service generating
    // from it would answer both with an identical column.
    assertNotEquals(seenSeeds.get(0), seenSeeds.get(1));
    assertTrue(seenSeeds.get(0).matches("^[0-9a-f]{8}$"), seenSeeds.get(0));
  }

  @Test
  @DisplayName("the derived seed is stable, so a service can reproduce its own answer")
  void seedIsStable() {
    assertEquals(HttpGenSeed.of("run", "Name"), HttpGenSeed.of("run", "Name"));
    assertNotEquals(HttpGenSeed.of("run", "A"), HttpGenSeed.of("run", "B"));
    assertNotEquals(HttpGenSeed.of("one", "A"), HttpGenSeed.of("two", "A"));
  }

  /** A tiny alias so the seed test reads as what it checks. */
  private static final class HttpGenSeed {
    static String of(String seed, String name) {
      return io.github.nickliapin.tdc.generators.HttpGen.seedFor(seed, name);
    }
  }

  @Test
  @DisplayName("a failing service stops the run by default")
  void failureIsFatalByDefault() {
    String endpoint = on("/broken", (exchange, count, body) -> reply(exchange, 500, "nope"));
    IllegalStateException e =
        assertThrows(IllegalStateException.class, () -> tdc(endpoint, 3, "").toString());
    assertTrue(e.getMessage().contains("returned 500"), e.getMessage());
    assertTrue(e.getMessage().contains("sequence \"V\""), e.getMessage());
  }

  @Test
  @DisplayName("on_error=\"empty\" fills blanks instead of stopping")
  void softenedFailure() {
    String endpoint = on("/soft", (exchange, count, body) -> reply(exchange, 503, "later"));
    assertEquals(List.of("", "", ""), tdc(endpoint, 3, " on_error=\"empty\"").toString().lines().toList());
  }

  @Test
  @DisplayName("429 stops the run even under on_error=\"empty\"")
  void rateLimitIsAlwaysFatal() {
    String endpoint = on("/throttled", (exchange, count, body) -> reply(exchange, 429, "slow down"));
    // "Slow down" and "give me the whole column" cannot both be honoured. Filling blanks here
    // would hand back quietly truncated data that looks complete.
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class,
            () -> tdc(endpoint, 3, " on_error=\"empty\"").toString());
    assertTrue(e.getMessage().contains("429"), e.getMessage());
  }

  @Test
  @DisplayName("a short reply is a failure, not a partly filled column")
  void countMismatchIsAFailure() {
    String endpoint = on("/short", (exchange, count, body) -> reply(exchange, 200, "only\none\n"));
    IllegalStateException e =
        assertThrows(IllegalStateException.class, () -> tdc(endpoint, 5, "").toString());
    assertTrue(e.getMessage().contains("2 line(s) for a batch of 5"), e.getMessage());
  }

  @Test
  @DisplayName("a service that never answers is a timeout, not a hang")
  void timeout() {
    String endpoint =
        on("/slow", (exchange, count, body) -> {
          try {
            Thread.sleep(1500);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
          reply(exchange, 200, "late\n");
        });
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class, () -> tdc(endpoint, 1, " timeout=\"0.2\"").toString());
    assertTrue(e.getMessage().contains("did not answer"), e.getMessage());
  }

  // ------------------------------------------------------------------ a service that checks

  private static final String SECRET = "k7Fm2p-test-secret";

  /** The request target the signing service last read off its request line. */
  private final AtomicReference<String> lastTarget = new AtomicReference<>();

  /** The headers and body of the last request the signing service accepted. */
  private final AtomicReference<Headers> lastHeaders = new AtomicReference<>();
  private final AtomicReference<String> lastBody = new AtomicReference<>();

  /**
   * A service that checks {@code X-TDC-Signature} the way a real one would: against the method
   * and the target it actually received on the request line, never against what the client meant
   * to send. Signs on its own, so it does not trust the code under test to compute the HMAC.
   */
  private void signingService() {
    server.createContext(
        "/",
        exchange -> {
          String body;
          try (InputStream in = exchange.getRequestBody()) {
            body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
          }
          Headers h = exchange.getRequestHeaders();
          // The raw request target: com.sun.net.httpserver builds the URI with new URI(String)
          // from the request line, and the raw accessors return it as it came — escapes intact.
          String rawQuery = exchange.getRequestURI().getRawQuery();
          String target =
              exchange.getRequestURI().getRawPath() + (rawQuery == null ? "" : "?" + rawQuery);
          lastTarget.set(target);
          String message =
              exchange.getRequestMethod() + "\n" + target + "\n"
                  + orEmpty(h.getFirst("X-TDC-Timestamp")) + "\n"
                  + orEmpty(h.getFirst("X-TDC-Seed")) + "\n"
                  + orEmpty(h.getFirst("X-TDC-Count")) + "\n"
                  + orEmpty(h.getFirst("X-TDC-Offset")) + "\n"
                  + orEmpty(h.getFirst("X-TDC-Total")) + "\n"
                  + body;
          String signature = orEmpty(h.getFirst("X-TDC-Signature"));
          if (signature.isEmpty() || !signature.equals(hmacHex(SECRET, message))) {
            reply(exchange, 401, "bad signature\n");
            return;
          }
          lastHeaders.set(h);
          lastBody.set(body);
          StringBuilder out = new StringBuilder();
          for (String line : body.split("\n", -1)) {
            out.append("ok-").append(line).append('\n');
          }
          reply(exchange, 200, out.toString());
        });
  }

  private static String orEmpty(String value) {
    return value == null ? "" : value;
  }

  private static String hmacHex(String secret, String message) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      StringBuilder out = new StringBuilder();
      for (byte b : mac.doFinal(message.getBytes(StandardCharsets.UTF_8))) {
        out.append(String.format("%02x", b));
      }
      return out.toString();
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  @Test
  @DisplayName("a signed request is accepted at an address the five clients would each send differently")
  void signedAtAnAwkwardAddress() {
    // The service checks against the request line it actually received. A path and query in the
    // shapes that differ between clients (an escape of a plain letter, a non-ASCII escape in lower
    // case, a quote in the query, a space) only pass if what was signed is what went on the wire.
    signingService();
    assertEquals(
        List.of("ok-x"),
        HttpGen.fetch(
            url + "/%7eme/%d0%bf a?k=it's&v=%41",
            1,
            List.of("x"),
            "abc123",
            HttpGen.OnError.FAIL,
            2000,
            SECRET));
    // And the request line carried the rebuilt URL's target, not src as written.
    assertEquals("/~me/%D0%BF%20a?k=it%27s&v=A", lastTarget.get());

    // An empty ? is no query: signed without it, and sent without it.
    assertEquals(
        List.of("ok-y"),
        HttpGen.fetch(
            url + "/gen?", 1, List.of("y"), "abc123", HttpGen.OnError.FAIL, 2000, SECRET));
    assertEquals("/gen", lastTarget.get());
  }

  @Test
  @DisplayName("a src the client has to encode passes the validator and reaches the service signed")
  void awkwardSrcThroughTheWholeRun() {
    // java.net.URI refuses a raw space in a path, and the validator once checked src with it, so
    // this config was a TDC066 here while the reference ran it. What is checked now is the URL
    // actually sent, rebuilt around the encoded target.
    signingService();
    TDC tdc =
        TDC.options()
            .configString(
                ("<tdc><env mode=\"memory\" count=\"2\" seed=\"http-demo\" local=\"en\">"
                        + "<sequence name=\"Word\"><gen type=\"text\" value=\"one,two\" order=\"sequential\"/></sequence>"
                        + "<sequence name=\"V\"><gen type=\"http\" src=\"%s\" in=\"Word\" secret=\"%s\"/></sequence>"
                        + "</env><block><line><data>${{V}}</data></line></block></tdc>")
                    .formatted(url + "/%7eme/%d0%bf a|b?k=it's&v=%41", SECRET))
            .build();
    assertEquals(List.of("ok-one", "ok-two"), tdc.toString().lines().toList());
    assertEquals("/~me/%D0%BF%20a%7Cb?k=it%27s&v=A", lastTarget.get());
  }

  @Test
  @DisplayName("a request signed for one address is refused at another address of the same service")
  void signedForOneAddressOnly() throws IOException, InterruptedException {
    // The replay found while writing the article on http (2026-11-19): one service, two
    // addresses, one secret. A request signed for the first one, sent unchanged to the second,
    // must not be answered.
    signingService();
    assertEquals(
        List.of("ok-qwerty"),
        HttpGen.fetch(
            url + "/hash",
            1,
            List.of("qwerty"),
            "abc123",
            HttpGen.OnError.FAIL,
            2000,
            SECRET));
    Headers signedFor = lastHeaders.get();
    String body = lastBody.get();

    assertEquals(200, replay(url + "/hash", signedFor, body));
    assertEquals(401, replay(url + "/invite", signedFor, body));
  }

  /** Send captured contract headers and body, unchanged, to {@code target}. */
  private static int replay(String target, Headers headers, String body)
      throws IOException, InterruptedException {
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(target))
            .POST(HttpRequest.BodyPublishers.ofString(body));
    for (String name : headers.keySet()) {
      String lower = name.toLowerCase(java.util.Locale.ROOT);
      if (lower.startsWith("x-tdc-") || lower.equals("content-type")) {
        request.header(name, headers.getFirst(name));
      }
    }
    return HttpClient.newHttpClient()
        .send(request.build(), HttpResponse.BodyHandlers.discarding())
        .statusCode();
  }
}
