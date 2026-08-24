package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The one rising scale the {@code uniq-repair} phase is reported on.
 *
 * <p>The repair is several steps with different units — candidate groups, pool rows, a deal per
 * sweep. Reported straight, each step would restart the counter at zero and a bar drawn from the
 * phase would jump backwards every time one ended, which reads as a bug rather than as progress.
 */
class RepairReportTest {

  private record Tick(int done, int total) {}

  @Test
  @DisplayName("a new step lifts the floor instead of resetting it")
  void stepsAccumulate() {
    List<Tick> seen = new ArrayList<>();
    ExactUniq.RepairReport report =
        new ExactUniq.RepairReport((phase, done, total) -> seen.add(new Tick(done, total)));

    report.step(3);
    report.at(1);
    report.at(2);
    report.step(5);
    report.at(1);
    report.finish();

    assertEquals(
        List.of(
            new Tick(0, 3), // three units taken on
            new Tick(1, 3),
            new Tick(2, 3),
            new Tick(3, 8), // the first step is behind us, five more taken on
            new Tick(4, 8),
            new Tick(8, 8)), // closed full
        seen);
  }

  @Test
  @DisplayName("the phase is named, so a watcher can say what the run is doing")
  void reportsUnderTheRepairPhase() {
    List<String> phases = new ArrayList<>();
    ExactUniq.RepairReport report =
        new ExactUniq.RepairReport((phase, done, total) -> phases.add(phase));
    report.step(1);
    assertEquals(List.of("uniq-repair"), phases);
  }

  @Test
  @DisplayName("no listener, no work")
  void toleratesNoListener() {
    ExactUniq.RepairReport report = new ExactUniq.RepairReport(null);
    report.step(2);
    report.at(1);
    report.finish();
  }
}
