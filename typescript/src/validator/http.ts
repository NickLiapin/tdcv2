/**
 * Validation for the `http` generator — see
 * docs/specs/2026-07-23-http-service-generator.md.
 *
 * Everything catchable before a run is caught here, with a position: a missing
 * or malformed endpoint, an `in=` that names nothing (or a later sequence), and
 * an `on_error` outside the two allowed values. The transport failures — the
 * service being down, slow, or wrong — cannot be known until the run and are
 * reported then.
 */

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export interface HttpCheckContext {
  readonly diagnostics: Diagnostic[];
  /** Sequence names declared before this one — what `in=` may reference. */
  readonly declaredSequences: readonly string[];
}

export function checkGenHttp(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: HttpCheckContext,
): void {
  const attrs = gen.attr();
  const map = extractAttrs(attrs);

  // src — required, and a real http/https URL.
  const srcAttr = findAttr(attrs, 'src');
  const src = (map['src'] ?? '').trim();
  if (!srcAttr || src === '') {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(srcAttr ? attrValueRange(srcAttr) : nodeRange(gen)),
      message: '<gen type="http"> requires a "src" attribute',
      hint: 'Point it at the service, e.g. src="http://127.0.0.1:5566/gen".',
      code: 'TDC065',
    });
  } else if (!isHttpUrl(src)) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(srcAttr),
      message: `invalid http src "${src}" — must be an http:// or https:// URL`,
      hint: 'e.g. src="http://127.0.0.1:5566/gen" or src="https://svc.example.com/gen".',
      code: 'TDC066',
    });
  }

  // in — optional, but if present must name an earlier-declared sequence.
  const inAttr = findAttr(attrs, 'in');
  const inName = (map['in'] ?? '').trim();
  if (inAttr && !ctx.declaredSequences.includes(inName)) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(inAttr),
      message: `in="${inName}" does not name a sequence declared before this one`,
      hint: 'The value sent per row comes from an earlier <sequence>; declare it above.',
      code: 'TDC067',
    });
  }

  // on_error — optional, two values only.
  const onErrAttr = findAttr(attrs, 'on_error');
  const onErr = map['on_error'];
  if (onErrAttr && onErr !== 'fail' && onErr !== 'empty') {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(onErrAttr),
      message: `invalid on_error "${onErr ?? ''}" — expected "fail" or "empty"`,
      hint: 'fail (default) stops the run; empty blanks the cell and continues.',
      code: 'TDC068',
    });
  }

  // timeout — optional, but a positive number of SECONDS when written.
  //
  // It used to be read with no check anywhere, and the five implementations then
  // disagreed twice over: four fell back to the default in silence, Python threw
  // at run time — and Python read the attribute as MILLISECONDS, so the
  // documented `timeout="30"` gave up after 30ms, in 0.185s. A number the engine
  // cannot use is exactly the shape this validator exists to catch: the config
  // asks for one thing and the run does another.
  const timeoutAttr = findAttr(attrs, 'timeout');
  if (timeoutAttr) {
    const raw = (map['timeout'] ?? '').trim();
    const seconds = Number(raw);
    if (raw === '' || !Number.isFinite(seconds) || seconds <= 0) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(timeoutAttr),
        message: `invalid timeout "${raw}" — expected a positive number of seconds`,
        hint: 'timeout="30" waits thirty seconds for one answer. Omit it for the default of 30.',
        code: 'TDC069',
      });
    }
  }

  // batch / parallel — how the column is cut into requests, and how many may be
  // on the wire at once. Whole numbers above zero: a batch of 2.5 rows or of
  // none is a config asking for something no request can be.
  for (const [name, hint] of [
    [
      'batch',
      'batch="10000" sends ten thousand rows per request. Omit it for the default of 10000.',
    ],
    [
      'parallel',
      'parallel="4" lets four requests be on the wire at once. Omit it for one at a time.',
    ],
  ] as const) {
    const attr = findAttr(attrs, name);
    if (!attr) continue;
    const raw = (map[name] ?? '').trim();
    const n = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(attr),
        message: `invalid ${name} "${raw}" — expected a whole number above zero`,
        hint,
        code: 'TDC313',
      });
    }
  }

  // secret — the key a request is signed with. Three spellings, and only the
  // literal is worth saying anything about: a config travels into version
  // control, and the secret would travel with it. A warning rather than an
  // error, because a service on 127.0.0.1 for an afternoon is a real use and
  // refusing it would only teach people to write it somewhere worse.
  const secretAttr = findAttr(attrs, 'secret');
  if (secretAttr) {
    const raw = (map['secret'] ?? '').trim();
    if (raw === '') {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(secretAttr),
        message: 'secret="" has no key to sign with',
        hint: 'Name where the key lives: secret="env:TDC_HTTP_SECRET" or secret="file:~/.tdc/service.key". Remove the attribute to send the request unsigned.',
        code: 'TDC284',
      });
    } else if (!raw.startsWith('env:') && !raw.startsWith('file:')) {
      ctx.diagnostics.push({
        severity: 'warning',
        source: 'validator',
        ...attrValueRange(secretAttr),
        message: 'secret= is written into the config, so it travels wherever the config does',
        hint: 'A config goes into version control and the key goes with it. secret="env:TDC_HTTP_SECRET" reads it from the environment, secret="file:~/.tdc/service.key" from a file the repository does not hold.',
        code: 'TDC284',
      });
    }
  }
}

/** A well-formed absolute http/https URL. */
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * A `<uniq>` or `<distinct>` member that calls a web service.
 *
 * A group keeps its promise in one of two ways, and a service can follow
 * neither. `<uniq>` MOVES values between rows — and a service's answer belongs
 * to the row it was asked for: a hash moved off its password's row is a wrong
 * hash. Measured on the reference before this check: 197 of 200 hashes in a
 * `<uniq>` beside their password column landed on another row, and the run
 * exited 0. `<distinct>` asks for ANOTHER value — and a service answers each
 * row once, so every retry was the same request again, a thousand times over.
 *
 * Anywhere inside the member counts: a `<mix>` or `<switch>` member carries
 * its cases' values just as a sequence carries its own.
 */
export function checkGroupHttpMember(
  wrapper: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  tag: string,
): void {
  for (const el of contentElements(wrapper.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'open') continue;
    const member = elementName(k.node);
    if (member !== 'sequence' && member !== 'mix' && member !== 'switch') continue;
    const gen = firstHttpGen(k.node);
    if (gen === undefined) continue;
    const name = extractAttrs(k.node.attr())['name'] ?? '?';
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message:
        `<${member} name="${name}"> calls a web service (type="http"), which cannot be a ` +
        `member of <${tag}>: ` +
        (tag === 'uniq'
          ? 'the group moves values between rows, and an answer belongs to the row it was asked for'
          : 'the group asks for another value, and a service answers each row once'),
      hint:
        `Put the <${tag}> around the columns the service reads (in=) and leave the http column ` +
        'outside it — it follows its inputs. To require the answers themselves to differ, write ' +
        'uniq="true" on the http sequence: the run checks them and stops at the first repeat.',
      code: 'TDC314',
    });
  }
}

/** The first `<gen type="http">` anywhere under `node`. */
function firstHttpGen(
  node: OpenCloseElementContext,
): OpenCloseElementContext | SelfClosingElementContext | undefined {
  for (const el of contentElements(node.content())) {
    const k = elementKind(el);
    if (k === null || k.kind === 'data') continue;
    if (elementName(k.node) === 'gen' && extractAttrs(k.node.attr())['type'] === 'http') {
      return k.node;
    }
    if (k.kind === 'open') {
      const inner = firstHttpGen(k.node);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}
