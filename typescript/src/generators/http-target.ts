/**
 * The request target of an `http` generator — the path and query of `src=`,
 * written once, the way it goes on the wire.
 *
 * It is signed (`X-TDC-Signature` covers it), so the bytes TDC signs and the
 * bytes the service reads off the request line have to be the same bytes. The
 * five implementations send through five different HTTP clients, and handed the
 * same URL they do NOT send the same request line, measured 2026-11-21:
 *
 * - .NET decodes `%41` to `A` and `%7e` to `~`, and upper-cases `%d0` to `%D0`;
 * - Node's fetch encodes `'` in the query as `%27` and drops an empty `?`;
 *   Python, curl and .NET keep both;
 * - curl and Node resolve `/a/../b` to `/b`; the others send it as written.
 *
 * So the target is not left to the client. It is computed here by one rule, the
 * URL that is actually sent is rebuilt from it, and every client is then handed
 * a target it sends untouched — which is what the same measurement showed for a
 * target already in this form, in all five.
 *
 * The rule:
 *
 * 1. everything after the host; `#fragment` dropped (no client sends it);
 * 2. an empty query (`/a?`) is no query;
 * 3. `/` when nothing is left, and a leading `/` before a bare `?query`;
 * 4. a `%XX` escape of an unreserved character (`A-Z a-z 0-9 - . _ ~`) is that
 *    character — RFC 3986 §6.2.2.2, and what .NET does anyway; every other
 *    escape is kept, its hex digits upper-cased (§6.2.2.1);
 * 5. a `%` that does not start an escape is `%25`;
 * 6. any other character outside `A-Z a-z 0-9 - . _ ~ ! $ & ( ) * + , ; = : @ / ?`
 *    is percent-encoded as its UTF-8 bytes — `'` included, because fetch
 *    encodes it in a query and nothing else does.
 *
 * `.` and `..` segments are the one shape no rule can settle — two clients
 * resolve them, three send them — so the validator refuses them (TDC066) and a
 * config never reaches this point with one.
 *
 * The same rule lives in the other four implementations, held to
 * `fixtures/cross-language/http-vectors.json` (`target`).
 */

/** What every TDC request is sent with. Signed, so a service can tell. */
export const HTTP_METHOD = 'POST';

/** Characters a target carries as they are. `'` is deliberately absent. */
const KEPT = /^[A-Za-z0-9\-._~!$&()*+,;=:@/?]$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

export interface HttpTarget {
  /** The URL handed to the HTTP client: scheme and host as written, then `target`. */
  readonly url: string;
  /** Path and query as they go on the request line — and into the signature. */
  readonly target: string;
}

function isAsciiWhitespace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

/**
 * `src` without leading and trailing ASCII whitespace. A loop, not a regex:
 * `/^\s+|\s+$/g` retries a whitespace run from every position inside it, so a
 * long run in the middle of `src` costs quadratic time.
 */
function trimAsciiWhitespace(src: string): string {
  let start = 0;
  let end = src.length;
  while (start < end && isAsciiWhitespace(src[start])) start++;
  while (end > start && isAsciiWhitespace(src[end - 1])) end--;
  return src.slice(start, end);
}

/** `src=` cut into what is sent as written (scheme, host, port) and what is not. */
function splitSrc(src: string): { origin: string; rest: string } {
  const trimmed = trimAsciiWhitespace(src);
  const scheme = trimmed.indexOf('://');
  const hostStart = scheme < 0 ? 0 : scheme + 3;
  for (let i = hostStart; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '/' || c === '?' || c === '#') {
      return { origin: trimmed.slice(0, i), rest: trimmed.slice(i) };
    }
  }
  return { origin: trimmed, rest: '' };
}

/** `%XX` for each UTF-8 byte of one character. */
function percentEncode(char: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(char)) {
    out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The URL to send and the target to sign, for one `src=`. */
export function httpTarget(src: string): HttpTarget {
  const { origin, rest } = splitSrc(src);
  let raw = rest;
  const hash = raw.indexOf('#');
  if (hash >= 0) raw = raw.slice(0, hash);
  const query = raw.indexOf('?');
  if (query >= 0 && query === raw.length - 1) raw = raw.slice(0, query);
  if (!raw.startsWith('/')) raw = `/${raw}`;

  let target = '';
  const chars = Array.from(raw);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? '';
    if (c === '%') {
      const pair = (chars[i + 1] ?? '') + (chars[i + 2] ?? '');
      if (HEX_PAIR.test(pair)) {
        const decoded = String.fromCharCode(parseInt(pair, 16));
        target += UNRESERVED.test(decoded) ? decoded : `%${pair.toUpperCase()}`;
        i += 2;
      } else {
        target += '%25';
      }
    } else if (KEPT.test(c)) {
      target += c;
    } else {
      target += percentEncode(c);
    }
  }
  return { url: origin + target, target };
}

/**
 * The first `.` or `..` segment of the target's path, if it has one.
 *
 * Read AFTER the rule above, so `%2e%2e` counts — Node's URL parser treats it
 * as `..` too.
 */
export function dotSegmentOf(src: string): string | undefined {
  const { target } = httpTarget(src);
  const query = target.indexOf('?');
  const path = query < 0 ? target : target.slice(0, query);
  return path.split('/').find((segment) => segment === '.' || segment === '..');
}
