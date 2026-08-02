package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
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
}
