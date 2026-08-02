package io.github.nickliapin.tdc.errors;

import java.util.List;

/**
 * One complaint about a config.
 *
 * <p>The {@code code} is the contract across implementations, not the message. Wording gets
 * edited for clarity over time, and holding three languages to a sentence would make every
 * improvement a breaking change — which is what a stable code is for.
 *
 * @param line 1-based, as an editor counts
 * @param column 0-based, as an editor counts
 */
public record Diagnostic(
    Severity severity, String code, String message, String hint, int line, int column) {

  public enum Severity {
    ERROR,
    WARNING;

    @Override
    public String toString() {
      return name().toLowerCase();
    }
  }

  public static Diagnostic error(String code, String message, String hint, int line, int column) {
    return new Diagnostic(Severity.ERROR, code, message, hint, line, column);
  }

  public static Diagnostic warning(String code, String message, String hint, int line, int column) {
    return new Diagnostic(Severity.WARNING, code, message, hint, line, column);
  }

  /** Whether anything here stops the run. A warning is worth saying and worth continuing past. */
  public static boolean hasErrors(List<Diagnostic> diagnostics) {
    return diagnostics.stream().anyMatch(d -> d.severity() == Severity.ERROR);
  }

  /** The shape the shared diagnostic fixtures record: severity and code, never the wording. */
  public String signature() {
    return severity + " " + code + " " + line + ":" + column;
  }

  @Override
  public String toString() {
    return severity + " " + code + " (line " + line + ", col " + column + "): " + message;
  }
}
