package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Seekable;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The two primitives the streaming engine is built on, against reference vectors.
 *
 * <p>Everything downstream inherits whatever these do, so they are checked digit for digit
 * before anything is built on top.
 */
class SeekableTest {

  @Test
  @DisplayName("a row's draws depend on its own index and nothing else")
  void seekableDraws() {
    assertEquals("0.395373520209", String.format("%.12f", Seekable.next("s", "col", 0)));
    assertEquals("0.622989792144", String.format("%.12f", Seekable.next("s", "col", 1)));
    assertEquals("0.050179721788", String.format("%.12f", Seekable.next("s", "col", 2)));
    assertEquals("0.171570741571", String.format("%.12f", Seekable.next("s", "col", 7)));

    assertEquals(3, Seekable.nextInt("s", "col", 0, 10));
    assertEquals(6, Seekable.nextInt("s", "col", 1, 10));
    assertEquals(0, Seekable.nextInt("s", "col", 2, 10));
    assertEquals(1, Seekable.nextInt("s", "col", 7, 10));
    assertEquals(1, Seekable.nextInt("s", "col", 99, 10));

    double[] u = Seekable.uniforms("s", "col", 3, 3);
    assertEquals("0.216913319775", String.format("%.12f", u[0]));
    assertEquals("0.496834229794", String.format("%.12f", u[1]));
    assertEquals("0.946410457720", String.format("%.12f", u[2]));
  }

  @Test
  @DisplayName("the permutation matches the reference slot for slot")
  void permutation() {
    int key = Permute.key("s", "col");
    assertEquals(968748470, key);
    assertEquals(List(0, 2, 1, 6, 5), first5(7, key));
    assertEquals(List(27, 29, 80, 78, 0), first5(100, key));
    assertEquals(List(887, 349, 633, 904, 5), first5(1000, key));
  }

  @Test
  @DisplayName("it is a bijection — every row owns exactly one slot")
  void isABijection() {
    // The property the whole design rests on. If two rows shared a slot, an exact quota would
    // be over-filled in one place and short in another, and no single row would look wrong.
    int key = Permute.key("run", "column");
    for (int n : new int[] {1, 2, 7, 64, 100, 999, 1024}) {
      Set<Integer> seen = new HashSet<>();
      for (int i = 0; i < n; i++) {
        int slot = Permute.permute(i, n, key);
        assertTrue(slot >= 0 && slot < n, "slot " + slot + " outside 0.." + n);
        assertTrue(seen.add(slot), "slot " + slot + " claimed twice at n=" + n);
        assertEquals(i, Permute.unpermute(slot, n, key), "unpermute disagreed at n=" + n);
      }
      assertEquals(n, seen.size());
    }
  }

  private static java.util.List<Integer> first5(int n, int key) {
    java.util.List<Integer> out = new java.util.ArrayList<>();
    for (int i = 0; i < 5; i++) {
      out.add(Permute.permute(i, n, key));
    }
    return out;
  }

  private static java.util.List<Integer> List(int... xs) {
    java.util.List<Integer> out = new java.util.ArrayList<>();
    for (int x : xs) {
      out.add(x);
    }
    return out;
  }
}
