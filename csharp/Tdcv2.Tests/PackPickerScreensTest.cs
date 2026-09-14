using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using Tdcv2.Cli;
using Tdcv2.Packs;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The pack picker's screens, against the shared fixture.
/// </summary>
/// <remarks>
/// <para>
/// The reference is driven by <c>typescript/scripts/picker-screens.ts</c>, which puts a fake
/// terminal in front of the real picker and records every line it draws after every key. This does
/// the same here, against the same file, so a screen that differs by one space between the two is a
/// failing test rather than something a user notices.
/// </para>
/// <para>
/// One thing this does not exercise, and the other four do: the keys arrive already named. The
/// other implementations decode a terminal's bytes from a stream, so a test can hand them bytes;
/// here <c>ReadKeyName</c> reads the console directly through <c>Console.ReadKey</c> and there is
/// no stream to hand it. What is replayed is everything after that — the navigation and every line
/// of the drawing.
/// </para>
/// </remarks>
public class PackPickerScreensTest
{
    private static readonly string Esc = ((char)27).ToString();

    private static readonly Lazy<JsonDocument> Data = new(() =>
        JsonDocument.Parse(File.ReadAllText(
            Path.Combine(PrngVectorsTest.FixturesDir(), "pack-picker-screens.json"))));

    /// <summary>The screen as the user sees it — clear, home and cursor commands carry no content.</summary>
    private static string[] ToLines(string text)
    {
        foreach (string command in new[] { Esc + "[2J", Esc + "[H", Esc + "[?25l", Esc + "[?25h" })
        {
            text = text.Replace(command, string.Empty, StringComparison.Ordinal);
        }

        if (text.EndsWith('\n'))
        {
            text = text[..^1];
        }

        return text.Split('\n');
    }

    private static List<string> Strings(JsonElement array)
    {
        var out_ = new List<string>();
        foreach (JsonElement item in array.EnumerateArray())
        {
            out_.Add(item.GetString() ?? string.Empty);
        }

        return out_;
    }

    private static List<PackRegistry.Bundle> Bundles()
    {
        var out_ = new List<PackRegistry.Bundle>();
        foreach (JsonElement b in Data.Value.RootElement.GetProperty("bundles").EnumerateArray())
        {
            JsonElement regions = b.GetProperty("regions");
            JsonElement point = b.GetProperty("point");
            out_.Add(new PackRegistry.Bundle(
                b.GetProperty("id").GetString()!,
                b.GetProperty("name").GetString()!,
                b.GetProperty("description").GetString()!,
                b.GetProperty("id").GetString()! + ".zip",
                b.GetProperty("bytes").GetInt64(),
                new string('0', 64),
                null,
                b.GetProperty("locale").GetString(),
                b.GetProperty("country").GetString(),
                Array.Empty<string>(),
                regions.ValueKind == JsonValueKind.Null ? Array.Empty<string>() : Strings(regions),
                point.ValueKind == JsonValueKind.Null
                    ? null
                    : new[] { point[0].GetDouble(), point[1].GetDouble() }));
        }

        return out_;
    }

    /// <summary>One write is one screen, because the picker draws the whole screen at once.</summary>
    private sealed class PerWrite : TextWriter
    {
        public List<string> Written { get; } = new();

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(string? value) => Written.Add(value ?? string.Empty);
    }

    [Fact]
    public void DrawsWhatTheSharedFixtureSays()
    {
        List<PackRegistry.Bundle> bundles = Bundles();

        foreach (JsonElement run in Data.Value.RootElement.GetProperty("runs").EnumerateArray())
        {
            string name = run.GetProperty("name").GetString()!;
            JsonElement terminal = run.GetProperty("terminal");
            List<string> keys = Strings(run.GetProperty("keys"));
            var installed = new HashSet<string>(Strings(run.GetProperty("installed")));

            int next = 0;
            // Past the end means the script ran out, which is a script that forgot to leave.
            string NextKey() => next < keys.Count ? keys[next++] : "quit";

            var drawn = new PerWrite();
            PackPicker.Decision? decision = PackPicker.RunOn(
                bundles,
                installed,
                drawn,
                NextKey,
                terminal.GetProperty("columns").GetInt32(),
                terminal.GetProperty("rows").GetInt32(),
                terminal.GetProperty("unicode").GetBoolean(),
                terminal.GetProperty("colour").GetBoolean());

            // The first write hides the cursor and carries no screen; everything after it is one
            // draw, ending with the clear on the way out — the empty screen the reference records
            // for the key that left.
            List<string> screens = drawn.Written.GetRange(1, drawn.Written.Count - 1);

            JsonElement want = run.GetProperty("screens");
            Assert.Equal(want.GetArrayLength(), screens.Count);
            for (int i = 0; i < want.GetArrayLength(); i++)
            {
                string after = i == 0 ? "the opening draw" : $"the key \"{keys[i - 1]}\"";
                string expected = string.Join("\n", Strings(want[i]));
                string actual = string.Join("\n", ToLines(screens[i]));
                Assert.True(
                    expected == actual,
                    $"{name}, after {after}:\n--- expected ---\n{expected}\n--- drawn ---\n{actual}");
            }

            JsonElement result = run.GetProperty("result");
            if (result.ValueKind == JsonValueKind.Null)
            {
                Assert.Null(decision);
            }
            else
            {
                Assert.NotNull(decision);
                Assert.Equal(Strings(result.GetProperty("install")), decision!.Install);
                Assert.Equal(Strings(result.GetProperty("remove")), decision.Remove);
            }
        }
    }
}
