package io.github.nickliapin.tdc.errors;

import java.util.List;

/**
 * A config that cannot be run, with everything wrong with it rather than the first thing.
 *
 * <p>Reporting one error at a time turns fixing a config into a guessing loop, so the validator
 * collects them all and this carries the set — along with the source they refer to, so a caller
 * that wants the full block can render the offending lines rather than only naming them. The
 * message is the one-line form, for a caller that only logs {@code getMessage()}.
 *
 * <p>Extends {@link IllegalArgumentException} because that is what the constructor threw before,
 * and code that catches the old type keeps working.
 */
public final class TdcDiagnosticException extends IllegalArgumentException {

  private static final long serialVersionUID = 1L;

  private final transient List<Diagnostic> diagnostics;
  private final String source;

  public TdcDiagnosticException(List<Diagnostic> diagnostics, String source) {
    super(summarize(diagnostics));
    this.diagnostics = List.copyOf(diagnostics);
    this.source = source;
  }

  /** Everything wrong with the config, not only the first thing. */
  public List<Diagnostic> diagnostics() {
    return diagnostics;
  }

  /** The config text the diagnostics point into, for rendering the offending lines. */
  public String source() {
    return source;
  }

  /**
   * The one-line form.
   *
   * <p>Matches the reference implementation's wording, because a script that greps the message
   * should not have to know which language produced it.
   */
  public static String summarize(List<Diagnostic> diagnostics) {
    if (diagnostics.isEmpty()) {
      return "TDC: unknown error";
    }
    Diagnostic first = diagnostics.get(0);
    if (diagnostics.size() == 1) {
      return first.severity()
          + ": "
          + first.message()
          + " (line "
          + first.line()
          + ", col "
          + (first.column() + 1)
          + ")";
    }

    int errors = 0;
    for (Diagnostic diagnostic : diagnostics) {
      if (diagnostic.severity() == Diagnostic.Severity.ERROR) {
        errors++;
      }
    }
    int warnings = diagnostics.size() - errors;

    StringBuilder parts = new StringBuilder();
    if (errors > 0) {
      parts.append(errors).append(" error").append(errors == 1 ? "" : "s");
    }
    if (warnings > 0) {
      if (parts.length() > 0) {
        parts.append(", ");
      }
      parts.append(warnings).append(" warning").append(warnings == 1 ? "" : "s");
    }
    return parts
        + "; first: "
        + first.message()
        + " (line "
        + first.line()
        + ", col "
        + (first.column() + 1)
        + ")";
  }
}
