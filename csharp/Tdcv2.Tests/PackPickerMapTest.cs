using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Tdcv2.Cli;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The pack picker's map, against the shared fixture.
/// </summary>
/// <remarks>
/// <para>
/// The picker is about 5,600 lines across the five implementations and had no test at all — the
/// largest untested surface in the project. Most of it is a terminal loop, and a loop that reads
/// keys is not something a fixture can hold. Its geometry is, and geometry is the part five copies
/// of a coordinate table can quietly disagree about: each implementation keeps its own continent
/// outlines, so one hand-edited number would move a coastline in one language and nowhere else.
/// </para>
/// <para>
/// The tables were identical when this was written — measured, all six continents, every number.
/// The point PROJECTION was not: this implementation rounded a half away from zero and Python
/// rounded it to the even number, and 58 (country, map size) pairs among the 198 that ship land
/// on exactly a tie.
/// </para>
/// </remarks>
public class PackPickerMapTest
{
    private static readonly Lazy<JsonDocument> Data = new(() =>
        JsonDocument.Parse(File.ReadAllText(
            Path.Combine(PrngVectorsTest.FixturesDir(), "pack-picker.json"))));

    private static (int W, int H)? SizeOf(JsonElement e) =>
        e.ValueKind == JsonValueKind.Null
            ? null
            : (e.GetProperty("w").GetInt32(), e.GetProperty("h").GetInt32());

    [Fact]
    public void FitsTheMapToTheTerminal()
    {
        foreach (JsonElement c in Data.Value.RootElement.GetProperty("mapSizes").EnumerateArray())
        {
            (int W, int H)? got = PackPicker.MapSize(
                c.GetProperty("columns").GetInt32(),
                c.GetProperty("rows").GetInt32(),
                c.GetProperty("reserved").GetInt32(),
                c.GetProperty("halfBlocks").GetBoolean());
            Assert.Equal(SizeOf(c.GetProperty("size")), got);
        }
    }

    [Fact]
    public void RasterisesTheContinentsToTheSamePixels()
    {
        foreach (JsonElement c in Data.Value.RootElement.GetProperty("rasters").EnumerateArray())
        {
            var want = new List<string>();
            foreach (JsonElement row in c.GetProperty("rows").EnumerateArray())
            {
                want.Add(row.GetString()!);
            }

            Assert.Equal(
                want,
                PackPicker.MapRows(c.GetProperty("w").GetInt32(), c.GetProperty("h").GetInt32()));
        }
    }

    [Fact]
    public void PutsACountryWhereTheCountryIs()
    {
        foreach (JsonElement c in Data.Value.RootElement.GetProperty("points").EnumerateArray())
        {
            (int Col, int Row)? got = PackPicker.MapCell(
                c.GetProperty("lon").GetDouble(),
                c.GetProperty("lat").GetDouble(),
                c.GetProperty("w").GetInt32(),
                c.GetProperty("h").GetInt32());
            JsonElement want = c.GetProperty("cell");
            (int Col, int Row)? expected = want.ValueKind == JsonValueKind.Null
                ? null
                : (want.GetProperty("col").GetInt32(), want.GetProperty("row").GetInt32());
            Assert.Equal(expected, got);
        }
    }

    /// <summary>
    /// Its top-left corner is on the map and its bottom-right is just past it, the way a pixel
    /// grid works. All five agree on both.
    /// </summary>
    [Fact]
    public void TheFrameIsHalfOpen()
    {
        Assert.Equal((0, 0), PackPicker.MapCell(-170, 84, 56, 22));
        Assert.Null(PackPicker.MapCell(190, -56, 56, 22));
        Assert.Equal((55, 21), PackPicker.MapCell(189, -55, 56, 22));
        Assert.Null(PackPicker.MapCell(0, 90, 56, 22));
        Assert.Null(PackPicker.MapCell(0, -90, 56, 22));
    }

    [Fact]
    public void HalfBlocksBuyHeight()
    {
        (int W, int H)? half = PackPicker.MapSize(120, 40, 13, true);
        (int W, int H)? full = PackPicker.MapSize(120, 40, 13, false);
        Assert.NotNull(half);
        Assert.NotNull(full);
        Assert.True(half!.Value.W > full!.Value.W, $"{half.Value.W} against {full.Value.W}");
    }

    [Fact]
    public void RefusesToDrawRatherThanSquash()
    {
        Assert.Null(PackPicker.MapSize(59, 200, 0, true));
        Assert.Null(PackPicker.MapSize(200, 14, 13, true));
    }
}
