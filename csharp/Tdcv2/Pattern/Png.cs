using System.IO.Compression;
using System.Text;

namespace Tdcv2.Pattern;

/// <summary>
/// Reads a curve out of a picture.
/// </summary>
/// <remarks>
/// <para>
/// Somebody sketches the shape they want — in any drawing program, on any background — and points
/// a config at the file. It is the least technical way to say "the data should look like this",
/// which is exactly why it is worth supporting.
/// </para>
/// <para>
/// Decoded here rather than through a platform imaging library because the reading has to be
/// identical everywhere. Decoders differ between runtimes in how they handle palettes, gamma and
/// 16-bit samples, and a config that produced one curve on one machine and a slightly different
/// one on another would break the promise this whole project is built on.
/// </para>
/// </remarks>
public static class Png
{
    private static readonly byte[] Signature = { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a };

    /// <summary>Channels per pixel, by PNG colour type.</summary>
    private static readonly Dictionary<int, int> Channels =
        new() { [0] = 1, [2] = 3, [3] = 1, [4] = 2, [6] = 4 };

    /// <summary>A decoded picture: every colour type flattened to four bytes a pixel.</summary>
    public sealed record Image(int Width, int Height, byte[] Rgba);

    public static bool IsPng(byte[] buf)
    {
        if (buf.Length < Signature.Length)
        {
            return false;
        }

        for (int i = 0; i < Signature.Length; i++)
        {
            if (buf[i] != Signature[i])
            {
                return false;
            }
        }

        return true;
    }

    public static Image Decode(byte[] buf)
    {
        if (!IsPng(buf))
        {
            throw new ArgumentException("pattern: src is not a PNG image");
        }

        int width = 0;
        int height = 0;
        int bitDepth = 0;
        int colorType = 0;
        int interlace = 0;
        bool sawHeader = false;
        byte[]? palette = null;
        byte[]? transparency = null;
        var idat = new MemoryStream();

        int pos = Signature.Length;
        while (pos + 8 <= buf.Length)
        {
            int len = ReadInt(buf, pos);
            string type = Encoding.ASCII.GetString(buf, pos + 4, 4);
            int dataStart = pos + 8;
            int dataEnd = (int)Math.Min((long)dataStart + len, buf.Length);
            switch (type)
            {
                case "IHDR":
                    width = ReadInt(buf, dataStart);
                    height = ReadInt(buf, dataStart + 4);
                    bitDepth = At(buf, dataStart + 8);
                    colorType = At(buf, dataStart + 9);
                    interlace = At(buf, dataStart + 12);
                    sawHeader = true;
                    break;
                case "PLTE":
                    palette = buf[Math.Min(dataStart, dataEnd)..dataEnd];
                    break;
                case "tRNS":
                    transparency = buf[Math.Min(dataStart, dataEnd)..dataEnd];
                    break;
                case "IDAT":
                    idat.Write(buf, Math.Min(dataStart, dataEnd), dataEnd - Math.Min(dataStart, dataEnd));
                    break;
                default:
                    // Everything else — text, timestamps, colour profiles — says nothing about
                    // the shape.
                    break;
            }

            if (type == "IEND")
            {
                break;
            }

            pos = dataStart + len + 4; // data, then the CRC
        }

        if (!sawHeader)
        {
            throw new ArgumentException("pattern: PNG has no IHDR header");
        }

        if (interlace != 0)
        {
            throw new ArgumentException(
                "pattern: interlaced PNG is unsupported — re-export without interlacing");
        }

        if (!Channels.TryGetValue(colorType, out int channels))
        {
            throw new ArgumentException($"pattern: unsupported PNG color type {colorType}");
        }

        bool supportedDepth = bitDepth == 8 || (bitDepth == 16 && colorType != 3);
        if (!supportedDepth)
        {
            throw new ArgumentException(
                $"pattern: unsupported PNG bit depth {bitDepth} — re-export as 8-bit");
        }

        byte[] raw = Inflate(idat.ToArray());
        int bytesPerSample = bitDepth == 16 ? 2 : 1;
        int bpp = channels * bytesPerSample;
        int stride = width * bpp;
        byte[] pixels = Defilter(raw, height, stride, bpp);

        return new Image(
            width, height, ToRgba(pixels, width, height, colorType, bitDepth, palette, transparency));
    }

    private static int ReadInt(byte[] buf, int at) =>
        (At(buf, at) << 24) | (At(buf, at + 1) << 16) | (At(buf, at + 2) << 8) | At(buf, at + 3);

    private static int At(byte[] data, int i) => i >= 0 && i < data.Length ? data[i] : 0;

    /// <summary>The image data, out of PNG's zlib wrapper.</summary>
    private static byte[] Inflate(byte[] data)
    {
        try
        {
            using var input = new MemoryStream(data);
            using var zlib = new ZLibStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream(data.Length * 4);
            zlib.CopyTo(output);
            return output.ToArray();
        }
        catch (InvalidDataException e)
        {
            throw new ArgumentException("pattern: PNG image data is corrupt", e);
        }
    }

