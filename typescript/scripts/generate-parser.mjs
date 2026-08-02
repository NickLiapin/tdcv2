#!/usr/bin/env node
/**
 * Regenerate the ANTLR parser — but only when the grammar has actually changed.
 *
 * `antlr-ng` rewrites `src/generated/*.ts` unconditionally: same bytes, new
 * timestamp. That is cheap on its own, and it ran on every `prebuild`,
 * `pretest` and `pretypecheck`, so it happened many times a day. Two things
 * paid for it:
 *
 *   - `tsc --incremental` compares timestamps. A rewritten parser looks changed,
 *     so the largest generated files in the project were re-emitted after every
 *     test run.
 *   - Anything that asks "is `dist` older than `src`?" got a false yes. The
 *     Studio server does exactly that to warn about a stale engine build, and
 *     it called a five-minute-old build stale, because `npm run check` had
 *     touched the parser on its way past.
 *
 * So: compare the grammar's own timestamp against the generated files and skip
 * the run when nothing moved. `--force` regenerates regardless, for when the
 * generator version changes rather than the grammar.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAMMAR = join(HERE, '..', '..', 'grammar');
const GENERATED = join(HERE, '..', 'src', 'generated');

const SOURCES = ['TDCLexer.g4', 'TDCParser.g4'];

/** The newest mtime in a set of files, or 0 when any of them is missing. */
function newest(paths) {
  let latest = 0;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      return 0; // absent — treat as "must generate"
    }
  }
  return latest;
}

function generatedFiles() {
  try {
    return readdirSync(GENERATED)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(GENERATED, f));
  } catch {
    return [];
  }
}

const force = process.argv.includes('--force');
const grammarTime = newest(SOURCES.map((f) => join(GRAMMAR, f)));
const existing = generatedFiles();
// The OLDEST generated file is the one to compare against: if any single output
// predates the grammar, the set as a whole is stale.
const generatedTime =
  existing.length === 0 ? 0 : Math.min(...existing.map((f) => statSync(f).mtimeMs));

if (!force && existing.length > 0 && generatedTime >= grammarTime) {
  process.exit(0);
}

const result = spawnSync(
  'npx',
  [
    'antlr-ng',
    '-D',
    'language=TypeScript',
    '-o',
    'src/generated',
    '../grammar/TDCLexer.g4',
    '../grammar/TDCParser.g4',
  ],
  { cwd: join(HERE, '..'), stdio: 'inherit' },
);
process.exit(result.status ?? 1);
