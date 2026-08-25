package io.github.nickliapin.tdc.errors;

import java.util.Collection;
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
    Severity severity,
    String code,
    String message,
    String hint,
    int line,
    int column,
    /**
     * The near name, when there is one: {@code did you mean "person.male.firstName"?}
     *
     * <p>Its own line rather than a sentence folded into the hint, because it is the one part a
     * reader can act on without reading anything else — and because the reference prints it as
     * {@code help:}, above the {@code note:}. Folded in, it arrived buried; left out, the reader
     * was told a name is wrong and not what the right one is.
     */
    String suggestion) {

  public enum Severity {
    ERROR,
    WARNING;

    @Override
    public String toString() {
      return name().toLowerCase();
    }
  }

  public static Diagnostic error(String code, String message, String hint, int line, int column) {
    return new Diagnostic(Severity.ERROR, code, message, hint, line, column, "");
  }

  public static Diagnostic warning(String code, String message, String hint, int line, int column) {
    return new Diagnostic(Severity.WARNING, code, message, hint, line, column, "");
  }

  /** The same diagnostic carrying a near name. */
  public Diagnostic suggesting(String near) {
    return new Diagnostic(severity, code, message, hint, line, column, near);
  }

  /** The {@code help:} line for a near name, or "" when nothing was near enough. */
  public static String didYouMean(String name) {
    return name == null || name.isEmpty() ? "" : "did you mean \"" + name + "\"?";
  }

  /**
   * The candidate nearest {@code needle}, or "" when nothing is near enough.
   *
   * <p>Ported from the reference: a case-only difference always wins, and a best distance past
   * {@code maxDistance} — or past about half the needle's length — is not a typo but a different
   * word, where saying "did you mean" is worse than saying nothing.
   */
  public static String closestMatch(String needle, Collection<String> candidates) {
    final int maxDistance = 3;
    if (needle == null || needle.isEmpty() || candidates.isEmpty()) {
      return "";
    }
    int limit = Math.min(maxDistance, Math.max(1, needle.length() / 2 + 1));
    String lower = needle.toLowerCase(java.util.Locale.ROOT);
    for (String candidate : candidates) {
      if (candidate.toLowerCase(java.util.Locale.ROOT).equals(lower) && !candidate.equals(needle)) {
        return candidate;
      }
    }
    String best = "";
    int bestDistance = Integer.MAX_VALUE;
    for (String candidate : candidates) {
      int d = editDistance(needle, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return bestDistance <= limit ? best : "";
  }

  /** Levenshtein, the same two-row walk the reference uses. */
  private static int editDistance(String a, String b) {
    int m = a.length();
    int n = b.length();
    if (m == 0) {
      return n;
    }
    if (n == 0) {
      return m;
    }
    int[] prev = new int[n + 1];
    int[] curr = new int[n + 1];
    for (int j = 0; j <= n; j++) {
      prev[j] = j;
    }
    for (int i = 1; i <= m; i++) {
      curr[0] = i;
      for (int j = 1; j <= n; j++) {
        int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(Math.min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
      }
      int[] swap = prev;
      prev = curr;
      curr = swap;
    }
    return prev[n];
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
