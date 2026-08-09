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
import { extractAttrs } from '../processor/walk.js';

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
