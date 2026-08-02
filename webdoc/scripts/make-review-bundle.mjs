/**
 * Build the reviewer's copy of the documentation.
 *
 * The same site a reader gets, plus a review layer: select a passage or hover an
 * image, write what is wrong with it, and it is kept in the browser. At the end
 * one button writes a Markdown file listing every note under the SOURCE FILE
 * that has to be edited — which is what makes the feedback actionable rather
 * than a list of impressions.
 *
 * The layer is injected here, after the build, so it can never reach the
 * published site: it exists only inside the bundle this script produces.
 *
 * The bundle needs nothing installed. The reviewer unzips it and runs
 * `node serve.js`.
 *
 * Run:  npm run review          (from the repository root)
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE = join(HERE, '..');
const ROOT = join(WEBSITE, '..');
const LAYER = join(WEBSITE, 'review-layer');

const OUT = process.argv[2] ? process.argv[2] : join(ROOT, '..', 'tdc-docs-review');
const ZIP = `${OUT}.zip`;

const step = (n, what) => {
  console.log(`\n[${String(n)}/5] ${what}`);
};

// ---------------------------------------------------------------- 1. build

/*
 * Built into its own directory, never into `build/`.
 *
 * The reviewer serves from the root of their own machine, so this build carries
 * baseUrl `/`, while the published site and the local preview server both expect
 * `/tdcv2/`. Sharing one output directory meant that making a reviewer bundle
 * silently left `build/` holding a copy the normal server could not serve —
 * every page loaded without styles until someone rebuilt by hand.
 */
const OUT_BUILD = join(WEBSITE, 'build-review');

// `--reuse` skips the three-locale build, for when only the layer changed.
const reuse = process.argv.includes('--reuse') && existsSync(OUT_BUILD);

step(1, reuse ? 'Reusing the site that is already built…' : 'Building the site in all three languages…');
if (!reuse) {
  rmSync(OUT_BUILD, { recursive: true, force: true });
  execFileSync('npm', ['run', 'build', '--', '--out-dir', 'build-review'], {
    cwd: WEBSITE,
    stdio: 'inherit',
    env: { ...process.env, TDC_BASE_URL: '/' },
  });
}

// ------------------------------------------------------------- 2. assemble

step(2, 'Assembling the bundle…');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(OUT_BUILD, OUT, { recursive: true });

for (const file of ['review.js', 'review.css', 'serve.js']) {
  cpSync(join(LAYER, file), join(OUT, file));
}

// -------------------------------------------------------------- 3. inject

step(3, 'Injecting the review layer into every page…');

function htmlFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) htmlFiles(abs, acc);
    else if (name.endsWith('.html')) acc.push(abs);
  }
  return acc;
}

const CSS = '<link rel="stylesheet" href="/review.css">';
const JS = '<script src="/review.js" defer></script>';

let touched = 0;
for (const file of htmlFiles(OUT)) {
  let html = readFileSync(file, 'utf8');
  if (html.includes('/review.js')) continue;
  if (!html.includes('</head>') || !html.includes('</body>')) continue;
  html = html.replace('</head>', `${CSS}</head>`).replace('</body>', `${JS}</body>`);
  writeFileSync(file, html);
  touched++;
}
console.log(`      pages processed: ${String(touched)}`);
if (touched === 0) throw new Error('no pages were injected — the build looks wrong');

// ---------------------------------------------------------- 4. instructions

step(4, 'Writing the instructions…');
writeFileSync(
  join(OUT, 'START-HERE.md'),
  `# TDC documentation — review copy

## How to start it

All you need is Node.js. Nothing has to be installed.

\`\`\`bash
node serve.js
\`\`\`

A browser opens by itself at http://localhost:4173. If that port is taken:

\`\`\`bash
PORT=4174 node serve.js
\`\`\`

Stop it with Ctrl+C.

## How to leave notes

1. **Select some text** — a "Comment" button appears beside it.
2. Write what is wrong and press "Save" (or Cmd/Ctrl+Enter).
3. The marked passage is highlighted and gets a 💬 icon. Click it to come back,
   edit the note or delete it.
4. **For images** — hover over the picture and the same button appears in the
   corner.

The bottom right shows how many notes you have left so far. "List" shows all of
them; "Clear" wipes them.

## How to hand the result back

The **"Export"** button at the bottom right saves one file,
\`tdc-review-YYYY-MM-DD.md\`, holding every note. That is the file to send back:
for each note it records which source file the passage lives in, under which
heading, and exactly which phrase it refers to.

> **The notes live in this browser.** Do not clear its data before exporting,
> and stay in the same browser — otherwise the list comes back empty.

## What is in here

The documentation site, built in three languages: English, Russian and Spanish.
The language switcher is in the top right. This is exactly what a user sees; the
review layer exists only in this copy.
`,
);

// --------------------------------------------------------------- 5. archive

step(5, 'Packing the zip…');
rmSync(ZIP, { force: true });
execFileSync('zip', ['-r', '-q', ZIP, relative(dirname(OUT), OUT)], { cwd: dirname(OUT) });

const size = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nDone.`);
console.log(`  folder:  ${OUT}`);
console.log(`  archive: ${ZIP} (${size(ZIP)})`);
console.log(`\nSend the archive to the reviewer. They unpack it and run:  node serve.js\n`);

if (!existsSync(join(OUT, 'index.html'))) throw new Error('bundle has no index.html');
