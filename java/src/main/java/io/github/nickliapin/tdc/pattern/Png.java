package io.github.nickliapin.tdc.pattern;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * Reads a curve out of a picture.
 *
 * <p>Somebody sketches the shape they want — in any drawing program, on any background — and
 * points a config at the file. It is the least technical way to say "the data should look like
 * this", which is exactly why it is worth supporting.
 *
 * <p>Decoded here rather than through {@code javax.imageio} because the reading has to be
 * identical everywhere. A platform decoder differs between JDKs in how it handles palettes,
 * gamma and 16-bit samples, and a config that produced one curve on one machine and a slightly
 * different one on another would break the promise this whole project is built on.
 */
public final class Png {

  private static final int[] SIGNATURE = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};

  /** Channels per pixel, by PNG colour type. */
  private static final Map<Integer, Integer> CHANNELS =
      Map.of(0, 1, 2, 3, 3, 1, 4, 2, 6, 4);

  public record Image(int width, int height, byte[] rgba) {}

  private Png() {}

  public static boolean isPng(byte[] buf) {
    if (buf.length < SIGNATURE.length) {
      return false;
    }
    for (int i = 0; i < SIGNATURE.length; i++) {
      if ((buf[i] & 0xFF) != SIGNATURE[i]) {
        return false;
      }
    }
    return true;
  }

  public static Image decode(byte[] buf) {
    if (!isPng(buf)) {
      throw new IllegalArgumentException("pattern: src is not a PNG image");
    }

    int width = 0;
    int height = 0;
    int bitDepth = 0;
    int colorType = 0;
    int interlace = 0;
    boolean sawHeader = false;
    byte[] palette = null;
    byte[] transparency = null;
    ByteArrayOutputStream idat = new ByteArrayOutputStream();

    int pos = 8;
    while (pos + 8 <= buf.length) {
      int len = readInt(buf, pos);
      String type = new String(buf, pos + 4, 4, java.nio.charset.StandardCharsets.US_ASCII);
      int dataStart = pos + 8;
      switch (type) {
        case "IHDR" -> {
          width = readInt(buf, dataStart);
          height = readInt(buf, dataStart + 4);
          bitDepth = buf[dataStart + 8] & 0xFF;
          colorType = buf[dataStart + 9] & 0xFF;
          interlace = buf[dataStart + 12] & 0xFF;
          sawHeader = true;
        }
        case "PLTE" -> palette = java.util.Arrays.copyOfRange(buf, dataStart, dataStart + len);
        case "tRNS" -> transparency = java.util.Arrays.copyOfRange(buf, dataStart, dataStart + len);
        case "IDAT" -> idat.write(buf, dataStart, len);
        default -> {
          // Everything else — text, timestamps, colour profiles — says nothing about the shape.
        }
      }
      if ("IEND".equals(type)) {
        break;
      }
      pos = dataStart + len + 4; // data, then the CRC
    }

    if (!sawHeader) {
      throw new IllegalArgumentException("pattern: PNG has no IHDR header");
    }
    if (interlace != 0) {
      throw new IllegalArgumentException(
          "pattern: interlaced PNG is unsupported — re-export without interlacing");
    }
    Integer channels = CHANNELS.get(colorType);
    if (channels == null) {
      throw new IllegalArgumentException("pattern: unsupported PNG color type " + colorType);
    }
    boolean supportedDepth = bitDepth == 8 || (bitDepth == 16 && colorType != 3);
    if (!supportedDepth) {
      throw new IllegalArgumentException(
          "pattern: unsupported PNG bit depth " + bitDepth + " — re-export as 8-bit");
    }

    byte[] raw = inflate(idat.toByteArray());
    int bytesPerSample = bitDepth == 16 ? 2 : 1;
    int bpp = channels * bytesPerSample;
    int stride = width * bpp;
    byte[] pixels = defilter(raw, height, stride, bpp);

    return new Image(
        width, height, toRgba(pixels, width, height, colorType, bitDepth, palette, transparency));
  }

  private static int readInt(byte[] buf, int at) {
    return ((buf[at] & 0xFF) << 24)
        | ((buf[at + 1] & 0xFF) << 16)
        | ((buf[at + 2] & 0xFF) << 8)
        | (buf[at + 3] & 0xFF);
  }

  private static byte[] inflate(byte[] data) {
    Inflater inflater = new Inflater();
    inflater.setInput(data);
    ByteArrayOutputStream out = new ByteArrayOutputStream(data.length * 4);
    byte[] chunk = new byte[16384];
    try {
      while (!inflater.finished()) {
        int n = inflater.inflate(chunk);
        if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) {
          break;
        }
        out.write(chunk, 0, n);
      }
    } catch (DataFormatException e) {
      throw new IllegalArgumentException("pattern: PNG image data is corrupt", e);
    } finally {
      inflater.end();
    }
    return out.toByteArray();
  }

  /**
   * Undo the per-scanline filter each row declares.
   *
   * <p>PNG picks whichever of five predictors compresses that row best, so every row has to be
   * reconstructed against the one above it and the pixel to its left.
   */
  private static byte[] defilter(byte[] raw, int height, int stride, int bpp) {
    byte[] out = new byte[height * stride];
    int rawPos = 0;
    for (int y = 0; y < height; y++) {
      int filter = rawPos < raw.length ? raw[rawPos++] & 0xFF : 0;
      int row = y * stride;
      int prev = row - stride;
      for (int x = 0; x < stride; x++) {
        int cur = rawPos < raw.length ? raw[rawPos++] & 0xFF : 0;
        int a = x >= bpp ? out[row + x - bpp] & 0xFF : 0;
        int b = y > 0 ? out[prev + x] & 0xFF : 0;
        int c = y > 0 && x >= bpp ? out[prev + x - bpp] & 0xFF : 0;
        int recon =
            switch (filter) {
              case 0 -> cur;
              case 1 -> cur + a;
              case 2 -> cur + b;
              case 3 -> cur + ((a + b) >> 1);
              case 4 -> cur + paeth(a, b, c);
              default -> throw new IllegalArgumentException(
                  "pattern: PNG scanline uses unknown filter " + filter);
            };
        out[row + x] = (byte) (recon & 0xFF);
      }
    }
    return out;
  }

  private static int paeth(int a, int b, int c) {
    int p = a + b - c;
    int pa = Math.abs(p - a);
    int pb = Math.abs(p - b);
    int pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) {
      return a;
    }
    return pb <= pc ? b : c;
  }

  /** Every colour type, flattened to RGBA. Sixteen-bit samples keep their high byte. */
  private static byte[] toRgba(
      byte[] pixels,
      int width,
      int height,
      int colorType,
      int bitDepth,
      byte[] palette,
      byte[] transparency) {
    byte[] rgba = new byte[width * height * 4];
    int channels = CHANNELS.getOrDefault(colorType, 1);
    int step = bitDepth == 16 ? 2 : 1;
    int bpp = channels * step;
    int count = width * height;

    for (int i = 0; i < count; i++) {
      int src = i * bpp;
      int dst = i * 4;
      int r;
      int g;
      int b;
      int a = 255;
      switch (colorType) {
        case 0 -> {
          r = g = b = at(pixels, src);
        }
        case 2 -> {
          r = at(pixels, src);
          g = at(pixels, src + step);
          b = at(pixels, src + 2 * step);
        }
        case 3 -> {
          int idx = at(pixels, src);
          r = palette == null ? 0 : at(palette, idx * 3);
          g = palette == null ? 0 : at(palette, idx * 3 + 1);
          b = palette == null ? 0 : at(palette, idx * 3 + 2);
          a = transparency != null && idx < transparency.length ? at(transparency, idx) : 255;
        }
        case 4 -> {
          r = g = b = at(pixels, src);
          a = at(pixels, src + step);
        }
        default -> {
          r = at(pixels, src);
          g = at(pixels, src + step);
          b = at(pixels, src + 2 * step);
          a = at(pixels, src + 3 * step);
        }
      }
      rgba[dst] = (byte) r;
      rgba[dst + 1] = (byte) g;
      rgba[dst + 2] = (byte) b;
      rgba[dst + 3] = (byte) a;
    }
    return rgba;
  }

  private static int at(byte[] data, int i) {
    return i >= 0 && i < data.length ? data[i] & 0xFF : 0;
  }

  public static double luminance(int r, int g, int b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  /**
   * Where the ink is, column by column, as a top and a bottom edge.
   *
   * <p>Each column is measured from the top down and from the bottom up to the first ink. Those
   * two readings are the band for that column: where they meet on one pixel the drawing is a
   * single line and the value is exact; where they stand apart the value is random between them.
   * So one picture can be a precise curve in some columns and a widening corridor in others,
   * which is what a hand-drawn sketch naturally is.
   */
  public static SvgPath.Envelope trace(Image img, double inkThreshold) {
    int width = img.width();
    int height = img.height();
    byte[] rgba = img.rgba();
    double cut = inkThreshold * 255;

    // A drawing exported on transparency has no background at all, so there every opaque pixel
    // is the line. Only a picture flattened onto an opaque canvas needs "dark means ink".
    //
    // So the test is whether the image has any transparency at all — not whether it is opaque.
    // Getting this backwards turns a thin line into a solid block of ink, and the column then
    // reads as a full-height band instead of a curve.
    boolean anyTransparent = false;
    for (int p = 3; p < rgba.length; p += 4) {
      if ((rgba[p] & 0xFF) < 128) {
        anyTransparent = true;
        break;
      }
    }
    boolean opaqueOnly = anyTransparent;

    List<double[]> top = new ArrayList<>();
    List<double[]> bottom = new ArrayList<>();
    for (int x = 0; x < width; x++) {
      int minRow = -1;
      int maxRow = -1;
      for (int y = 0; y < height; y++) {
        int p = (y * width + x) * 4;
        boolean ink;
        if ((rgba[p + 3] & 0xFF) < 128) {
          ink = false;
        } else if (opaqueOnly) {
          ink = true;
        } else {
          ink = luminance(rgba[p] & 0xFF, rgba[p + 1] & 0xFF, rgba[p + 2] & 0xFF) <= cut;
        }
        if (ink) {
          if (minRow < 0) {
            minRow = y;
          }
          maxRow = y;
        }
      }
      if (minRow < 0) {
        // A gap in the stroke. Left out, and interpolated across by the curve.
        continue;
      }
      if (maxRow - minRow <= 1) {
        double mid = height - 1 - (minRow + maxRow) / 2.0;
        top.add(new double[] {x, mid});
        bottom.add(new double[] {x, mid});
      } else {
        top.add(new double[] {x, height - 1 - minRow});
        bottom.add(new double[] {x, height - 1 - maxRow});
      }
    }
    if (top.size() < 2) {
      throw new IllegalArgumentException("pattern: the image has too little ink to read a curve from");
    }
    return new SvgPath.Envelope(top, bottom);
  }
}
