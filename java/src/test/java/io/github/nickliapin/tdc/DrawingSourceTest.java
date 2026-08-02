package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code <gen type="pattern" src="…">} — a drawing read from a file.
 *
 * <p>Every expectation here was captured from the reference with the same files. A curve read
 * from a picture is where two implementations can most easily agree in shape and differ in
 * numbers, so the numbers are what is compared.
 */
class DrawingSourceTest {

  private static final String CURVE_SVG =
      """
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <path d="M 0 40 C 25 40 25 10 50 10 S 75 40 100 40" fill="none" stroke="black"/>
      </svg>
      """;

  private static final String BAND_SVG =
      """
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
        <g transform="translate(0,0)">
          <polyline points="0,10 50,5 100,15" fill="none" stroke="black"/>
          <polyline points="0,40 50,30 100,45" fill="none" stroke="black"/>
        </g>
      </svg>
      """;

  private static List<String> read(Path dir, String file) {
    return TDC.options()
        .configString(
            ("<tdc><env mode=\"memory\" count=\"6\" seed=\"draw\" local=\"en\">"
                    + "<sequence name=\"V\"><gen type=\"pattern\" src=\"%s\" y_range=\"0..100\" decimals=\"1\"/></sequence>"
                    + "</env><block><line><data>${{V}}</data></line></block></tdc>")
                .formatted(file))
        .baseDir(dir)
        .build()
        .toString()
        .lines()
        .toList();
  }

  @Test
  @DisplayName("an SVG path, curves and all, matches the reference")
  void svgCurve(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("curve.svg"), CURVE_SVG);
    // A cubic and a smooth-curve shorthand, flattened. Dropping either would give a shape that
    // still looks like a curve and is the wrong one.
    assertEquals(List.of("2.1", "33.5", "90.4", "90.4", "33.5", "2.1"), read(dir, "curve.svg"));
  }

  @Test
  @DisplayName("two strokes are read as a band, and a transform is honoured")
  void svgBand(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("band.svg"), BAND_SVG);
    assertEquals(
        List.of("33.4", "49.7", "39.8", "39.8", "69.1", "66.7"), read(dir, "band.svg"));
  }

  @Test
  @DisplayName("a PNG is traced column by column, and matches the reference")
  void png(@TempDir Path dir) throws IOException {
    Files.write(dir.resolve("line.png"), diagonalPng(20, 10));
    // The picture's own height is the value scale, so the diagonal spans the whole range.
    assertEquals(
        List.of("100.0", "87.2", "66.0", "45.1", "24.0", "8.1"), read(dir, "line.png"));
  }

  @Test
  @DisplayName("a drawing with nothing in it is refused, not silently flat")
  void emptyDrawing(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("blank.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    IllegalArgumentException e =
        assertThrows(IllegalArgumentException.class, () -> read(dir, "blank.svg"));
    assertTrue(e.getMessage().contains("no <path>"), e.getMessage());
  }

  /** A black diagonal on white, written by hand so the test owns every byte of it. */
  private static byte[] diagonalPng(int width, int height) throws IOException {
    java.io.ByteArrayOutputStream raw = new java.io.ByteArrayOutputStream();
    for (int y = 0; y < height; y++) {
      raw.write(0); // filter: none
      for (int x = 0; x < width; x++) {
        boolean ink = Math.abs(x * (height - 1) / (width - 1) - y) == 0;
        raw.write(ink ? 0 : 255);
        raw.write(ink ? 0 : 255);
        raw.write(ink ? 0 : 255);
      }
    }

    java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
    png.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});

    java.io.ByteArrayOutputStream ihdr = new java.io.ByteArrayOutputStream();
    writeInt(ihdr, width);
    writeInt(ihdr, height);
    ihdr.write(8); // bit depth
    ihdr.write(2); // colour type: RGB
    ihdr.write(0);
    ihdr.write(0);
    ihdr.write(0);
    writeChunk(png, "IHDR", ihdr.toByteArray());
    writeChunk(png, "IDAT", deflate(raw.toByteArray()));
    writeChunk(png, "IEND", new byte[0]);
    return png.toByteArray();
  }

  private static void writeInt(java.io.ByteArrayOutputStream out, int value) {
    out.write(value >>> 24);
    out.write(value >>> 16);
    out.write(value >>> 8);
    out.write(value);
  }

  private static void writeChunk(java.io.ByteArrayOutputStream out, String type, byte[] data)
      throws IOException {
    writeInt(out, data.length);
    byte[] body = new byte[4 + data.length];
    System.arraycopy(type.getBytes(java.nio.charset.StandardCharsets.US_ASCII), 0, body, 0, 4);
    System.arraycopy(data, 0, body, 4, data.length);
    out.write(body);
    CRC32 crc = new CRC32();
    crc.update(body);
    writeInt(out, (int) crc.getValue());
  }

  private static byte[] deflate(byte[] data) {
    Deflater deflater = new Deflater();
    deflater.setInput(data);
    deflater.finish();
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] chunk = new byte[4096];
    while (!deflater.finished()) {
      out.write(chunk, 0, deflater.deflate(chunk));
    }
    deflater.end();
    return out.toByteArray();
  }
}
