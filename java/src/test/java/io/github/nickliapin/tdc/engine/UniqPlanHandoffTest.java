package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import io.github.nickliapin.tdc.TDC;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.parser.ConfigBuilder;
import io.github.nickliapin.tdc.parser.TdcParserFacade;
import io.github.nickliapin.tdc.packs.DataPacks;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * An env-level {@code <uniq>} group splits across workers, and the workers OBEY the arrangement
 * they are handed.
 *
 * <p>Such a config runs on engine 3, which this used to refuse to split at all — so every uniq run
 * was single-threaded here while the reference spread it over the cores. It splits now, and the
 * only thing that makes that safe is that the arrangement is decided ONCE and handed down: deciding
 * which rows a group moves where is a pass over every row, and a worker repeating it would be
 * correct and slow, which is the failure that hides.
 *
 * <p>Hence two directions. With the right arrangement the split run must be byte-identical to the
 * single one. With a deliberately wrong one it must NOT be — a worker that quietly worked the
 * answer out for itself would pass the first check and fail this one.
 */
class UniqPlanHandoffTest {

  private static final String CONFIG =
      "<tdc><env count=\"400\" seed=\"pu\" local=\"en\"><uniq>"
          + "<sequence name=\"A\"><gen type=\"text\" value=\"a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t\"/></sequence>"
          + "<sequence name=\"B\"><gen type=\"number\" value=\"1..40\"/></sequence>"
          + "</uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>";

  private static final long NOW = 1_776_945_600_000L;
  private static final int WORKERS = 4;

  @Test
  @DisplayName("four workers write what one writes, and only while they are told the truth")
  void handoff() throws IOException {
    Path dir = Files.createTempDirectory("tdc-uniq-plan-");
    try {
      TDC data = TDC.options().configString(CONFIG).now(NOW).build();
      Path single = dir.resolve("one.txt");
      data.writeFile(single, 1);

      Config config = ConfigBuilder.build(TdcParserFacade.parse(CONFIG).tree());
      DataPacks packs = DataPacks.bundled();
      Map<String, Map<Integer, List<String>>> plan = new LinkedHashMap<>();
      StreamEngine.planUniq(config, packs, NOW, null, true, null, plan::put);
      assertFalse(plan.isEmpty(), "an env-level <uniq> group must produce an arrangement");

      Path many = dir.resolve("many.txt");
      Parallel.writeFile(
          config, DataPacks::bundled, NOW, null, many, WORKERS, 400, null, true, plan);
      assertArrayEquals(
          Files.readAllBytes(single),
          Files.readAllBytes(many),
          "four workers wrote different bytes than one");

      // The same run told something false: every moved row sent to one tuple, which cannot be
      // what the honest analysis produced.
      Map<String, Map<Integer, List<String>>> forged = new LinkedHashMap<>();
      for (Map.Entry<String, Map<Integer, List<String>>> entry : plan.entrySet()) {
        Map<Integer, List<String>> moved = new LinkedHashMap<>();
        for (Integer row : entry.getValue().keySet()) {
          List<String> tuple = new ArrayList<>();
          tuple.add("zzz");
          tuple.add("1");
          moved.put(row, tuple);
        }
        forged.put(entry.getKey(), moved);
      }
      assertNotNull(forged);

      Path wrong = dir.resolve("wrong.txt");
      Parallel.writeFile(
          config, DataPacks::bundled, NOW, null, wrong, WORKERS, 400, null, true, forged);
      assertFalse(
          java.util.Arrays.equals(Files.readAllBytes(single), Files.readAllBytes(wrong)),
          "the workers ignored the arrangement they were handed");
    } finally {
      try (java.util.stream.Stream<Path> walk = Files.walk(dir)) {
        walk.sorted(java.util.Comparator.reverseOrder())
            .forEach(
                p -> {
                  try {
                    Files.deleteIfExists(p);
                  } catch (IOException ignored) {
                    // A temp file left behind does not make a passing test a failing one.
                  }
                });
      }
    }
  }
}
