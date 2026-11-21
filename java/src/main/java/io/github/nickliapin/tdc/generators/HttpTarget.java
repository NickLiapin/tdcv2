package io.github.nickliapin.tdc.generators;

import java.nio.charset.StandardCharsets;

/**
 * The request target of an {@code http} generator — the path and query of {@code src=}, written
 * once, the way it goes on the wire.
 *
 * <p>It is signed ({@code X-TDC-Signature} covers it), so the bytes TDC signs and the bytes the
 * service reads off the request line have to be the same bytes. The five implementations send
 * through five different HTTP clients, and handed the same URL they do NOT send the same request
 * line, measured 2026-11-21:
 *
 * <ul>
 *   <li>.NET decodes {@code %41} to {@code A} and {@code %7e} to {@code ~}, and upper-cases
 *       {@code %d0} to {@code %D0};
 *   <li>Node's fetch encodes {@code '} in the query as {@code %27} and drops an empty {@code ?};
 *       Python, curl and .NET keep both;
 *   <li>curl and Node resolve {@code /a/../b} to {@code /b}; the others send it as written.
 * </ul>
 *
 * <p>So the target is not left to the client. It is computed here by one rule, the URL that is
 * actually sent is rebuilt from it, and every client is then handed a target it sends untouched —
 * which is what the same measurement showed for a target already in this form, in all five
 * ({@link java.net.http.HttpClient} with {@code URI.create(url)} among them).
 *
 * <p>The rule:
 *
 * <ol>
 *   <li>everything after the host; {@code #fragment} dropped (no client sends it);
 *   <li>an empty query ({@code /a?}) is no query;
 *   <li>{@code /} when nothing is left, and a leading {@code /} before a bare {@code ?query};
 *   <li>a {@code %XX} escape of an unreserved character ({@code A-Z a-z 0-9 - . _ ~}) is that
 *       character — RFC 3986 §6.2.2.2, and what .NET does anyway; every other escape is kept, its
 *       hex digits upper-cased (§6.2.2.1);
 *   <li>a {@code %} that does not start an escape is {@code %25};
 *   <li>any other character outside {@code A-Z a-z 0-9 - . _ ~ ! $ & ( ) * + , ; = : @ / ?} is
 *       percent-encoded as its UTF-8 bytes — {@code '} included, because fetch encodes it in a
 *       query and nothing else does.
 * </ol>
 *
 * <p>The source is read by CODE POINT, not by UTF-16 unit: a character outside the BMP is one
 * character of four UTF-8 bytes, not two halves.
 *
 * <p>{@code .} and {@code ..} segments are the one shape no rule can settle — two clients resolve
 * them, three send them — so the validator refuses them (TDC066) and a config never reaches this
 * point with one.
 *
 * <p>The same rule lives in the other four implementations, held to {@code
 * fixtures/cross-language/http-vectors.json} ({@code target}).
 *
 * @param url the URL handed to the HTTP client: scheme and host as written, then {@code target}
 * @param target path and query as they go on the request line — and into the signature
 */
public record HttpTarget(String url, String target) {

  /** What every TDC request is sent with. Signed, so a service can tell. */
  public static final String METHOD = "POST";

