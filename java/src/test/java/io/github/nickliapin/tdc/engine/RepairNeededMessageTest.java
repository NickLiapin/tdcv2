package io.github.nickliapin.tdc.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The refusal a too-tight {@code <uniq>} gets, worded the same in all five implementations. */
class RepairNeededMessageTest {

  private static String sentence(String rows) {
    return "uniq \"A × B\" is too tight to repair without holding the whole table ("
        + rows
        + " couldn't be placed) — run without mode=\"stream\" so the in-memory "
        + "engine can arrange it.";
  }

  @Test
  @DisplayName("the count is named as a floor when the verify stopped at the cap")
  void aFloorIsNamedAsAFloor() {
    /*
     * The scan stops as soon as it is past the cap, because nothing it could find afterwards
     * changes the answer — measured on a config that misses the cap by two orders of magnitude
     * (1,618,803 rows against 20,000), finishing the count took 6.79 s against 0.08 s to stop.
     * What it gives up is the exact figure, so the sentence stops claiming one.
     */
    assertEquals(
        sentence("more than 20000 rows"),
        new ExactUniq.RepairNeeded(20_000, "\"A × B\"", true).getMessage());
  }

  @Test
  @DisplayName("the count is named exactly when it is exact")
  void anExactCountIsNamedExactly() {
    assertEquals(sentence("1 row(s)"), new ExactUniq.RepairNeeded(1, "\"A × B\"").getMessage());
  }
}
