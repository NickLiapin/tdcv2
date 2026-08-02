package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.errors.TdcDiagnosticException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code row="key"} — several columns read from one real record.
 *
 * <p>This is the coherence feature in its plainest form. Drawing a city and a postcode
 * independently from the same file produces pairings that exist nowhere, and a person looking at
 * the data spots it immediately. Linking them means the pair came from a row somebody wrote down.
 */
class RowLinkTest {

  private static final Map<String, String> ZIP_OF =
      Map.of("Perm", "614000", "Omsk", "644000", "Tomsk", "634000");
  private static final Map<String, String> REGION_OF =
      Map.of("Perm", "Perm Krai", "Omsk", "Omsk Oblast", "Tomsk", "Tomsk Oblast");

  private static Path places(Path dir) throws IOException {
    Path file = dir.resolve("places.csv");
    Files.writeString(
        file,
        "city,zip,region\nPerm,614000,Perm Krai\nOmsk,644000,Omsk Oblast\nTomsk,634000,Tomsk Oblast\n");
    return file;
  }

  private static TDC linked(Path dir, int count) {
    return TDC.options()
        .configString(
            ("<tdc><env mode=\"memory\" count=\"%d\" seed=\"rowlink\" local=\"en\">"
                    + "<sequence name=\"City\"><gen type=\"file\" src=\"places.csv\" column=\"city\" row=\"place\"/></sequence>"
                    + "<sequence name=\"Zip\"><gen type=\"file\" src=\"places.csv\" column=\"zip\" row=\"place\"/></sequence>"
                    + "<sequence name=\"Region\"><gen type=\"file\" src=\"places.csv\" column=\"region\" row=\"place\"/></sequence>"
                    + "</env><block><line><data>${{City}}|${{Zip}}|${{Region}}</data></line></block></tdc>")
                .formatted(count))
        .baseDir(dir)
        .build();
  }

  @Test
  @DisplayName("linked columns come from one row, and match the reference exactly")
  void matchesTheReference(@TempDir Path dir) throws IOException {
    places(dir);
    // Captured from the reference with this config and seed.
    assertEquals(
        List.of(
            "Tomsk|634000|Tomsk Oblast",
            "Tomsk|634000|Tomsk Oblast",
            "Perm|614000|Perm Krai",
            "Omsk|644000|Omsk Oblast",
            "Perm|614000|Perm Krai",
            "Tomsk|634000|Tomsk Oblast"),
        linked(dir, 6).toString().lines().toList());
  }

  @Test
  @DisplayName("the pairing holds over a long run, not just the captured one")
  void pairingAlwaysHolds(@TempDir Path dir) throws IOException {
    places(dir);
    for (TDC.Row row : linked(dir, 300).iterate()) {
      String city = row.get("City");
      assertEquals(ZIP_OF.get(city), row.get("Zip"), "row " + row.index() + " city " + city);
      assertEquals(REGION_OF.get(city), row.get("Region"), "row " + row.index());
    }
  }

  @Test
  @DisplayName("adding a field to a link draws nothing extra, so nothing after it shifts")
  void joiningALinkIsFree(@TempDir Path dir) throws IOException {
    places(dir);
    String twoFields =
        TDC.options()
            .configString(
                "<tdc><env mode=\"memory\" count=\"5\" seed=\"free\" local=\"en\">"
                    + "<sequence name=\"City\"><gen type=\"file\" src=\"places.csv\" column=\"city\" row=\"p\"/></sequence>"
                    + "<sequence name=\"Zip\"><gen type=\"file\" src=\"places.csv\" column=\"zip\" row=\"p\"/></sequence>"
                    + "<sequence name=\"After\"><gen type=\"number\" value=\"1000..9999\"/></sequence>"
                    + "</env><block><line><data>${{City}} ${{After}}</data></line></block></tdc>")
            .baseDir(dir)
            .build()
            .toString();
    String oneField =
        TDC.options()
            .configString(
                "<tdc><env mode=\"memory\" count=\"5\" seed=\"free\" local=\"en\">"
                    + "<sequence name=\"City\"><gen type=\"file\" src=\"places.csv\" column=\"city\" row=\"p\"/></sequence>"
                    + "<sequence name=\"After\"><gen type=\"number\" value=\"1000..9999\"/></sequence>"
                    + "</env><block><line><data>${{City}} ${{After}}</data></line></block></tdc>")
            .baseDir(dir)
            .build()
            .toString();
    // Only the first sequence on a link draws the plan, so the second one is free.
    assertEquals(oneField, twoFields);
  }

  @Test
  @DisplayName("one key cannot span two different files")
  void oneKeyOneSource(@TempDir Path dir) throws IOException {
    places(dir);
    Files.writeString(dir.resolve("other.csv"), "city,zip\nKazan,420000\n");
    IllegalStateException e =
        assertThrows(
            IllegalStateException.class,
            () ->
                TDC.options()
                    .configString(
                        "<tdc><env mode=\"memory\" count=\"3\" seed=\"mix\" local=\"en\">"
                            + "<sequence name=\"A\"><gen type=\"file\" src=\"places.csv\" column=\"city\" row=\"k\"/></sequence>"
                            + "<sequence name=\"B\"><gen type=\"file\" src=\"other.csv\" column=\"zip\" row=\"k\"/></sequence>"
                            + "</env><block><line><data>${{A}}${{B}}</data></line></block></tdc>")
                    .baseDir(dir)
                    .build()
                    .toString());
    assertTrue(e.getMessage().contains("cannot mix different file sources"), e.getMessage());
  }

  @Test
  @DisplayName("a linked read needs a column to link on")
  void columnIsRequired(@TempDir Path dir) throws IOException {
    places(dir);
    TdcDiagnosticException e =
        assertThrows(
            TdcDiagnosticException.class,
            () ->
                TDC.options()
                    .configString(
                        "<tdc><env mode=\"memory\" count=\"3\" seed=\"c\" local=\"en\">"
                            + "<sequence name=\"A\"><gen type=\"file\" src=\"places.csv\" row=\"k\"/></sequence>"
                            + "</env><block><line><data>${{A}}</data></line></block></tdc>")
                    .baseDir(dir)
                    .build());
    // Caught by the validator now, before a single row is read — which is where it belongs.
    assertTrue(
        e.diagnostics().stream().anyMatch(d -> "TDC064".equals(d.code())), e.getMessage());
    assertTrue(e.getMessage().contains("require a CSV \"column\""), e.getMessage());
  }
}
