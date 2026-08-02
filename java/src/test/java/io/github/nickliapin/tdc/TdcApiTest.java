package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.errors.TdcDiagnosticException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The public surface, exercised the way the documentation says to use it. */
class TdcApiTest {

  private static final String GENDER_CONFIG =
      """
      <tdc>
        <env mode="memory" count="4" seed="demo" local="en">
          <sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
          <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
          <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
          <before><line><data>Gender,Name</data></line></before>
        </env>
        <block><line><data>${{Gender}},${{MaleName}}${{FemaleName}}</data></line></block>
      </tdc>
      """;

  private static TDC.Options config(String source) {
    return TDC.options().configString(source);
  }

  @Test
  @DisplayName("the packs inside the jar resolve a template with no configuration")
  void bundledPacksWork() {
    // No packsDir, no system property. If the bundling ever stops working this fails by name
    // rather than producing rows with empty fields.
    TDC tdc = config(GENDER_CONFIG).build();
    for (TDC.Row row : tdc.iterate()) {
      String name = row.get("MaleName") != null ? row.get("MaleName") : row.get("FemaleName");
      assertNotNull(name, "row " + row.index() + " has no name at all");
      assertFalse(name.isBlank(), "row " + row.index() + " has a blank name");
    }
  }

  @Test
  @DisplayName("the same seed produces the same output twice")
  void reproducible() {
    assertEquals(config(GENDER_CONFIG).build().toString(), config(GENDER_CONFIG).build().toString());
  }

  @Test
  @DisplayName("a different seed produces different output")
  void seedMatters() {
    String a = config(GENDER_CONFIG).seed("one").build().toString();
    String b = config(GENDER_CONFIG).seed("two").build().toString();
    assertFalse(a.equals(b), "two seeds produced identical data, so the seed is being ignored");
  }

  @Test
  @DisplayName("values set in code win over the ones in <env>")
  void overridesWin() {
    TDC tdc = config(GENDER_CONFIG).count(9).seed("from-code").build();
    assertEquals(9, tdc.count());
    assertEquals("from-code", tdc.seedInfo().seed());
    // One header line plus nine records.
    assertEquals(10, tdc.toString().stripTrailing().split("\n").length);
  }

  @Test
  @DisplayName("a parent-filtered sequence is absent, not empty, on rows it does not apply to")
  void parentFilteredRowsAreAbsent() {
    TDC tdc = config(GENDER_CONFIG).build();
    for (TDC.Row row : tdc.iterate()) {
      if ("Male".equals(row.get("Gender"))) {
        assertNull(row.get("FemaleName"), "a male row carries a female name");
        assertFalse(row.toMap().containsKey("FemaleName"));
      } else {
        assertNull(row.get("MaleName"), "a female row carries a male name");
        assertFalse(row.toMap().containsKey("MaleName"));
      }
    }
  }

  @Test
  @DisplayName("rows and text come from one run, so they cannot disagree")
  void rowsMatchText() {
    TDC tdc = config(GENDER_CONFIG).build();
    String[] lines = tdc.toString().stripTrailing().split("\n");
    List<TDC.Row> rows = tdc.toList();
    assertEquals(4, rows.size());
    for (int i = 0; i < rows.size(); i++) {
      // Line 0 is the header.
      assertTrue(
          lines[i + 1].startsWith(rows.get(i).get("Gender")),
          "row " + i + ": text says \"" + lines[i + 1] + "\" but the row says " + rows.get(i));
    }
  }

  @Test
  @DisplayName("iterate, toList and getAt agree")
  void accessorsAgree() {
    TDC tdc = config(GENDER_CONFIG).build();
    List<TDC.Row> iterated = new ArrayList<>();
    tdc.iterate().forEach(iterated::add);
    assertEquals(tdc.toList().size(), iterated.size());
    for (int i = 0; i < iterated.size(); i++) {
      assertEquals(tdc.getAt(i).toMap(), iterated.get(i).toMap());
    }
    assertThrows(IndexOutOfBoundsException.class, () -> tdc.getAt(4));
  }

  @Test
  @DisplayName("a pinned clock makes a date generator stable")
  void clockIsInjectable() {
    String source =
        """
        <tdc>
          <env mode="memory" count="3" seed="clock" local="en">
            <sequence name="Day"><gen type="date" value="today" format="ISO"/></sequence>
          </env>
          <block><line><data>${{Day}}</data></line></block>
        </tdc>
        """;
    // Parsed rather than written as a number: a hand-computed epoch millisecond is a fact
    // nobody can check by reading it, and the first version of this line was four days off.
    TDC tdc = config(source).now(Instant.parse("2026-04-23T12:00:00Z").toEpochMilli()).build();
    for (TDC.Row row : tdc.iterate()) {
      assertEquals("2026-04-23", row.get("Day"));
    }
  }

