package io.github.nickliapin.tdc.packs;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.function.UnaryOperator;

/**
 * Which proxy a registry request goes through, read from the environment the way curl and npm
 * read it — the same rule in all five implementations.
 *
 * <p>{@code HttpClient} reads no environment variable at all, so behind a proxy that is the only
 * way out (a corporate network, a CI runner, an agent's sandbox) {@code tdcv2 pack add} tried to
 * reach the registry directly and failed, while npm and curl, on the same machine, worked.
 *
 * <ul>
 *   <li>An {@code https} address takes the first non-empty of {@code https_proxy}, {@code
 *       HTTPS_PROXY}, {@code all_proxy}, {@code ALL_PROXY}; an {@code http} one {@code
 *       http_proxy}, {@code HTTP_PROXY}, {@code all_proxy}, {@code ALL_PROXY}.
 *   <li>{@code no_proxy} (or {@code NO_PROXY}) is a comma-separated list of hosts that go direct:
 *       {@code *} for all, otherwise a host matches an entry it equals or ends with after a dot,
 *       with a leading dot and a port ignored.
 *   <li>A value with no scheme is an {@code http://} proxy.
 * </ul>
 */
public final class EnvProxy {

  private EnvProxy() {}

  /**
   * Where the variables are read from. A JVM cannot set its own environment, so the shared CLI
   * fixture replaces this for a case that names one, and puts it back afterwards.
   */
  public static volatile UnaryOperator<String> environment = System::getenv;

  /**
   * The proxy an address goes through, and the variable that named it.
   *
   * @param proxy the proxy as {@code scheme://host:port}, the port always spelled out and the
   *     credentials left out, since this is what an error message prints
   */
  public record Choice(
      String proxy, String variable, String host, int port, String user, String password) {}

  /** The proxy for {@code target}, or {@code null} to go direct. */
  public static Choice forTarget(URI target) {
    String scheme = target.getScheme() == null ? "" : target.getScheme().toLowerCase(Locale.ROOT);
    String host = target.getHost();
    if (host == null || !(scheme.equals("http") || scheme.equals("https")) || bypassed(host)) {
      return null;
    }
    List<String> names =
        scheme.equals("https")
            ? List.of("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
            : List.of("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
    for (String name : names) {
      String value = read(name);
      if (value.isEmpty()) {
        continue;
      }
      URI proxy;
      try {
        proxy = URI.create(value.contains("://") ? value : "http://" + value);
      } catch (IllegalArgumentException e) {
        proxy = null;
      }
      if (proxy == null || proxy.getHost() == null) {
        throw new PackRegistry.PackException(
            name + "=\"" + value + "\" is not a proxy address — write it as http://host:port");
      }
      String proxyScheme = proxy.getScheme().toLowerCase(Locale.ROOT);
      int port = proxy.getPort() >= 0 ? proxy.getPort() : proxyScheme.equals("https") ? 443 : 80;
      String shown = proxyScheme + "://" + proxy.getHost() + ":" + port;
      String info = proxy.getUserInfo();
      String user = null;
      String password = null;
      if (info != null && !info.isEmpty()) {
        int colon = info.indexOf(':');
        user = colon < 0 ? info : info.substring(0, colon);
        password = colon < 0 ? "" : info.substring(colon + 1);
      }
      return new Choice(shown, name, proxy.getHost(), port, user, password);
    }
    return null;
  }

  /** Whether {@code host} is listed in {@code no_proxy} / {@code NO_PROXY}. */
  static boolean bypassed(String host) {
    String list = read("no_proxy");
    if (list.isEmpty()) {
      list = read("NO_PROXY");
    }
    String h = host.toLowerCase(Locale.ROOT);
    for (String raw : list.split(",")) {
      String entry = raw.trim().toLowerCase(Locale.ROOT);
      if (entry.equals("*")) {
        return true;
      }
      if (entry.startsWith(".")) {
        entry = entry.substring(1);
      }
      int colon = entry.lastIndexOf(':');
      if (colon > 0 && entry.indexOf(':') == colon) {
        entry = entry.substring(0, colon);
      }
      if (!entry.isEmpty() && (h.equals(entry) || h.endsWith("." + entry))) {
        return true;
      }
    }
    return false;
  }

  private static String read(String name) {
    String value = environment.apply(name);
    return value == null ? "" : value.trim();
  }

  /**
   * Answers a proxy's 407 with the user and password written in the proxy variable.
   *
   * <p>The JDK refuses Basic credentials for an HTTPS tunnel unless {@code
   * jdk.http.auth.tunneling.disabledSchemes} says otherwise, so a proxy that asks for them could
   * never be passed. That property is cleared here — only when a proxy variable carries
   * credentials, and only when nobody has set it — which is as far as the process-wide switch
   * needs to go for the credentials the user wrote down to be sent.
   */
  static java.net.Authenticator authenticator() {
    if (System.getProperty("jdk.http.auth.tunneling.disabledSchemes") == null && anyCredentials()) {
      System.setProperty("jdk.http.auth.tunneling.disabledSchemes", "");
    }
    return new java.net.Authenticator() {
      @Override
      protected java.net.PasswordAuthentication getPasswordAuthentication() {
        if (getRequestorType() != RequestorType.PROXY || getRequestingURL() == null) {
          return null;
        }
        Choice choice;
        try {
          choice = forTarget(getRequestingURL().toURI());
        } catch (java.net.URISyntaxException | RuntimeException e) {
          return null;
        }
        if (choice == null || choice.user() == null) {
          return null;
        }
        return new java.net.PasswordAuthentication(
            java.net.URLDecoder.decode(choice.user(), java.nio.charset.StandardCharsets.UTF_8),
            java.net.URLDecoder.decode(choice.password(), java.nio.charset.StandardCharsets.UTF_8)
                .toCharArray());
      }
    };
  }

  private static boolean anyCredentials() {
    for (String name :
        List.of("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY")) {
      if (read(name).contains("@")) {
        return true;
      }
    }
    return false;
  }

  /** A selector that asks {@link #forTarget} for every request. */
  static ProxySelector selector() {
    return new ProxySelector() {
      @Override
      public List<Proxy> select(URI uri) {
        Choice choice = forTarget(uri);
        if (choice == null) {
          return List.of(Proxy.NO_PROXY);
        }
        return List.of(
            new Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(choice.host(), choice.port())));
      }

      @Override
      public void connectFailed(URI uri, SocketAddress sa, IOException ioe) {
        // Nothing to fall back to: the failure is reported with the proxy named.
      }
    };
  }
}
