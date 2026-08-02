#!/usr/bin/env node
/**
 * Regenerate the ANTLR parser for the implementations that do not build their own.
 *
 * Three of the five get this for free: TypeScript regenerates on `pretest` (its own
 * script, which also guards `tsc --incremental` against needless rewrites), Java's
 * Gradle ANTLR plugin generates into `build/`, and Rust has a hand-written parser.
 * Python and C# had neither — their generated sources sat on the developer's disk,
 * ignored by git, produced once by hand and never again. Every checkout without them
 * failed at import, which is exactly how the Five ways workflow spent its whole life
 * red: the code was fine and the parser was simply not there.
 *
 * So this is the missing build step. It writes:
 *
 *   python/src/tdcv2/parser/generated/   (visitor, no listener — what the port expects)
 *   csharp/Tdcv2/Generated/
 *
 * The generator is `antlr-ng`, the same one TypeScript uses, pinned to the same
 * version by reading it out of `typescript/package.json` rather than repeating it
 * here. One generator across four targets is what keeps the parse tree the same tree.
 *
 *   node scripts/generate-parsers.mjs                 # only when the grammar moved
 *   node scripts/generate-parsers.mjs --force         # always
 *   node scripts/generate-parsers.mjs --only python
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAMMAR = join(ROOT, 'grammar');
const SOURCES = ['TDCLexer.g4', 'TDCParser.g4'];

const TARGETS = [
  {
    id: 'python',
    language: 'Python3',
    out: join('python', 'src', 'tdcv2', 'parser', 'generated'),
    extension: '.py',
    // The port reads the tree through a visitor and never registers a listener, so
    // generating one would ship a few hundred lines nothing calls.
    flags: ['-v', 'true', '-l', 'false'],
    // ANTLR does not write one, and without it the folder is not a package the
    // installed wheel can import.
    packageMarker: '__init__.py',
  },
  {
    id: 'csharp',
    language: 'CSharp',
    out: join('csharp', 'Tdcv2', 'Generated'),
    extension: '.cs',
    flags: [],
  },
];

/** The antlr-ng version TypeScript is pinned to — one generator for every target. */
function pinnedVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'typescript', 'package.json'), 'utf8'));
  const range = pkg.devDependencies?.['antlr-ng'];
  if (!range) {
    throw new Error('typescript/package.json no longer declares antlr-ng');
  }
  return range.replace(/^[\^~]/, '');
}

/** The newest mtime among some files, or 0 when any is missing. */
function newest(paths) {
  let latest = 0;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      return 0;
    }
  }
  return latest;
}

/** The oldest generated file decides: if any single output predates the grammar, all of it is stale. */
function oldestGenerated(dir, extension) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(extension));
  } catch {
    return 0;
  }
  if (files.length === 0) {
    return 0;
  }
  return Math.min(...files.map((f) => statSync(join(dir, f)).mtimeMs));
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const onlyArg = argv.indexOf('--only');
const only =
  onlyArg >= 0 && argv[onlyArg + 1] ? new Set(argv[onlyArg + 1].split(',')) : null;

const grammarTime = newest(SOURCES.map((f) => join(GRAMMAR, f)));
// A local install wins, so a normal checkout spends no network; otherwise npx fetches
// the pinned version, which is what lets a CI job run this with nothing but Node.
const local = join(ROOT, 'node_modules', '.bin', 'antlr-ng');
const [command, lead] = existsSync(local)
  ? [local, []]
  : ['npx', ['--yes', `antlr-ng@${pinnedVersion()}`]];

let generated = 0;
for (const target of TARGETS) {
  if (only && !only.has(target.id)) {
    continue;
  }
  const out = join(ROOT, target.out);
  if (!force && oldestGenerated(out, target.extension) >= grammarTime && grammarTime > 0) {
    continue;
  }

  mkdirSync(out, { recursive: true });
  const result = spawnSync(
    command,
    [
      ...lead,
      '-D',
      `language=${target.language}`,
      ...target.flags,
      '-o',
      out,
      join(GRAMMAR, 'TDCLexer.g4'),
      join(GRAMMAR, 'TDCParser.g4'),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`generate-parsers: ${target.id} failed`);
    process.exit(result.status ?? 1);
  }
  if (target.packageMarker) {
    const marker = join(out, target.packageMarker);
    if (!existsSync(marker)) {
      writeFileSync(marker, '');
    }
  }
  generated++;
}

if (generated > 0) {
  console.log(`generate-parsers: wrote ${generated} parser${generated === 1 ? '' : 's'}`);
}
