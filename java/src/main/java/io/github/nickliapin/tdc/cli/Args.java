package io.github.nickliapin.tdc.cli;

import io.github.nickliapin.tdc.date.Calendar;
import io.github.nickliapin.tdc.date.DateParse;
import java.util.ArrayList;
import java.util.List;

/**
 * The command line, parsed by hand.
 *
 * <p>No argument library. The TypeScript CLI is the interface users already know, and matching it
 * exactly matters more than the lines saved: {@code --engine 2} and {@code --engine=2} both work
 * there, an unknown flag exits 2 with a specific message, and a positional argument may follow
 * flags. Making a general parser agree on all of that costs more than writing the loop, and leaves
 * the agreement undocumented.
 *
 * <p>Kept apart from {@link Main} so the parsing can be tested without a filesystem or a run.
 */
public final class Args {

  private Args() {}

  /** A command line that cannot be obeyed. Reported, then exit code 2. */
  public static final class UsageException extends RuntimeException {

    private static final long serialVersionUID = 1L;
    public UsageException(String message) {
      super(message);
    }
  }

  /** What the command line asked for, before anything has been read or run. */
  public record Options(
      String input,
      String output,
      String seed,
      Integer count,
      String locale,
      Long now,
      List<String> dataPaths,
      Integer jobs,
      String mode,
      Integer engine,
      boolean progress,
      boolean help,
      boolean version) {}

  /** Mutable while parsing; a record once it is done. */
  private static final class Builder {
    String input;
    String output;
    String seed;
    Integer count;
    String locale;
    Long now;
    final List<String> dataPaths = new ArrayList<>();
    Integer jobs;
    String mode;
    Integer engine;
    boolean progress;
    boolean help;
    boolean version;

    Options build() {
      return new Options(
          input, output, seed, count, locale, now, List.copyOf(dataPaths), jobs, mode, engine,
          progress, help, version);
    }
  }

  /** The generate command's arguments. Throws {@link UsageException} with the message to print. */
  public static Options parse(List<String> argv) {
    Builder out = new Builder();

    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);

      int equals = arg.startsWith("--") ? arg.indexOf('=') : -1;
      if (equals > 0) {
        String name = arg.substring(0, equals);
        String value = arg.substring(equals + 1);
        if (value.isEmpty()) {
          throw new UsageException("missing value for " + name);
        }
        if (isValued(name)) {
          store(out, name, value);
          continue;
        }
      }

      if (isValued(arg) || arg.equals("-o")) {
        String name = arg.equals("-o") ? "--output" : arg;
        i++;
        if (i >= argv.size() || argv.get(i).isEmpty()) {
          throw new UsageException("missing value for " + name);
        }
        store(out, name, argv.get(i));
      } else if (arg.equals("-h") || arg.equals("--help")) {
        out.help = true;
      } else if (arg.equals("-v") || arg.equals("--version")) {
        out.version = true;
      } else if (arg.equals("--stream")) {
        // The legacy spelling of --engine 2, kept because configs and scripts still say it.
        out.engine = 2;
      } else if (arg.equals("--disk")) {
        out.mode = "disk";
      } else if (arg.equals("--progress")) {
        out.progress = true;
      } else if (arg.startsWith("-")) {
        throw new UsageException("unknown option: " + arg);
      } else if (out.input == null) {
        out.input = arg;
      } else {
        throw new UsageException("unexpected positional argument: " + arg);
      }
    }
    return out.build();
  }

  private static boolean isValued(String name) {
    return switch (name) {
      case "--output", "--seed", "--count", "--locale", "--now", "--data-path", "--jobs", "--mode",
              "--engine" ->
          true;
      default -> false;
    };
  }

  private static void store(Builder out, String name, String value) {
    switch (name) {
      case "--output" -> out.output = value;
      case "--seed" -> out.seed = value;
      case "--locale" -> out.locale = value;
      case "--now" -> out.now = nowMillis(value);
      case "--data-path" -> out.dataPaths.add(value);
      case "--count" -> out.count = nonNegative(value, "--count");
      case "--jobs" -> out.jobs = positive(value, "--jobs");
      case "--engine" -> {
        if (!value.equals("1") && !value.equals("2") && !value.equals("3")) {
          throw new UsageException(
              "invalid --engine \""
                  + value
                  + "\" — expected 1 (in-memory), 2 (streaming), or 3 (exact-on-disk)");
        }
        out.engine = Integer.valueOf(value);
      }
      case "--mode" -> {
        if (!value.equals("memory") && !value.equals("disk")) {
          throw new UsageException(
              "invalid --mode \"" + value + "\" — expected \"memory\" or \"disk\"");
        }
        out.mode = value;
      }
      default -> throw new UsageException("unknown option: " + name);
    }
  }

  /**
   * The clock {@code --now} pins, in milliseconds since the epoch.
   *
   * <p>The syntax is the date generator's own — whatever {@code <gen type="date" value="…">}
   * accepts is what this accepts, down to the same parser — so the project has one date syntax
   * rather than two. It carries no zone, so like every date in the engine it is read as UTC. A
   * value that does not parse is refused rather than falling back to the real clock, which would
   * hand back the very irreproducibility the flag exists to remove.
   */
  private static long nowMillis(String value) {
    try {
      return Calendar.toEpochMillis(DateParse.dateTime(value).value());
    } catch (IllegalArgumentException e) {
      throw new UsageException(
          "invalid --now \"" + value + "\" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)");
    }
  }

  private static int nonNegative(String value, String flag) {
    int parsed = integer(value, flag, "a non-negative integer");
    if (parsed < 0) {
      throw new UsageException(
          "invalid " + flag + " \"" + value + "\" — expected a non-negative integer");
    }
    return parsed;
  }

  private static int positive(String value, String flag) {
    int parsed = integer(value, flag, "a positive integer");
    if (parsed < 1) {
      throw new UsageException(
          "invalid " + flag + " \"" + value + "\" — expected a positive integer");
    }
    return parsed;
  }

  private static int integer(String value, String flag, String expected) {
    try {
      return Integer.parseInt(value);
    } catch (NumberFormatException e) {
      throw new UsageException("invalid " + flag + " \"" + value + "\" — expected " + expected);
    }
  }
}