    /// <summary>
    /// Undo the per-scanline filter each row declares.
    /// </summary>
    /// <remarks>
    /// PNG picks whichever of five predictors compresses that row best, so every row has to be
    /// reconstructed against the one above it and the pixel to its left.
    /// </remarks>
    private static byte[] Defilter(byte[] raw, int height, int stride, int bpp)
    {
        var output = new byte[height * stride];
        int rawPos = 0;
        for (int y = 0; y < height; y++)
        {
            int filter = rawPos < raw.Length ? raw[rawPos++] : 0;
            int row = y * stride;
            int prev = row - stride;
            for (int x = 0; x < stride; x++)
            {
                int cur = rawPos < raw.Length ? raw[rawPos++] : 0;
                int a = x >= bpp ? output[row + x - bpp] : 0;
                int b = y > 0 ? output[prev + x] : 0;
                int c = y > 0 && x >= bpp ? output[prev + x - bpp] : 0;
                int recon = filter switch
                {
                    0 => cur,
                    1 => cur + a,
                    2 => cur + b,
                    3 => cur + ((a + b) >> 1),
                    4 => cur + Paeth(a, b, c),
                    _ => throw new ArgumentException(
                        $"pattern: PNG scanline uses unknown filter {filter}"),
                };
                output[row + x] = (byte)(recon & 0xFF);
            }
        }

        return output;
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a);
        int pb = Math.Abs(p - b);
        int pc = Math.Abs(p - c);
        if (pa <= pb && pa <= pc)
        {
            return a;
        }

        return pb <= pc ? b : c;
    }

    /// <summary>Every colour type, flattened to RGBA. Sixteen-bit samples keep their high byte.</summary>
    private static byte[] ToRgba(
        byte[] pixels, int width, int height, int colorType, int bitDepth, byte[]? palette,
        byte[]? transparency)
    {
        var rgba = new byte[width * height * 4];
        int channels = Channels.TryGetValue(colorType, out int found) ? found : 1;
        int step = bitDepth == 16 ? 2 : 1;
        int bpp = channels * step;
        int count = width * height;

        for (int i = 0; i < count; i++)
        {
            int src = i * bpp;
            int dst = i * 4;
            int r;
            int g;
            int b;
            int a = 255;
            switch (colorType)
            {
                case 0:
                    r = g = b = At(pixels, src);
                    break;
                case 2:
                    r = At(pixels, src);
                    g = At(pixels, src + step);
                    b = At(pixels, src + (2 * step));
                    break;
                case 3:
                {
                    int idx = At(pixels, src);
                    r = palette is null ? 0 : At(palette, idx * 3);
                    g = palette is null ? 0 : At(palette, (idx * 3) + 1);
                    b = palette is null ? 0 : At(palette, (idx * 3) + 2);
                    a = transparency is not null && idx < transparency.Length
                        ? At(transparency, idx)
                        : 255;
                    break;
                }

                case 4:
                    r = g = b = At(pixels, src);
                    a = At(pixels, src + step);
                    break;
                default:
                    r = At(pixels, src);
                    g = At(pixels, src + step);
                    b = At(pixels, src + (2 * step));
                    a = At(pixels, src + (3 * step));
                    break;
            }

            rgba[dst] = (byte)r;
            rgba[dst + 1] = (byte)g;
            rgba[dst + 2] = (byte)b;
            rgba[dst + 3] = (byte)a;
        }

        return rgba;
    }

    /// <summary>Perceptual brightness, 0..255 (Rec. 601).</summary>
    public static double Luminance(int r, int g, int b) => (0.299 * r) + (0.587 * g) + (0.114 * b);

    /// <summary>
    /// Where the ink is, column by column, as a top and a bottom edge.
    /// </summary>
    /// <remarks>
    /// Each column is measured from the top down and from the bottom up to the first ink. Those two
    /// readings are the band for that column: where they meet on one pixel the drawing is a single
    /// line and the value is exact; where they stand apart the value is random between them. So one
    /// picture can be a precise curve in some columns and a widening corridor in others, which is
    /// what a hand-drawn sketch naturally is.
    /// </remarks>
    public static SvgPath.Envelope Trace(Image img, double inkThreshold)
    {
        int width = img.Width;
        int height = img.Height;
        byte[] rgba = img.Rgba;
        double cut = inkThreshold * 255;

        // A drawing exported on transparency has no background at all, so there every opaque pixel
        // is the line. Only a picture flattened onto an opaque canvas needs "dark means ink".
        //
        // So the test is whether the image has any transparency at all — not whether it is opaque.
        // Getting this backwards turns a thin line into a solid block of ink, and the column then
        // reads as a full-height band instead of a curve.
        bool opaqueOnly = false;
        for (int p = 3; p < rgba.Length; p += 4)
        {
            if (rgba[p] < 128)
            {
                opaqueOnly = true;
                break;
            }
        }

        var top = new List<double[]>();
        var bottom = new List<double[]>();
        for (int x = 0; x < width; x++)
        {
            int minRow = -1;
            int maxRow = -1;
            for (int y = 0; y < height; y++)
            {
                int p = ((y * width) + x) * 4;
                bool ink;
                if (At(rgba, p + 3) < 128)
                {
                    ink = false;
                }
                else if (opaqueOnly)
                {
                    ink = true;
                }
                else
                {
                    ink = Luminance(At(rgba, p), At(rgba, p + 1), At(rgba, p + 2)) <= cut;
                }

                if (ink)
                {
                    if (minRow < 0)
                    {
                        minRow = y;
                    }

                    maxRow = y;
                }
            }

            if (minRow < 0)
            {
                // A gap in the stroke. Left out, and interpolated across by the curve.
                continue;
            }

            if (maxRow - minRow <= 1)
            {
                double mid = height - 1 - ((minRow + maxRow) / 2.0);
                top.Add(new[] { (double)x, mid });
                bottom.Add(new[] { (double)x, mid });
            }
            else
            {
                top.Add(new[] { (double)x, height - 1 - (double)minRow });
                bottom.Add(new[] { (double)x, height - 1 - (double)maxRow });
            }
        }

        if (top.Count < 2)
        {
            throw new ArgumentException(
                "pattern: the image has too little ink to read a curve from");
        }

        return new SvgPath.Envelope(top, bottom);
    }
}
