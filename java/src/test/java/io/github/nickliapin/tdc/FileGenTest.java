package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** {@code <gen type="file">} — the generator that reads the user's own data. */
class FileGenTest {

  private static TDC tdc(Path dir, String body) {
    return TDC.options()
        .configString(
            "<tdc><env mode=\"memory\" count=\"20\" seed=\"file\" local=\"en\">"
                + body
                + "</env><block><line><data>${{V}}</data></line></block></tdc>")
        .baseDir(dir)
        .build();
  }

  private static Set<String> valuesOf(TDC tdc) {
    Set<String> seen = new HashSet<>();
    for (TDC.Row row : tdc.iterate()) {
      seen.add(row.get("V"));
    }
    return seen;
  }

  @Test
  @DisplayName("a plain list file, one value per line")
  void listFile(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("codes.txt"), "alpha\n\n  beta  \ngamma\n");
    Set<String> seen = valuesOf(tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"codes.txt\"/></sequence>"));
    // Blank lines are skipped and values are trimmed, so " beta " is "beta".
    assertEquals(Set.of("alpha", "beta", "gamma"), seen);
  }

  @Test
  @DisplayName("a CSV column by header name")
  void csvByName(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("users.csv"), "id,email,city\n1,a@x.io,Perm\n2,b@x.io,Omsk\n");
    Set<String> seen =
        valuesOf(tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"users.csv\" column=\"email\"/></sequence>"));
    assertEquals(Set.of("a@x.io", "b@x.io"), seen);
  }

  @Test
  @DisplayName("a CSV column by 1-based position keeps the first row unless told otherwise")
  void csvByPosition(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("data.csv"), "one,two\nthree,four\n");
    // A numbered column means the file may have no header, so nothing is skipped by default.
    assertEquals(
        Set.of("one", "three"),
        valuesOf(tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"data.csv\" column=\"1\"/></sequence>")));
    assertEquals(
        Set.of("three"),
        valuesOf(
            tdc(
                dir,
                "<sequence name=\"V\"><gen type=\"file\" src=\"data.csv\" column=\"1\" header=\"true\"/></sequence>")));
  }

  @Test
  @DisplayName("quoted fields survive the delimiter and the quotes inside them")
  void quotedFields(@TempDir Path dir) throws IOException {
    Files.writeString(
        dir.resolve("products.csv"),
        "name,price\n\"Knife set, 3 pcs\",10\n\"say \"\"hi\"\"\",20\n");
    assertEquals(
        Set.of("Knife set, 3 pcs", "say \"hi\""),
        valuesOf(
            tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"products.csv\" column=\"name\"/></sequence>")));
  }

  @Test
  @DisplayName("delimiters can be named, and a real tab is taken as written")
  void delimiters(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("t.csv"), "a\tb\nx\ty\n");
    assertEquals(
        Set.of("x"),
        valuesOf(
            tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"t.csv\" column=\"a\" delimiter=\"tab\"/></sequence>")));
    Files.writeString(dir.resolve("s.csv"), "a;b\np;q\n");
    assertEquals(
        Set.of("p"),
        valuesOf(
            tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"s.csv\" column=\"a\" delimiter=\";\"/></sequence>")));
  }

  @Test
  @DisplayName("a byte-order mark does not hide the first column's name")
  void byteOrderMark(@TempDir Path dir) throws IOException {
    // Excel writes one ahead of the first header cell on every "Save as CSV".
    Files.writeString(dir.resolve("excel.csv"), "﻿id,name\n7,Ann\n");
    assertEquals(
        Set.of("7"),
        valuesOf(tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"excel.csv\" column=\"id\"/></sequence>")));
  }

  @Test
  @DisplayName("a relative src resolves against the config file, not the working directory")
  void relativeToTheConfig(@TempDir Path dir) throws IOException {
    Path sub = Files.createDirectories(dir.resolve("configs"));
    Files.writeString(sub.resolve("codes.txt"), "only\n");
    Files.writeString(
        sub.resolve("run.tdc"),
        """
        <tdc><env mode="memory" count="2" seed="rel" local="en">
          <sequence name="V"><gen type="file" src="codes.txt"/></sequence>
        </env><block><line><data>${{V}}</data></line></block></tdc>
        """);
    assertEquals("only\nonly\n", new TDC(sub.resolve("run.tdc")).toString());
  }

  @Test
  @DisplayName("a missing file, an empty one, and an unknown column are all reported")
  void failures(@TempDir Path dir) throws IOException {
    assertThrows(
        RuntimeException.class,
        () -> tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"nope.txt\"/></sequence>").toString());

    Files.writeString(dir.resolve("empty.txt"), "\n\n");
    assertThrows(
        IllegalArgumentException.class,
        () -> tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"empty.txt\"/></sequence>").toString());

    Files.writeString(dir.resolve("u.csv"), "a,b\n1,2\n");
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                tdc(dir, "<sequence name=\"V\"><gen type=\"file\" src=\"u.csv\" column=\"missing\"/></sequence>")
                    .toString());
    assertTrue(e.getMessage().contains("was not found in the header row"), e.getMessage());
  }
}
