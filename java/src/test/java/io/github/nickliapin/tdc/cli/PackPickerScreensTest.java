package io.github.nickliapin.tdc.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.packs.PackRegistry;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The pack picker's screens, against the shared fixture.
 *
 * <p>The reference is driven by {@code typescript/scripts/picker-screens.ts}, which puts a fake
 * terminal in front of the real picker and records every line it draws after every key. This does
 * the same here, against the same file, so a screen that differs by one space between the two is a
 * failing test rather than something a user notices.
 *
 * <p>The seam is {@code PackPicker.Terminal}. A JVM cannot set its own environment variables, so
 * the detection that reads {@code TDCV2_ASCII} and {@code NO_COLOR} cannot be steered from a test
 * the way it can in the other four implementations — the answers are handed in instead, along with
 * the width, the height, and streams that are arrays of bytes rather than a terminal.
 */
class PackPickerScreensTest {

  private static final String ESC = Character.toString(27);
  private static final Path FIXTURE =
      Path.of("..", "fixtures", "cross-language", "pack-picker-screens.json");

  /** What a terminal sends for each key the fixture names; anything else is the character itself. */
  private static String bytesFor(String key) {
    return switch (key) {
      case "up" -> ESC + "[A";
      case "down" -> ESC + "[B";
      case "right" -> ESC + "[C";
      case "left" -> ESC + "[D";
      case "home" -> ESC + "[1~";
      case "end" -> ESC + "[4~";
      case "pageup" -> ESC + "[5~";
      case "pagedown" -> ESC + "[6~";
      case "enter" -> "\r";
      case "space" -> " ";
      case "backspace" -> Character.toString(127);
      case "escape" -> ESC;
      default -> key;
    };
  }

  /** The screen as the user sees it — clear, home and cursor commands carry no content. */
  private static List<String> toLines(String text) {
    String clean = text;
    for (String command : List.of(ESC + "[2J", ESC + "[H", ESC + "[?25l", ESC + "[?25h")) {
      clean = clean.replace(command, "");
    }
    if (clean.endsWith("\n")) {
      clean = clean.substring(0, clean.length() - 1);
    }
    return List.of(clean.split("\n", -1));
  }

  private static JsonNode fixture() {
    try {
      return new ObjectMapper().readTree(Files.readString(FIXTURE));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static List<PackRegistry.Bundle> bundles(JsonNode all) {
    List<PackRegistry.Bundle> out = new ArrayList<>();
    for (JsonNode b : all) {
      JsonNode regions = b.get("regions");
      List<String> in = new ArrayList<>();
      if (!regions.isNull()) {
        for (JsonNode region : regions) {
          in.add(region.asText());
        }
      }
      JsonNode point = b.get("point");
      out.add(
          new PackRegistry.Bundle(
              b.get("id").asText(),
              b.get("name").asText(),
              b.get("description").asText(),
              b.get("id").asText() + ".zip",
              b.get("bytes").asLong(),
              "0".repeat(64),
              null,
              b.get("locale").isNull() ? null : b.get("locale").asText(),
              b.get("country").isNull() ? null : b.get("country").asText(),
              List.of(),
              in,
              point.isNull()
                  ? null
                  : new double[] {point.get(0).asDouble(), point.get(1).asDouble()}));
    }
    return out;
  }

  @Test
  @DisplayName("draws what the shared fixture says, line for line, after every key")
  void drawsWhatTheSharedFixtureSays() {
    JsonNode fixture = fixture();
    List<PackRegistry.Bundle> bundles = bundles(fixture.get("bundles"));

    for (JsonNode run : fixture.get("runs")) {
      String name = run.get("name").asText();
      JsonNode terminal = run.get("terminal");

      StringBuilder keys = new StringBuilder();
      for (JsonNode key : run.get("keys")) {
        keys.append(bytesFor(key.asText()));
      }
      Set<String> installed = new HashSet<>();
      for (JsonNode id : run.get("installed")) {
        installed.add(id.asText());
      }

      // One print is one screen, because the picker draws the whole screen in a single call.
      List<String> drawn = new ArrayList<>();
      PrintStream out =
          new PrintStream(OutputStream.nullOutputStream(), true, StandardCharsets.UTF_8) {
            @Override
            public void print(String text) {
              drawn.add(text);
            }
          };

      PackPicker.Decision decision =
          PackPicker.run(
              bundles,
              installed,
              new PackPicker.Terminal(
                  new ByteArrayInputStream(keys.toString().getBytes(StandardCharsets.UTF_8)),
                  out,
                  terminal.get("columns").asInt(),
                  terminal.get("rows").asInt(),
                  terminal.get("unicode").asBoolean(),
                  terminal.get("colour").asBoolean()));

      // The first print hides the cursor and carries no screen; everything after it is one draw,
      // ending with the clear on the way out — the empty screen the reference records for the key
      // that left.
      List<String> screens = drawn.subList(1, drawn.size());

      JsonNode want = run.get("screens");
      assertEquals(want.size(), screens.size(), "number of screens in " + name);
      for (int i = 0; i < want.size(); i++) {
        List<String> expected = new ArrayList<>();
        for (JsonNode line : want.get(i)) {
          expected.add(line.asText());
        }
        String after = i == 0 ? "the opening draw" : "the key \"" + run.get("keys").get(i - 1) + "\"";
        assertEquals(
            String.join("\n", expected),
            String.join("\n", toLines(screens.get(i))),
            name + ", after " + after);
      }

      JsonNode result = run.get("result");
      if (result.isNull()) {
        assertEquals(null, decision, "result of " + name);
      } else {
        List<String> install = new ArrayList<>();
        for (JsonNode id : result.get("install")) {
          install.add(id.asText());
        }
        List<String> remove = new ArrayList<>();
        for (JsonNode id : result.get("remove")) {
          remove.add(id.asText());
        }
        assertEquals(install, decision.install(), "install of " + name);
        assertEquals(remove, decision.remove(), "remove of " + name);
      }
    }
  }
}
