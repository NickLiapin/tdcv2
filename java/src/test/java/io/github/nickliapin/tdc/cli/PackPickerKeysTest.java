package io.github.nickliapin.tdc.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.PushbackInputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The pack picker's key decoder, against the shared vectors.
 *
 * <p>A terminal cannot say "the user pressed Page Up". It sends bytes — {@code ESC}, {@code [},
 * {@code 5}, {@code ~} — and somebody has to read them back into a name. Three of the five
 * implementations do that by hand: this one, Rust and Python. TypeScript hands the job to Node's
 * readline and C# to {@code Console.ReadKey}, so neither ever sees a raw byte, which is why these
 * vectors are read by three tests rather than five.
 *
 * <p>The half worth pinning is not the name but what is LEFT in the stream afterwards. This
 * decoder read on to the closing {@code ~} only for the four numbers it recognised, so Delete and
 * Insert returned {@code unknown} and left their {@code ~} unread — and the next turn of the
 * picker's loop took that {@code ~} for a keystroke and typed it into the search box.
 */
class PackPickerKeysTest {

  private static final Path FIXTURE =
      Path.of("..", "fixtures", "cross-language", "pack-picker-keys.json");

  private static JsonNode vectors() {
    try {
      return new ObjectMapper().readTree(Files.readString(FIXTURE)).get("keys");
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static String rest(PushbackInputStream in) {
    try {
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  @Test
  @DisplayName("names the key a terminal sent, and leaves the rest of the stream alone")
  void namesTheKeyATerminalSent() {
    for (JsonNode case_ : vectors()) {
      String name = case_.get("name").asText();
      // The same one byte of pushback the picker's loop gives it: a byte handed back is still
      // unread, and `left` is what is still unread.
      PushbackInputStream in =
          new PushbackInputStream(
              new ByteArrayInputStream(case_.get("input").asText().getBytes(StandardCharsets.UTF_8)),
              1);
      assertEquals(case_.get("key").asText(), PackPicker.Keys.read(in), "key for " + name);
      assertEquals(case_.get("left").asText(), rest(in), "left unread after " + name);
    }
  }
}
