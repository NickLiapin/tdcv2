package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.Executors;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * {@code fixtures/cross-language/http-batches.json}, against a real local service.
 *
 * <p>The other four implementations run the same file; between them they hold the batch contract
 * — what each request carries, where each answer lands, and what a column reading an answer sees —
 * to one behaviour.
 */
class HttpBatchesTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private record Seen(int count, int offset, Integer total, Integer input) {}

  private static JsonNode fixture() throws IOException {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return JSON.readTree(
        Files.readString(Path.of(dir, "cross-language", "http-batches.json")));
  }

  /** A running copy of one of the fixture's services. */
  private static final class Service implements AutoCloseable {
    final HttpServer server;
    final String url;
    final List<Seen> seen = Collections.synchronizedList(new ArrayList<>());
    final List<String> seeds = Collections.synchronizedList(new ArrayList<>());

    Service(String name) throws IOException {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      server.setExecutor(Executors.newCachedThreadPool());
      server.createContext("/gen", exchange -> handle(name, exchange));
      server.start();
      url = "http://127.0.0.1:" + server.getAddress().getPort() + "/gen";
    }

    private void handle(String name, HttpExchange exchange) throws IOException {
      var headers = exchange.getRequestHeaders();
      int count = Integer.parseInt(headers.getFirst("X-TDC-Count"));
      String offsetHeader = headers.getFirst("X-TDC-Offset");
      int offset = offsetHeader == null ? 0 : Integer.parseInt(offsetHeader);
      String totalHeader = headers.getFirst("X-TDC-Total");
      String declared = headers.getFirst("X-TDC-Input");
      String body;
      try (InputStream in = exchange.getRequestBody()) {
        body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
      }
      List<String> inputs =
          declared == null || "0".equals(declared)
              ? List.of()
              : body.isEmpty() ? List.of("") : List.of(body.split("\n", -1));
      String seed = headers.getFirst("X-TDC-Seed");
      seeds.add(seed == null ? "" : seed);
      int served;
      synchronized (seen) {
        seen.add(
            new Seen(
                count,
                offset,
                totalHeader == null ? null : Integer.valueOf(totalHeader),
                declared == null ? null : Integer.valueOf(declared)));
        served = seen.size();
      }

      int status = 200;
      List<String> lines = new ArrayList<>();
      boolean echo = true;
      if ("fail-second".equals(name) && served > 1) {
        status = 500;
      } else if ("upper".equals(name) || "upper-no-echo".equals(name)) {
        for (String line : inputs) {
          lines.add("H" + line);
        }
        echo = "upper".equals(name);
      } else if ("row-no-echo".equals(name)) {
        for (int i = 0; i < count; i++) {
          lines.add("r" + i);
        }
        echo = false;
      } else {
        for (int i = 0; i < count; i++) {
          lines.add("r" + (offset + i));
        }
      }
      byte[] payload = String.join("\n", lines).getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "text/plain");
      if (echo) {
        exchange.getResponseHeaders().set("X-TDC-Offset", String.valueOf(offset));
      }
      exchange.sendResponseHeaders(status, payload.length == 0 ? -1 : payload.length);
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(payload);
      }
    }

    @Override
    public void close() {
      server.stop(0);
    }
  }

  @Test
  void everyServiceTheFixtureNamesIsRunHere() throws IOException {
    Set<String> names = new TreeSet<>();
    fixture().get("services").fieldNames().forEachRemaining(names::add);
    assertEquals(
        new TreeSet<>(List.of("fail-second", "row", "row-no-echo", "upper", "upper-no-echo")),
        names);
  }

  @Test
  void aParallelSplitFallsOnBatchBoundariesSoNoBatchIsFetchedTwice() {
    // The same splits as the TypeScript and Python twins.
    assertEquals(
        List.of(List.of(0, 40), List.of(40, 70), List.of(70, 100)),
        spans(io.github.nickliapin.tdc.engine.Parallel.shards(100, 3, 10)));
    assertEquals(
        List.of(List.of(0, 50), List.of(50, 95)),
        spans(io.github.nickliapin.tdc.engine.Parallel.shards(95, 2, 10)));
    assertEquals(
        List.of(List.of(0, 10), List.of(10, 20), List.of(20, 25)),
        spans(io.github.nickliapin.tdc.engine.Parallel.shards(25, 8, 10)));
  }

  @Test
  void everyHttpGeneratorIsFoundWhereverItSits() {
    String text =
        "<tdc><env count=\"3\" seed=\"s\">"
            + "<sequence name=\"K\"><gen type=\"text\" value=\"x,y\"/></sequence>"
            + "<switch name=\"S\" on=\"K\"><case is=\"x\"><gen type=\"http\""
            + " src=\"http://127.0.0.1:9/\" batch=\"4\"/></case><default><gen type=\"text\""
            + " value=\"-\"/></default></switch>"
            + "<sequence name=\"F\"><gen name=\"a\" type=\"http\" src=\"http://127.0.0.1:9/\""
            + " batch=\"6\"/><gen name=\"b\" type=\"text\" value=\"z\"/></sequence>"
            + "</env><block><line><data>${{S}}</data></line></block></tdc>";
    io.github.nickliapin.tdc.model.Config config =
        io.github.nickliapin.tdc.parser.ConfigBuilder.build(
            io.github.nickliapin.tdc.parser.TdcParserFacade.parse(text).tree());
    List<Integer> sizes =
        new ArrayList<>(io.github.nickliapin.tdc.generators.HttpColumn.batchesIn(config));
    Collections.sort(sizes);
    assertEquals(List.of(4, 6), sizes);
    assertEquals(12, io.github.nickliapin.tdc.generators.HttpColumn.alignment(config));
  }

  private static List<List<Integer>> spans(List<int[]> ranges) {
    return ranges.stream().map(r -> List.of(r[0], r[1])).toList();
  }

  @TestFactory
  Stream<DynamicTest> everySharedHttpCase() throws IOException {
    List<DynamicTest> tests = new ArrayList<>();
    // Every engine reads the same batches: the in-memory one a column at a time, the two
    // streaming ones a row at a time. 0 is the router's choice.
    for (JsonNode c : fixture().get("cases")) {
      for (int engine : new int[] {0, 1, 2, 3}) {
        String label = c.get("name").asText() + " (engine " + (engine == 0 ? "auto" : engine) + ")";
        tests.add(DynamicTest.dynamicTest(label, () -> run(c, engine)));
      }
    }
    return tests.stream();
  }

  private static TDC render(String text, int engine) {
    TDC.Options options = TDC.options().configString(text);
    return (engine == 0 ? options : options.engine(engine)).build();
  }

  private static void run(JsonNode c, int engine) throws IOException {
    try (Service service = new Service(c.get("service").asText())) {
      String text = c.get("config").asText().replace("{{SRC}}", service.url);
      if (c.has("error")) {
        String want = c.get("error").asText().replace("{{SRC}}", service.url);
        RuntimeException e =
            assertThrows(
                RuntimeException.class,
                () -> render(text, engine).toString());
        assertTrue(
            String.valueOf(e.getMessage()).contains(want),
            "got " + e.getMessage() + "\nwant " + want);
      } else {
        assertEquals(
            c.get("output").asText(), render(text, engine).toString());
      }
      if (c.has("requests")) {
        List<Seen> want = new ArrayList<>();
        for (JsonNode r : c.get("requests")) {
          want.add(
              new Seen(
                  r.get("count").asInt(),
                  r.get("offset").asInt(),
                  r.get("total").isNull() ? null : r.get("total").asInt(),
                  r.get("input").isNull() ? null : r.get("input").asInt()));
        }
        List<Seen> seen = new ArrayList<>(service.seen);
        seen.sort(Comparator.comparingInt(Seen::offset));
        assertEquals(want, seen);
      }
      if (c.has("seeds")) {
        List<String> want = new ArrayList<>();
        c.get("seeds").forEach(s -> want.add(s.asText()));
        List<String> got = new ArrayList<>(service.seeds);
        Collections.sort(got);
        assertEquals(want, got);
      }
    }
  }
}
