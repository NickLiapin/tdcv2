package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.github.nickliapin.tdc.pattern.PatternGen;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** {@code <gen type="pattern">} — a drawing read as data, against reference vectors. */
class PatternTest {

  private static Map<String, String> attrs(String... pairs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) {
      out.put(pairs[i], pairs[i + 1]);
    }
    return out;
  }

  private static List<String> gen(Map<String, String> attrs, int count) {
    return PatternGen.generate(attrs, count, null, Prng.create("unit-test"));
  }

  @Test
  @DisplayName("a single line is a trajectory and takes no draws at all")
  void signalIsDeterministic() {
    Map<String, String> a =
        attrs("points", "0,0 5,100 10,0", "y_range", "0..10", "decimals", "2");
    assertEquals(
        List.of("0.00", "2.86", "5.71", "8.57", "8.57", "5.71", "2.86", "0.00"), gen(a, 8));
    // No draw is taken, so the seed cannot matter — a plain trend can be dropped into a config
    // without shifting any column declared after it.
    assertEquals(
        PatternGen.generate(a, 8, null, Prng.create("one")),
        PatternGen.generate(a, 8, null, Prng.create("two")));
  }

  @Test
  @DisplayName("interp changes how the line is read between points")
  void interpolationModes() {
    assertEquals(
        List.of("0.00", "3.44", "7.11", "9.62", "9.62", "7.11", "3.44", "0.00"),
        gen(
            attrs("points", "0,0 5,100 10,0", "y_range", "0..10", "decimals", "2", "interp",
                "smooth"),
            8));
    // Smooth never overshoots the drawn maximum of 10 — that is what monotone cubic buys over
    // an ordinary spline when the drawing is the specification.
    assertEquals(
        List.of("0.00", "0.00", "0.00", "0.00", "10.00", "10.00", "10.00", "0.00"),
        gen(
            attrs("points", "0,0 5,100 10,0", "y_range", "0..10", "decimals", "2", "interp",
                "step"),
            8));
  }

  @Test
  @DisplayName("y_range maps the drawing's height into real values")
  void yRange() {
    // Only the shape matters: the same drawing, read into 100..200.
    assertEquals(
        List.of("100.0", "128.6", "157.1", "185.7", "185.7", "157.1", "128.6", "100.0"),
        gen(attrs("points", "0,0 5,100 10,0", "y_range", "100..200", "decimals", "1"), 8));
  }

  @Test
  @DisplayName("spread scatters a single line into a tunnel")
  void spread() {
    assertEquals(
        List.of("0.38", "3.46", "5.84", "9.27", "7.86", "6.61", "2.59", "-0.95"),
        gen(
            attrs("points", "0,0 5,100 10,0", "y_range", "0..10", "decimals", "2", "spread", "1"),
            8));
  }

  @Test
  @DisplayName("a corridor picks a value between two lines")
  void corridor() {
    assertEquals(
        List.of("69.2", "80.0", "56.5", "84.7", "14.3", "95.0", "36.5", "2.7"),
        gen(attrs("upper", "0,10 10,10", "lower", "0,0 10,0", "y_range", "0..100", "decimals", "1"), 8));
    // With no lower line the floor is flat at zero, and it counts towards the shared extent
    // both lines are normalized against.
    assertEquals(
        List.of("34.62", "34.30", "20.16", "24.21", "3.06", "13.57", "2.61", "0.00"),
        gen(attrs("upper", "0,10 10,0", "y_range", "0..50", "decimals", "2"), 8));
  }

  @Test
  @DisplayName("mode=density reads the same drawing as a distribution")
  void density() {
    assertEquals(
        List.of("60.8", "68.4", "53.3", "72.4", "26.7", "84.2", "42.7", "11.7"),
        gen(
            attrs("points", "0,0 5,100 10,0", "y_range", "0..100", "decimals", "1", "mode",
                "density"),
            8));
    // A flat drawing has no shape to weight by, so it becomes uniform rather than an error.
    assertEquals(
        List.of("6.92", "8.00", "5.65", "8.47", "1.43", "9.50", "3.65", "0.27"),
        gen(attrs("points", "0,1 10,1", "y_range", "0..10", "decimals", "2", "mode", "density"), 8));
  }

  @Test
  @DisplayName("more points than rows are averaged, not sampled at one arbitrary place")
  void detailIsSummarised() {
    // Five drawn points squeezed into three rows: each row reads where its own line crosses the
    // spike at x=3 is not simply missed.
    assertEquals(
        List.of("0.000", "1.000", "0.000"),
        gen(
            attrs("points", "0,0 1,50 2,10 3,90 4,0", "y_range", "0..10", "decimals", "3"), 3));
  }

  @Test
  @DisplayName("a drawing that says nothing is refused, and so is a contradictory one")
  void validation() {
    assertThrows(IllegalArgumentException.class, () -> gen(attrs("decimals", "2"), 4));
    assertThrows(IllegalArgumentException.class, () -> gen(attrs("points", "0,0 5"), 4));
    assertThrows(IllegalArgumentException.class, () -> gen(attrs("points", "0,0"), 4));
    assertThrows(
        IllegalArgumentException.class,
        () -> gen(attrs("points", "0,0 1,1", "y_range", "0..100", "interp", "bezier"), 4));
    assertThrows(
        IllegalArgumentException.class,
        () -> gen(attrs("points", "0,0 1,1", "y_range", "0"), 4));
    // spread and density contradict each other: the drawing already sets the scatter.
    assertThrows(
        IllegalArgumentException.class,
        () -> gen(attrs("points", "0,0 1,1", "mode", "density", "spread", "1"), 4));
  }

  @Test
  @DisplayName("it works through a config")
  void endToEnd() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="5" seed="pat" local="en">
                    <sequence name="Load">
                      <gen type="pattern" points="0,0 5,100 10,0" y_range="0..100" decimals="1"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Load}}</data></line></block>
                </tdc>
                """)
            .build();
    // A hump: up to the middle and back down. The middle row reads 87.5 rather than the drawn
    // peak of 100 — its window straddles the vertex, so it averages across it. Checked against
    // the reference: the peak of a drawing is not guaranteed to land exactly on a row.
    assertEquals(
        List.of("0.0", "50.0", "100.0", "50.0", "0.0"),
        tdc.toList().stream().map(r -> r.get("Load")).toList());
  }
}
