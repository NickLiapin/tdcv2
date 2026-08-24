package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The `--progress` channel: what a watcher is promised about the numbers it is given. */
class ProgressTest {

  /** One report, as it reaches a listener. */
  private record Tick(String phase, int done, int total) {}

  /** 400 rows drawn from 480 pairs, so the repair is certain to run and to report. */
  private static String uniqConfig() {
    List<String> a = new ArrayList<>();
    for (int i = 0; i < 40; i++) {
      a.add("a" + i);
    }
    return """
        <tdc><env count="400" seed="p" local="en" mode="disk"><uniq>
        <sequence name="A"><gen type="text" value="%s"/></sequence>
        <sequence name="B"><gen type="text" value="m,n,o,p,q,r,s,t,u,v,w,x"/></sequence>
        </uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>"""
        .formatted(String.join(",", a));
  }

  private static List<Tick> ticks() {
    List<Tick> seen = new ArrayList<>();
    TDC.options()
        .configString(uniqConfig())
        .onProgress((phase, done, total) -> seen.add(new Tick(phase, done, total)))
        .build()
        .toString();
    return seen;
  }

  @Test
  @DisplayName("the repair reports, and the render follows it")
  void phasesArriveInOrder() {
    Set<String> order = new LinkedHashSet<>();
    for (Tick tick : ticks()) {
      order.add(tick.phase());
    }
    assertEquals(List.of("uniq-repair", "render"), List.copyOf(order));
  }

  @Test
  @DisplayName("within a phase, neither the count nor the scale ever goes backwards")
  void numbersOnlyRise() {
    /*
     * What a progress bar needs. The repair is several steps with different units — pool rows,
     * then a deal per sweep — reported on ONE rising scale for exactly this reason. Reported
     * straight, the counter would restart at every step and the bar would jump backwards, which
     * reads as a bug rather than as progress.
     */
    for (String phase : List.of("uniq-repair", "render")) {
      List<Tick> of = ticks().stream().filter(t -> t.phase().equals(phase)).toList();
      assertTrue(of.size() > 1, phase + " reported once or not at all");
      for (int i = 1; i < of.size(); i++) {
        assertTrue(of.get(i).done() >= of.get(i - 1).done(), phase + " count fell");
        assertTrue(of.get(i).total() >= of.get(i - 1).total(), phase + " scale shrank");
        assertTrue(of.get(i).done() <= of.get(i).total(), phase + " ran past its scale");
      }
    }
  }

  @Test
  @DisplayName("a phase ends at its total, so a watcher can tell it from a stall")
  void phasesCloseFull() {
    for (String phase : List.of("uniq-repair", "render")) {
      List<Tick> of = ticks().stream().filter(t -> t.phase().equals(phase)).toList();
      Tick last = of.get(of.size() - 1);
      assertEquals(last.total(), last.done(), phase + " stopped short of its own total");
    }
  }
}