  @Test
  @DisplayName("writeFile puts exactly what toString returns on disk")
  void writesAFile(@TempDir Path dir) throws IOException {
    TDC tdc = config(GENDER_CONFIG).build();
    Path target = dir.resolve("out.csv");
    tdc.writeFile(target);
    assertEquals(tdc.toString(), Files.readString(target));
  }

  @Test
  @DisplayName("a config file is read from disk")
  void readsAConfigFile(@TempDir Path dir) throws IOException {
    Path file = dir.resolve("users.tdc");
    Files.writeString(file, GENDER_CONFIG);
    assertEquals(config(GENDER_CONFIG).build().toString(), new TDC(file).toString());
  }

  @Test
  @DisplayName("a config with no seed reports that its seed was not pinned")
  void reportsAnUnpinnedSeed() {
    String source =
        """
        <tdc>
          <env mode="memory" count="2" local="en">
            <sequence name="N"><gen type="number" value="1..9"/></sequence>
          </env>
          <block><line><data>${{N}}</data></line></block>
        </tdc>
        """;
    assertTrue(config(source).build().seedInfo().generated());
    assertFalse(config(source).seed("pinned").build().seedInfo().generated());

    // A generated seed has to BE a seed: an empty one makes the advice to re-run with it
    // reproduce nothing.
    assertFalse(config(source).build().seedInfo().seed().isEmpty());
  }

  @Test
  @DisplayName("a run that names no seed gets a fresh one, and the reported seed replays it")
  void aSeedlessRunIsFreshAndReplayable() {
    String source =
        """
        <tdc>
          <env mode="memory" count="8" local="en">
            <sequence name="N"><gen type="number" value="1..999999"/></sequence>
          </env>
          <block><line><data>${{N}}</data></line></block>
        </tdc>
        """;

    // A seedless run is a fresh sample every time, as it is in the reference.
    TDC first = config(source).build();
    TDC second = config(source).build();
    assertNotEquals(first.seedInfo().seed(), second.seedInfo().seed());
    assertNotEquals(first.toString(), second.toString());

    // And the reported seed is the way back to it — the only reason to report it.
    TDC replayed = config(source).seed(first.seedInfo().seed()).build();
    assertEquals(first.toString(), replayed.toString());
    assertFalse(replayed.seedInfo().generated());
  }

  @Test
  @DisplayName("asking for both a file and a string is rejected")
  void rejectsAmbiguousInput() {
    assertThrows(
        IllegalArgumentException.class,
        () -> TDC.options().configFile("a.tdc").configString("<tdc/>").build());
    assertThrows(IllegalArgumentException.class, () -> TDC.options().build());
  }

  @Test
  @DisplayName("a broken config is reported, not rendered")
  void rejectsBrokenConfig() {
    // The parse failure arrives as diagnostics, not as prose: that is what lets the command line
    // draw the offending line rather than only quote the message.
    TdcDiagnosticException e =
        assertThrows(
            TdcDiagnosticException.class,
            () -> config("<tdc><env mode=\"memory\" count=\"1\"></tdc>").build());
    assertFalse(e.diagnostics().isEmpty(), e.getMessage());
    assertNotNull(e.source());
  }

  @Test
  @DisplayName("preflight says nothing about a small run and stops an impossible one")
  void preflight() {
    String small =
        "<tdc><env mode=\"memory\" count=\"10\" seed=\"p\" local=\"en\">"
            + "<sequence name=\"A\"><gen type=\"text\" value=\"x,y\"/></sequence>"
            + "</env><block><line><data>${{A}}</data></line></block></tdc>";
    assertNull(
        TDC.options().configString(small).build().preflight(),
        "a ten-record run needs no warning");

    // Two hundred million records held in memory will not fit on any machine this runs on.
    io.github.nickliapin.tdc.errors.Diagnostic problem =
        TDC.options().configString(small).count(200_000_000).build().preflight();
    assertNotNull(problem, "an impossible run should say so before it starts");
    assertEquals("TDC201", problem.code());

    // The same count on a streaming engine holds one row at a time, so there is nothing to warn
    // about — which is the entire reason that engine exists.
    assertNull(
        TDC.options().configString(small).count(200_000_000).engine(2).build().preflight(),
        "a streaming run's memory does not grow with its count");
  }

  @Test
  @DisplayName("usesHttp names the one thing that makes a run irreproducible")
  void usesHttp() {
    String plain =
        "<tdc><env mode=\"memory\" count=\"2\" seed=\"h\" local=\"en\">"
            + "<sequence name=\"A\"><gen type=\"text\" value=\"x\"/></sequence>"
            + "</env><block><line><data>${{A}}</data></line></block></tdc>";
    assertFalse(TDC.options().configString(plain).build().usesHttp());

    String served =
        "<tdc><env mode=\"memory\" count=\"2\" seed=\"h\" local=\"en\">"
            + "<sequence name=\"A\"><gen type=\"http\" src=\"http://localhost:1/x\"/></sequence>"
            + "</env><block><line><data>${{A}}</data></line></block></tdc>";
    assertTrue(TDC.options().configString(served).build().usesHttp());
  }
}
