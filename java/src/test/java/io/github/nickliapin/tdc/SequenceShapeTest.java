package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The two sequence shapes beyond "one gen, one value": compound and conditional. */
class SequenceShapeTest {

  @Test
  @DisplayName("a compound sequence registers each field under Name.Field")
  void compoundFields() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="5" seed="compound" local="en">
                    <sequence name="Address">
                      <gen name="Kind" type="template" value="address.buildingType"/>
                      <gen name="House" type="number" value="1..200"/>
                      <gen name="Zip" type="number" value="10000..99999"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Address.Kind}} ${{Address.House}}, ${{Address.Zip}}</data></line></block>
                </tdc>
                """)
            .build();

    for (TDC.Row row : tdc.iterate()) {
      assertNotNull(row.get("Address.Kind"), "row " + row.index());
      int house = Integer.parseInt(row.get("Address.House"));
      assertTrue(house >= 1 && house <= 200, "house " + house);
      assertEquals(5, row.get("Address.Zip").length());
    }
  }

  @Test
  @DisplayName("a compound reads as one nested value, not several siblings")
  void compoundNests() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="2" seed="nest" local="en">
                    <sequence name="Id"><gen type="increment" value="1"/></sequence>
                    <sequence name="Person">
                      <gen name="First" type="template" value="person.male.firstName"/>
                      <gen name="Last" type="template" value="person.lastName"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Id}}</data></line></block>
                </tdc>
                """)
            .build();

    Map<String, Object> row = tdc.getAt(0).nested();
    assertEquals("1", row.get("Id"));
    assertTrue(row.get("Person") instanceof Map, "Person should be a nested map");
    @SuppressWarnings("unchecked")
    Map<String, String> person = (Map<String, String>) row.get("Person");
    assertEquals(2, person.size());
    assertNotNull(person.get("First"));
    assertNotNull(person.get("Last"));
  }

  @Test
  @DisplayName("a conditional sequence takes its first matching branch")
  void conditionalBranches() {
    TDC tdc =
        TDC.options()
            .configString(
                """
                <tdc>
                  <env mode="memory" count="40" seed="cond" local="en">
                    <sequence name="Age"><gen type="number" value="1..80"/></sequence>
                    <sequence name="Group">
                      <gen if="Age < 18" type="text" value="minor"/>
                      <gen if="Age < 65" type="text" value="adult"/>
                      <gen type="text" value="senior"/>
                    </sequence>
                  </env>
                  <block><line><data>${{Age}},${{Group}}</data></line></block>
                </tdc>
                """)
            .build();

    for (TDC.Row row : tdc.iterate()) {
      int age = Integer.parseInt(row.get("Age"));
      String expected = age < 18 ? "minor" : age < 65 ? "adult" : "senior";
      assertEquals(expected, row.get("Group"), "age " + age);
    }
  }

  @Test
  @DisplayName("every branch is generated, so the stream does not depend on which one won")
  void everyBranchCostsItsDraws() {
    // Two configs with the same generators but different conditions. If only the winning branch
    // were generated, the column after the conditional would differ between them.
    String template =
        """
        <tdc>
          <env mode="memory" count="10" seed="branches" local="en">
            <sequence name="N"><gen type="number" value="1..100"/></sequence>
            <sequence name="Pick">
              <gen if="%s" type="symbol" alphabet="latin.lower" length="2"/>
              <gen type="symbol" alphabet="latin.upper" length="2"/>
            </sequence>
            <sequence name="After"><gen type="number" value="1000..9999"/></sequence>
          </env>
          <block><line><data>${{After}}</data></line></block>
        </tdc>
        """;
    String always = TDC.options().configString(template.formatted("N > 0")).build().toString();
    String never = TDC.options().configString(template.formatted("N > 1000")).build().toString();
    assertEquals(always, never, "the column after a conditional shifted with the branch taken");
  }
}
