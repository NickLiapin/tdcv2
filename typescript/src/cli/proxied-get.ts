/**
 * A GET that goes through the proxy the environment names — the same rule in
 * all five implementations.
 *
 * Node's `fetch` reads no proxy variable at all (not on the Node versions this
 * package supports), so behind a proxy that is the only way out — a corporate
 * network, a CI runner, an agent's sandbox — `tdcv2 pack add` went straight
 * for the registry and failed with two words, `fetch failed`, while npm and
 * curl worked on the same machine. The rule, as curl and npm read it:
 *
 * - An `https` address takes the first non-empty of `https_proxy`,
 *   `HTTPS_PROXY`, `all_proxy`, `ALL_PROXY`; an `http` one `http_proxy`,
 *   `HTTP_PROXY`, `all_proxy`, `ALL_PROXY`.
 * - `no_proxy` (or `NO_PROXY`) is a comma-separated list of hosts that go
 *   direct: `*` for all, otherwise a host matches an entry it equals or ends
 *   with after a dot, with a leading dot and a port ignored.
 * - A value with no scheme is an `http://` proxy.
 *
 * An `https` address is reached through an HTTP `CONNECT` tunnel, an `http`
 * one by asking the proxy for the absolute URL. Redirects are followed, as
 * `fetch` followed them.
 */

import { type IncomingMessage, type OutgoingHttpHeaders, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** The proxy an address goes through, and the variable that named it. */
export interface ProxyChoice {
  /** The proxy as written, credentials included — what the request uses. */
  readonly url: URL;
  /** `scheme://host:port`, the port always spelled out and the credentials left out. */
  readonly shown: string;
  readonly variable: string;
}

/** A proxy value that is not an address, said in words the other four use too. */
export class ProxyAddressError extends Error {}

const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

function read(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? '').trim();
}

/** Whether `host` is listed in `no_proxy` / `NO_PROXY`. */
export function bypassed(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const listed = read(env, 'no_proxy') || read(env, 'NO_PROXY');
  const h = host.toLowerCase();
  for (const raw of listed.split(',')) {
    let entry = raw.trim().toLowerCase();
    if (entry === '*') return true;
    if (entry.startsWith('.')) entry = entry.slice(1);
    if ((entry.match(/:/g) ?? []).length === 1) entry = entry.split(':')[0] ?? '';
    if (entry !== '' && (h === entry || h.endsWith(`.${entry}`))) return true;
  }
  return false;
}

/** The proxy for `target`, or `undefined` to go direct. */
export function proxyFor(
  target: URL,
  env: NodeJS.ProcessEnv = process.env,
): ProxyChoice | undefined {
  const scheme = target.protocol.replace(/:$/, '').toLowerCase();
  // A bracketed IPv6 host is compared without its brackets, as the others compare it.
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if ((scheme !== 'http' && scheme !== 'https') || host === '' || bypassed(host, env)) {
    return undefined;
  }
  const names =
    scheme === 'https'
      ? ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
      : ['http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];
  for (const name of names) {
    const value = read(env, name);
    if (value === '') continue;
    const written = value.includes('://') ? value : `http://${value}`;
    let url: URL;
    try {
      url = new URL(written);
    } catch {
      throw new ProxyAddressError(
        `${name}="${value}" is not a proxy address — write it as http://host:port`,
      );
    }
    if (url.hostname === '') {
      throw new ProxyAddressError(
        `${name}="${value}" is not a proxy address — write it as http://host:port`,
      );
    }
    const proxyScheme = url.protocol.replace(/:$/, '');
    const port = url.port === '' ? (proxyScheme === 'https' ? '443' : '80') : url.port;
    return { url, shown: `${proxyScheme}://${url.hostname}:${port}`, variable: name };
  }
  return undefined;
}

function proxyPort(proxy: URL): number {
  return proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port);
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (proxy.username === '') return undefined;
  const pair = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

/** A socket to `host:port` through the proxy's `CONNECT`. */
function tunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { host: `${host}:${String(port)}` };
    const auth = proxyAuthorization(proxy);
    if (auth !== undefined) headers['proxy-authorization'] = auth;
    const req = httpRequest({
      host: proxy.hostname,
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: `${host}:${String(port)}`,
      headers,
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timed out waiting for the proxy')));
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      reject(
        new Error(`the proxy answered ${String(res.statusCode)} ${res.statusMessage ?? ''}`.trim()),
      );
    });
    req.once('error', reject);
    req.end();
  });
}

/** One request, no redirects followed. */
async function once(url: URL, proxy: ProxyChoice | undefined): Promise<IncomingMessage> {
  const secure = url.protocol === 'https:';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  let socket: Socket | undefined;
  if (proxy !== undefined && secure) socket = await tunnel(proxy.url, url.hostname, port);
  return new Promise((resolve, reject) => {
    let req;
    if (socket !== undefined) {
      const raw = socket;
      req = httpsRequest(url, {
        method: 'GET',
        createConnection: () => tlsConnect({ socket: raw, servername: url.hostname }),
      });
    } else if (proxy !== undefined) {
      // Plain http through a proxy: the proxy is asked for the absolute URL.
      const headers: OutgoingHttpHeaders = { host: url.host };
      const auth = proxyAuthorization(proxy.url);
      if (auth !== undefined) headers['proxy-authorization'] = auth;
      req = httpRequest({
        host: proxy.url.hostname,
        port: proxyPort(proxy.url),
        method: 'GET',
        path: url.href,
        headers,
      });
    } else {
      req = (secure ? httpsRequest : httpRequest)(url, { method: 'GET' });
    }
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.once('response', resolve);
    req.once('error', reject);
    req.end();
  });
}

/** A response that is not a 2xx, with its status for the caller to word. */
export class HttpStatusError extends Error {
  public constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`HTTP ${String(status)} ${statusText}`.trim());
  }
}

/**
 * GET `address`, following redirects, through whatever proxy the environment
 * names for it. `onProgress(received, total)` sees the bytes as they arrive;
 * `total` is 0 when the server sends no length.
 *
 * Rejects with `HttpStatusError` for a non-2xx answer, `ProxyAddressError` for
 * a proxy variable that is not an address, and the network's own error
 * otherwise — `connect ECONNREFUSED 127.0.0.1:9`, `getaddrinfo ENOTFOUND host`.
 */
export async function proxiedGet(
  address: string,
  onProgress: (received: number, total: number) => void = () => undefined,
): Promise<Uint8Array> {
  let url = new URL(address);
  for (let hop = 0; ; hop++) {
    const res = await once(url, proxyFor(url));
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location !== undefined && hop < MAX_REDIRECTS) {
      res.resume();
      url = new URL(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new HttpStatusError(status, res.statusMessage ?? '');
    }
    const total = Number(res.headers['content-length'] ?? 0);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      received += chunk.length;
      onProgress(received, total);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}
