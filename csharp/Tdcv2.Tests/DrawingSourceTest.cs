using System.IO.Compression;

namespace Tdcv2.Tests;

/// <summary>
/// <c>&lt;gen type="pattern" src="…"&gt;</c> — a drawing read from a file.
/// </summary>
/// <remarks>
/// Every expectation here was captured from the reference with the same files. A curve read from a
/// picture is where two implementations can most easily agree in shape and differ in numbers, so
/// the numbers are what is compared.
/// </remarks>
public class DrawingSourceTest : IDisposable
{
    private const string CurveSvg =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 50\">\n"
        + "  <path d=\"M 0 40 C 25 40 25 10 50 10 S 75 40 100 40\" fill=\"none\" stroke=\"black\"/>\n"
        + "</svg>\n";

    private const string BandSvg =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 50\">\n"
        + "  <g transform=\"translate(0,0)\">\n"
        + "    <polyline points=\"0,10 50,5 100,15\" fill=\"none\" stroke=\"black\"/>\n"
        + "    <polyline points=\"0,40 50,30 100,45\" fill=\"none\" stroke=\"black\"/>\n"
        + "  </g>\n"
        + "</svg>\n";

    private readonly string _dir = Directory.CreateDirectory(
        Path.Combine(Path.GetTempPath(), "tdcv2-drawing-" + Guid.NewGuid().ToString("N"))).FullName;

    public void Dispose()
    {
        Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }

    private string[] Read(string file)
    {
        string config =
            "<tdc><env mode=\"memory\" count=\"6\" seed=\"draw\" local=\"en\">"
            + "<sequence name=\"V\"><gen type=\"pattern\" src=\"" + file
            + "\" y_range=\"0..100\" decimals=\"1\"/></sequence>"
            + "</env><block><line><data>${{V}}</data></line></block></tdc>";
        return new Tdc(new Tdc.Options { ConfigString = config, BaseDir = _dir })
            .ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);
    }

    [Fact]
    public void AnSvgPathCurvesAndAllMatchesTheReference()
    {
        File.WriteAllText(Path.Combine(_dir, "curve.svg"), CurveSvg);
        // A cubic and a smooth-curve shorthand, flattened. Dropping either would give a shape that
        // still looks like a curve and is the wrong one.
        Assert.Equal(new[] { "2.1", "33.5", "90.4", "90.4", "33.5", "2.1" }, Read("curve.svg"));
    }

    [Fact]
    public void TwoStrokesAreABandAndATransformIsHonoured()
    {
        File.WriteAllText(Path.Combine(_dir, "band.svg"), BandSvg);
        Assert.Equal(new[] { "33.4", "49.7", "39.8", "39.8", "69.1", "66.7" }, Read("band.svg"));
    }

    [Fact]
    public void APngIsTracedColumnByColumnAndMatchesTheReference()
    {
        File.WriteAllBytes(Path.Combine(_dir, "line.png"), DiagonalPng(20, 10));
        // The picture's own height is the value scale, so the diagonal spans the whole range.
        Assert.Equal(
            new[] { "100.0", "87.2", "66.0", "45.1", "24.0", "8.1" }, Read("line.png"));
    }

    [Fact]
    public void ADrawingWithNothingInItIsRefusedNotSilentlyFlat()
    {
        File.WriteAllText(
            Path.Combine(_dir, "blank.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        ArgumentException e = Assert.Throws<ArgumentException>(() => Read("blank.svg"));
        Assert.Contains("no <path>", e.Message, StringComparison.Ordinal);
    }

    // ── a PNG written by hand, so the test owns every byte of it ──────────────────────────────

    /// <summary>A black diagonal on white.</summary>
    private static byte[] DiagonalPng(int width, int height)
    {
        var raw = new MemoryStream();
        for (int y = 0; y < height; y++)
        {
            raw.WriteByte(0); // filter: none
            for (int x = 0; x < width; x++)
            {
                bool ink = x * (height - 1) / (width - 1) == y;
                byte v = ink ? (byte)0 : (byte)255;
                raw.Write(new[] { v, v, v });
            }
        }

        var png = new MemoryStream();
        png.Write(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 0x0d, 0x0a, 0x1a, 0x0a });

        var ihdr = new MemoryStream();
        WriteInt(ihdr, width);
        WriteInt(ihdr, height);
        ihdr.Write(new byte[] { 8, 2, 0, 0, 0 }); // 8-bit, RGB, no interlace
        Chunk(png, "IHDR", ihdr.ToArray());
        Chunk(png, "IDAT", Deflate(raw.ToArray()));
        Chunk(png, "IEND", Array.Empty<byte>());
        return png.ToArray();
    }

    private static void WriteInt(Stream output, int value)
    {
        uint v = unchecked((uint)value);
        output.Write(new[] { (byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v });
    }

    private static void Chunk(Stream output, string type, byte[] data)
    {
        WriteInt(output, data.Length);
        var body = new byte[4 + data.Length];
        System.Text.Encoding.ASCII.GetBytes(type).CopyTo(body, 0);
        data.CopyTo(body, 4);
        output.Write(body);
        WriteInt(output, unchecked((int)Crc32(body)));
    }

    private static byte[] Deflate(byte[] data)
    {
        using var output = new MemoryStream();
        using (var zlib = new ZLibStream(output, CompressionMode.Compress, leaveOpen: true))
        {
            zlib.Write(data);
        }

        return output.ToArray();
    }

    private static uint Crc32(byte[] data)
    {
        uint crc = 0xFFFFFFFF;
        foreach (byte b in data)
        {
            crc ^= b;
            for (int i = 0; i < 8; i++)
            {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1;
            }
        }

        return ~crc;
    }
}
