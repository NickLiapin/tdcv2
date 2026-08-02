/**
 * The Java runner: config in, file out, nothing else.
 *
 * <p>Run straight from the jar rather than through Gradle — Gradle's own startup is on the order
 * of a second, which would swamp the short-config measurement entirely.
 *
 * <pre>java -cp &lt;classpath&gt; Bench &lt;config&gt; &lt;output&gt;</pre>
 */
import io.github.nickliapin.tdc.TDC;
import java.nio.file.Path;

public final class Bench {
  public static void main(String[] args) {
    TDC.options()
        .configFile(Path.of(args[0]))
        .now(1776945600000L)
        .build()
        .writeFile(Path.of(args[1]));
  }
}