  /** The URL to send and the target to sign, for one {@code src=}. */
  public static HttpTarget of(String src) {
    String trimmed = trimAsciiWhitespace(src);
    // `src=` cut into what is sent as written (scheme, host, port) and what is not. The
    // delimiters are ASCII, and no half of a surrogate pair equals one, so UTF-16 indices are
    // safe for the cut.
    int scheme = trimmed.indexOf("://");
    int hostStart = scheme < 0 ? 0 : scheme + 3;
    String origin = trimmed;
    String raw = "";
    for (int i = hostStart; i < trimmed.length(); i++) {
      char c = trimmed.charAt(i);
      if (c == '/' || c == '?' || c == '#') {
        origin = trimmed.substring(0, i);
        raw = trimmed.substring(i);
        break;
      }
    }

    int hash = raw.indexOf('#');
    if (hash >= 0) {
      raw = raw.substring(0, hash);
    }
    int query = raw.indexOf('?');
    if (query >= 0 && query == raw.length() - 1) {
      raw = raw.substring(0, query);
    }
    if (!raw.startsWith("/")) {
      raw = "/" + raw;
    }

    int[] chars = raw.codePoints().toArray();
    StringBuilder target = new StringBuilder(raw.length());
    for (int i = 0; i < chars.length; i++) {
      int c = chars[i];
      if (c == '%') {
        if (i + 2 < chars.length && isHex(chars[i + 1]) && isHex(chars[i + 2])) {
          int decoded = hexValue(chars[i + 1]) * 16 + hexValue(chars[i + 2]);
          if (isUnreserved(decoded)) {
            target.append((char) decoded);
          } else {
            target.append('%').append(upperHex(chars[i + 1])).append(upperHex(chars[i + 2]));
          }
          i += 2;
        } else {
          target.append("%25");
        }
      } else if (isKept(c)) {
        target.append((char) c);
      } else {
        percentEncode(target, c);
      }
    }
    String written = target.toString();
    return new HttpTarget(origin + written, written);
  }

  /**
   * The first {@code .} or {@code ..} segment of the target's path, or {@code null} when it has
   * none.
   *
   * <p>Read AFTER the rule above, so {@code %2e%2e} counts — Node's URL parser treats it as
   * {@code ..} too.
   */
  public static String dotSegmentOf(String src) {
    String target = of(src).target();
    int query = target.indexOf('?');
    String path = query < 0 ? target : target.substring(0, query);
    for (String segment : path.split("/", -1)) {
      if (".".equals(segment) || "..".equals(segment)) {
        return segment;
      }
    }
    return null;
  }

  /** Surrounding space, tab, CR and LF — and nothing else, so every implementation agrees. */
  private static String trimAsciiWhitespace(String value) {
    int start = 0;
    int end = value.length();
    while (start < end && isAsciiWhitespace(value.charAt(start))) {
      start++;
    }
    while (end > start && isAsciiWhitespace(value.charAt(end - 1))) {
      end--;
    }
    return value.substring(start, end);
  }

  private static boolean isAsciiWhitespace(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
  }

  private static boolean isAlphaNumeric(int c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
  }

  /** RFC 3986 unreserved: {@code A-Z a-z 0-9 - . _ ~}. */
  private static boolean isUnreserved(int c) {
    return isAlphaNumeric(c) || c == '-' || c == '.' || c == '_' || c == '~';
  }

  /** Characters a target carries as they are. {@code '} is deliberately absent. */
  private static boolean isKept(int c) {
    return isUnreserved(c) || (c < 0x80 && "!$&()*+,;=:@/?".indexOf(c) >= 0);
  }

  private static boolean isHex(int c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
  }

  private static int hexValue(int c) {
    if (c <= '9') {
      return c - '0';
    }
    return (c >= 'a' ? c - 'a' : c - 'A') + 10;
  }

  private static char upperHex(int c) {
    return (char) (c >= 'a' && c <= 'f' ? c - 'a' + 'A' : c);
  }

  /** {@code %XX} for each UTF-8 byte of one code point. */
  private static void percentEncode(StringBuilder out, int codePoint) {
    // A lone surrogate has no UTF-8 form; it goes out as U+FFFD, as a UTF-8 encoder elsewhere
    // writes it, rather than as Java's '?' substitute.
    int c = Character.isSurrogate((char) codePoint) && codePoint <= 0xFFFF ? 0xFFFD : codePoint;
    for (byte b : new String(Character.toChars(c)).getBytes(StandardCharsets.UTF_8)) {
      out.append('%')
          .append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xf, 16)))
          .append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
    }
  }
}
