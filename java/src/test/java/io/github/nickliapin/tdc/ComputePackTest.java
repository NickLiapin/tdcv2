package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Composed data packs and the {@code <compute>} layer that gives them check digits.
 *
 * <p>This is what separates data that looks right from data that passes validation. A generated
 * routing number without its check digit is rejected by the first system it reaches — which is
 * the system it was generated to test.
 */
class ComputePackTest {

  private static List<String> values(String address, int count) {
    TDC tdc =
        TDC.options()
            .configString(
                ("""
                 <tdc><env mode="memory" count="%d" seed="packs" local="en">
                   <sequence name="V"><gen type="template" value="%s"/></sequence>
                 </env><block><line><data>${{V}}</data></line></block></tdc>
                 """)
                    .formatted(count, address))
            .build();
    return tdc.toList().stream().map(r -> r.get("V")).toList();
  }

  @Test
  @DisplayName("a mod-10 check digit matches the reference value for value")
  void abaRouting() {
    assertEquals(
        List.of("712545125", "634135147", "271641227", "727481685", "657563039", "718685733"),
        values("usa.finance.aba_routing", 6));
  }

  @Test
  @DisplayName("the check digit is genuinely correct, not merely reproducible")
  void abaCheckDigitVerifies() {
    // The published ABA rule: 3,7,1 repeating, summed over all nine digits, must be 0 mod 10.
    // Reproducing the reference proves the two agree; this proves they are both right.
    int[] weights = {3, 7, 1, 3, 7, 1, 3, 7, 1};
    for (String value : values("usa.finance.aba_routing", 50)) {
      assertEquals(9, value.length(), value);
      int sum = 0;
      for (int i = 0; i < 9; i++) {
        sum += weights[i] * (value.charAt(i) - '0');
      }
      assertEquals(0, sum % 10, "routing number " + value + " fails its own check");
    }
  }

  @Test
  @DisplayName("choose picks the right ordinal suffix, including the teens")
  void ordinalSuffixes() {
    assertEquals(
        List.of("Sunset", "109th", "145th", "Birch", "120th", "Hickory"),
        values("usa.geo.streetName", 6));
  }

  @Test
  @DisplayName("the teen exception holds across a large sample")
  void teensAreAlwaysTh() {
    // 11th, 12th, 13th — not 11st, 12nd, 13rd. The rule most implementations get wrong.
    for (String value : values("usa.geo.streetName", 400)) {
      if (!value.matches("^\\d+(st|nd|rd|th)$")) {
        continue;
      }
      int n = Integer.parseInt(value.replaceAll("\\D+$", ""));
      String suffix = value.replaceAll("^\\d+", "");
      int m100 = n % 100;
      String expected =
          m100 >= 11 && m100 <= 13
              ? "th"
              : switch (n % 10) {
                case 1 -> "st";
                case 2 -> "nd";
                case 3 -> "rd";
                default -> "th";
              };
      assertEquals(expected, suffix, "wrong suffix on " + value);
    }
  }

  @Test
  @DisplayName("a computed sequence takes no draws, so adding one shifts nothing after it")
  void computeCostsNoRandomness() {
    String withCompute =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="5" seed="nodraw" local="en">
                  <sequence name="A"><gen type="number" value="100..999"/></sequence>
                  <sequence name="Sum"><compute>
                    <result><to_number><field name="A"/></to_number></result>
                  </compute></sequence>
                  <sequence name="B"><gen type="number" value="100..999"/></sequence>
                </env><block><line><data>${{A}},${{B}}</data></line></block></tdc>
                """)
            .build()
            .toString();
    String without =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="5" seed="nodraw" local="en">
                  <sequence name="A"><gen type="number" value="100..999"/></sequence>
                  <sequence name="B"><gen type="number" value="100..999"/></sequence>
                </env><block><line><data>${{A}},${{B}}</data></line></block></tdc>
                """)
            .build()
            .toString();
    assertEquals(without, withCompute);
  }

  @Test
  @DisplayName("a compute written inline in a config works the same way")
  void inlineCompute() {
    // A Luhn check digit, spelled out: double every second digit from the right, subtract 9
    // from anything over 9, and choose the digit that brings the total to a multiple of ten.
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc><env mode="memory" count="30" seed="luhn" local="en">
                  <sequence name="base"><gen type="regex" value="[0-9]{15}"/></sequence>
                  <sequence name="card"><compute>
                    <let name="sum">
                      <reduce>
                        <over><field name="base"/></over>
                        <init><int v="0"/></init>
                        <do>
                          <let name="doubled"><multiply><current/><int v="2"/></multiply></let>
                          <let name="folded">
                            <choose>
                              <when>
                                <test><greater_than><var name="doubled"/><int v="9"/></greater_than></test>
                                <then><subtract><var name="doubled"/><int v="9"/></subtract></then>
                              </when>
                              <otherwise><var name="doubled"/></otherwise>
                            </choose>
                          </let>
                          <add>
                            <acc/>
                            <choose>
                              <when>
                                <test><equals><mod><current_index/><int v="2"/></mod><int v="0"/></equals></test>
                                <then><var name="folded"/></then>
                              </when>
                              <otherwise><current/></otherwise>
                            </choose>
                          </add>
                        </do>
                      </reduce>
                    </let>
                    <let name="check"><mod><subtract><int v="10"/><mod><var name="sum"/><int v="10"/></mod></subtract><int v="10"/></mod></let>
                    <result><concat><field name="base"/><var name="check"/></concat></result>
                  </compute></sequence>
                </env><block><line><data>${{card}}</data></line></block></tdc>
                """)
            .build();

    for (TDC.Row row : tdc.iterate()) {
      String card = row.get("card");
      assertEquals(16, card.length(), card);
      int sum = 0;
      // Verified independently of how it was generated: every second digit from the right.
      for (int i = 0; i < 16; i++) {
        int digit = card.charAt(15 - i) - '0';
        if (i % 2 == 1) {
          digit *= 2;
          if (digit > 9) {
            digit -= 9;
          }
        }
        sum += digit;
      }
      assertEquals(0, sum % 10, card + " fails the Luhn check");
    }
  }

  @Test
  @DisplayName("a great many bundled packs resolve, not just the two checked by value")
  void bundledPacksResolve() {
    // A smoke test across shapes: plain lists, single-gen packs, and composed ones with compute.
    List<String> addresses =
        List.of(
            "common.id.uuid",
            "person.male.firstName",
            "person.lastName",
            "usa.finance.aba_routing",
            "usa.geo.streetName",
            "location.country");
    for (String address : addresses) {
      List<String> out = values(address, 3);
      assertEquals(3, out.size(), address);
      for (String value : out) {
        assertTrue(value != null && !value.isBlank(), address + " produced a blank value");
      }
    }
  }
}
