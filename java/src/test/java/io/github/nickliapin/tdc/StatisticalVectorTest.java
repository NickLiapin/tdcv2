package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.generators.Imperfections;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.stats.Distribution;
import io.github.nickliapin.tdc.stats.Timeseries;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The statistical layer against vectors captured from the reference.
 *
 * <p>These need exact vectors more than anything else in the port. Gamma and beta are inverted
 * numerically, so "the values look gamma-ish" would pass for an implementation that converged to
 * a slightly different place on every row; only the digits show that.
 */
class StatisticalVectorTest {

  private static Prng.Sfc32 prng() {
    return Prng.create("unit-test");
  }

  private static Map<String, String> attrs(String... pairs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) {
      out.put(pairs[i], pairs[i + 1]);
    }
    return out;
  }

  private static void assertDistribution(Map<String, String> attrs, String... expected) {
    Prng.Sfc32 prng = prng();
    Distribution.Spec spec = Distribution.parse(attrs);
    List<String> out = new ArrayList<>();
    for (int i = 0; i < expected.length; i++) {
      double[] uniforms = new double[spec.draws()];
      for (int d = 0; d < spec.draws(); d++) {
        uniforms[d] = Distribution.openUnit(prng.next());
      }
      out.add(Distribution.format(Distribution.sample(spec, uniforms), spec));
    }
    assertEquals(List.of(expected), out, attrs.get("distribution"));
  }

  @Test
  @DisplayName("normal and lognormal, two draws each")
  void normalFamily() {
    assertDistribution(
        attrs("distribution", "normal", "mean", "170", "sd", "10", "decimals", "2"),
        "172.67", "176.14", "188.76", "183.98", "165.65", "160.54");
    assertDistribution(
        attrs("distribution", "lognormal", "meanlog", "10", "sdlog", "1", "decimals", "0"),
        "28755", "40720", "143725", "89136", "14263", "8549");
  }

  @Test
  @DisplayName("the closed-form inverses, one draw each")
  void closedFormInverses() {
    assertDistribution(
        attrs("distribution", "exponential", "rate", "0.5", "decimals", "3"),
        "0.735", "0.445", "1.143", "0.331", "3.892", "0.103");
    assertDistribution(
        attrs("distribution", "pareto", "alpha", "1.5", "xmin", "100", "decimals", "1"),
        "219.5", "292.7", "174.1", "350.2", "110.8", "735.1");
    assertDistribution(
        attrs("distribution", "weibull", "shape", "2", "scale", "5", "decimals", "3"),
        "3.031", "2.360", "3.780", "2.034", "6.975", "1.134");
  }

  @Test
  @DisplayName("the discrete tables, sampled by binary search from one draw")
  void discreteTables() {
    assertDistribution(attrs("distribution", "poisson", "lambda", "4"), "5", "6", "4", "6", "2", "8");
    assertDistribution(
        attrs("distribution", "zipf", "n", "20", "s", "1.2"), "5", "8", "3", "10", "1", "16");
  }

  @Test
  @DisplayName("gamma and beta, inverted numerically to the same digits as the reference")
  void numericallyInverted() {
    assertDistribution(
        attrs("distribution", "gamma", "shape", "2", "scale", "3", "decimals", "4"),
        "7.2120", "8.9893", "5.6824", "10.0513", "1.9871", "14.2193");
    assertDistribution(
        attrs("distribution", "beta", "alpha", "2", "beta", "5", "decimals", "5"),
        "0.35620", "0.42267", "0.29301", "0.45911", "0.11400", "0.58149");
  }

  @Test
  @DisplayName("min and max clip the sample rather than redrawing it")
  void clipping() {
    // A redraw would cost a variable number of draws; clipping costs none, and piles a little
    // mass on each bound, which is the documented trade.
    assertDistribution(
        attrs("distribution", "normal", "mean", "0", "sd", "1", "decimals", "1", "min", "-1", "max", "1"),
        "0.3", "0.6", "1.0", "1.0", "-0.4", "-0.9");
  }

  @Test
  @DisplayName("a distribution with a missing or impossible parameter is refused")
  void distributionValidation() {
    assertThrows(
        IllegalArgumentException.class, () -> Distribution.parse(attrs("distribution", "normal")));
    assertThrows(
        IllegalArgumentException.class,
        () -> Distribution.parse(attrs("distribution", "normal", "mean", "0", "sd", "0")));
    assertThrows(
        IllegalArgumentException.class, () -> Distribution.parse(attrs("distribution", "cauchy")));
    assertThrows(
        IllegalArgumentException.class,
        () -> Distribution.parse(attrs("distribution", "poisson", "lambda", "5000")));
  }

  @Test
  @DisplayName("a timeseries with no noise takes no draws at all")
  void timeseriesWithoutNoise() {
    assertEquals(
        List.of("100", "102", "104", "106", "108", "110"),
        Timeseries.generate(attrs("base", "100", "trend", "2", "decimals", "0"), 6, prng()));

    // The seed cannot matter when nothing is drawn — which is what makes a trend-only column
    // safe to insert without disturbing the columns after it.
    assertEquals(
        Timeseries.generate(attrs("base", "100", "trend", "2"), 6, Prng.create("one")),
        Timeseries.generate(attrs("base", "100", "trend", "2"), 6, Prng.create("two")));
  }

  @Test
  @DisplayName("a seasonal wave repeats on its period")
  void timeseriesSeasonality() {
    assertEquals(
        List.of("100.00", "110.50", "101.00", "91.50", "102.00", "112.50"),
        Timeseries.generate(
            attrs("base", "100", "trend", "0.5", "period", "4", "amplitude", "10", "decimals", "2"),
            6,
            prng()));
  }

  @Test
  @DisplayName("noise costs two draws a row, by Box-Muller")
  void timeseriesNoise() {
    assertEquals(
        List.of("50.800", "51.843", "55.627", "54.194", "48.696", "47.161"),
        Timeseries.generate(attrs("base", "50", "noise", "3", "decimals", "3"), 6, prng()));
  }

  @Test
  @DisplayName("missing blanks a row with the token it was given")
  void missingValues() {
    List<String> values = new ArrayList<>(List.of("a", "b", "c", "d", "e", "f"));
    Imperfections.applyMissing(
        values, Imperfections.parseMissing(attrs("missing", "0.4", "missing_as", "NULL")), prng());
    assertEquals(List.of("a", "b", "c", "d", "NULL", "f"), values);
  }

  @Test
  @DisplayName("missing=\"0\" takes no draws, so adding it changes nothing downstream")
  void missingZeroTakesNoDraws() {
    Prng.Sfc32 shared = prng();
    List<String> values = new ArrayList<>(List.of("a", "b", "c"));
    Imperfections.applyMissing(values, Imperfections.parseMissing(attrs("missing", "0")), shared);
    assertEquals(List.of("a", "b", "c"), values);
    // The stream is untouched, so the next draw is the first one.
    assertEquals(prng().next(), shared.next());
  }

  @Test
  @DisplayName("anomaly spikes the numbers it selects and flags every row it selected")
  void anomalies() {
    List<String> values = new ArrayList<>(List.of("1", "2", "3", "4", "5", "x"));
    boolean[] flags = new boolean[6];
    Imperfections.applyAnomaly(
        values, Imperfections.parseAnomaly(attrs("anomaly", "0.3")), prng(), flags);
    assertEquals(List.of("1", "2", "3", "4", "50", "x"), values);
    assertArrayEquals(new boolean[] {false, false, false, false, true, false}, flags);
  }

  @Test
  @DisplayName("a probability outside [0, 1] is refused")
  void probabilityValidation() {
    assertThrows(
        IllegalArgumentException.class, () -> Imperfections.parseMissing(attrs("missing", "1.5")));
    assertThrows(
        IllegalArgumentException.class, () -> Imperfections.parseMissing(attrs("missing", "-0.1")));
    assertThrows(
        IllegalArgumentException.class, () -> Imperfections.parseAnomaly(attrs("anomaly", "two")));
  }

  @Test
  @DisplayName("the whole pipeline runs through a config")
  void endToEnd() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="200" seed="stats" local="en">
                    <sequence name="Height">
                      <gen type="number" distribution="normal" mean="170" sd="10" decimals="1"/>
                    </sequence>
                    <sequence name="Reading">
                      <gen type="timeseries" base="20" trend="0.1" noise="0.5" decimals="2" missing="0.1" missing_as="NA"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Height}},${{Reading}}</data></line></block>
                </tdc>
                """)
            .build();

    long blank = 0;
    double sum = 0;
    for (TDC.Row row : tdc.iterate()) {
      sum += Double.parseDouble(row.get("Height"));
      if ("NA".equals(row.get("Reading"))) {
        blank++;
      }
    }
    // Loose bounds on purpose: this asks whether the pieces are wired together, not whether the
    // arithmetic is right — the vectors above already settled that.
    assertTrue(Math.abs(sum / 200 - 170) < 3, "mean height was " + sum / 200);
    assertTrue(blank > 5 && blank < 40, "blanked " + blank + " of 200 at p=0.1");
  }
}
