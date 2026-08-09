/**
 * Where `secret=` gets its bytes, and why it is spelled three ways.
 *
 * The secret is the one thing in a run that must not travel: it never goes on
 * the wire (only a signature derived from it does) and it should not travel into
 * version control either, which is what a config does. So the two spellings that
 * keep it out of the file come first, and the literal is accepted with a warning
 * rather than refused — a service on 127.0.0.1 for an afternoon is a real use,
 * and refusing it would only teach people to work around the check.
 *
 *   secret="env:TDC_HTTP_SECRET"    read from the environment
 *   secret="file:~/.tdc/service.key"  read from a file, trimmed
 *   secret="k7Fm2p…"                 the value itself — TDC284
 *
 * Resolution lives here rather than in the client because it touches the
 * environment and the filesystem, and the client is a pure function of its
 * arguments — which is what lets the shared cases sign a request without a
 * machine's environment leaking into the expectation.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Why a `secret=` could not be turned into bytes. The caller names the sequence. */
export class HttpSecretError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HttpSecretError';
  }
}

/**
 * `secret="…"` → the bytes to sign with.
 *
 * `baseDir` is the config's own directory, so `file:service.key` beside the
 * config means what it looks like. An empty or whitespace-only secret is refused
 * wherever it came from: signing with nothing would produce a signature every
 * caller could forge, which is worse than not signing at all.
 */
export function resolveHttpSecret(
  spec: string,
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    if (name === '') throw new HttpSecretError('secret="env:" names no variable');
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      throw new HttpSecretError(
        `secret="env:${name}" — the environment variable is not set, or is empty`,
      );
    }
    return value.trim();
  }
  if (trimmed.startsWith('file:')) {
    const raw = trimmed.slice(5).trim();
    if (raw === '') throw new HttpSecretError('secret="file:" names no file');
    const path = expandHome(raw);
    let text: string;
    try {
      text = readFileSync(isAbsolute(path) ? path : resolve(baseDir, path), 'utf8');
    } catch (err) {
      throw new HttpSecretError(
        `secret="file:${raw}" could not be read (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // Trimmed because a key file written by a person almost always ends in a
    // newline, and a signature that silently includes it agrees with nothing.
    const value = text.trim();
    if (value === '') throw new HttpSecretError(`secret="file:${raw}" is empty`);
    return value;
  }
  if (trimmed === '') throw new HttpSecretError('secret="" is empty');
  return trimmed;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}
