/**
 * Property checks for `read="quantile"` that a fixture cannot hold.
 *
 * A shared case pins ten lines. The promises this feature is FOR live on a
 * hundred thousand: that the shape survives a six-order-of-magnitude tail, that
 * every observation owns exactly its share, that the comb is gone, that a big
 * atom is not smeared, that the engines agree. Those are properties, not bytes,
 * and this script asserts them directly.
 *
 * Written by the Studio agent while probing the feature, handed over whole, and
 * kept here unchanged apart from this header — it found the half-weight edges,
 * so it has earned its place in the tree rather than in someone's scratch dir.
 * Run it against any implementation's CLI:
 *
 *     node scripts/signature/quantile-signature.cjs dist/cli/main.js
 *
 * It builds its own samples, exits non-zero on failure, and is meant to be hung
 * in each port's CI once the port exists. (`.cjs` because the workspace is ESM
 * and the script is plain CommonJS — the only edit it needed.)
 *
 * ONE THING TO KNOW BEFORE READING A FAILURE AS A DEFECT: the reference
 * quantile in here uses the MIDPOINT convention — `sorted[i]` at `(i + 0.5)/n`,
 * the same one the engine uses. Computed against the ends convention the same
 * runs read about 1.3% off, and that is two definitions of a quantile rather
 * than an error.
 */

/**
 * The `read="quantile"` promises that a byte-for-byte fixture cannot hold.
 *
 * The cases in `quantile-shape.json` pin BEHAVIOUR: ten lines that all five
 * implementations must agree on. But the promises this feature exists for live
 * on a hundred thousand rows — "the deviation across 99 quantiles is zero", "an
 * edge owns exactly its share", "a six-order-of-magnitude tail is not lost".
 * None of that fits in a fixture, all of it has to be checked, and separately in
 * every implementation.
 *
 * Run:  node quantile-signature.cjs /path/to/dist/cli/main.js
 *
 * The samples are built here by a portable generator, so the script carries no
 * files of its own and any language can copy the same shape.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One argument is a Node script, which is how the reference is run. Several are a whole
// command — `python -m tdcv2.cli`, `java -jar tdc.jar`, a Rust or C# binary — so the same
// checks run against any of the five without a copy per language.
const COMMAND = process.argv.slice(2);
if (COMMAND.length === 0) {
  console.error(
    'give it a CLI: node quantile-signature.cjs dist/cli/main.js\n' +
      '            or node quantile-signature.cjs java -jar build/libs/tdc.jar',
  );
  process.exit(2);
}
// One argument ending in a JS extension is a script and needs `node` in front of it;
// anything else is run as it stands, which covers a native binary and a whole command.
const [EXE, ...PREFIX] =
  COMMAND.length === 1 && /\.[cm]?js$/.test(COMMAND[0]) ? ['node', COMMAND[0]] : COMMAND;
const CLI = COMMAND.join(' ');

/** Run the implementation under test on one config. */
function run(args) {
  try {
    return execFileSync(EXE, [...PREFIX, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // The implementation's own words, not a Node stack trace over a Buffer of bytes.
    const said = (e.stderr ?? Buffer.alloc(0)).toString().trim();
    throw new Error(`${CLI} refused:\n${said || e.message}`);
  }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigcheck-'));
let failed = 0;

/** The same LCG used throughout: awkward numbers, and the same ones every run. */
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const write = (name, lines) => {
  fs.writeFileSync(path.join(DIR, name), lines.join('\n'));
  return name;
};

const generate = (src, count, extra, tag) => {
  const config = `<tdc><env count="${count}" seed="${tag}" local="en"><sequence name="OUT">
    <gen type="file" src="${src}" read="quantile"${extra}/></sequence></env>
    <block><line><data>\${{OUT}}</data></line></block></tdc>`;
  const cfg = path.join(DIR, `${tag}.tdc`);
  const out = path.join(DIR, `${tag}.out`);
  fs.writeFileSync(cfg, config);
  run([cfg, '--data-path', DIR, '-o', out]);
  return fs.readFileSync(out, 'utf8').trim().split('\n');
};

/**
 * The sample's quantile under the MIDPOINT convention — `sorted[i]` sits at
 * `(i + 0.5)/n`.
 *
 * It is the convention the engine places its observations by, and the one a row
 * reads its probability from under `sample="exact"`. Computing the reference
 * against the ends (`i/(n-1)`) means seeing a 1.3% shift of the axis and taking
 * it for an error.
 */
const quantile = (sorted, p) => {
  const i = p * sorted.length - 0.5;
  if (i <= 0) return sorted[0];
  if (i >= sorted.length - 1) return sorted[sorted.length - 1];
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (i - lo);
};

const check = (title, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${title}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const worstQuantileGap = (src, got) => {
  const a = [...src].sort((x, y) => x - y);
  const b = [...got].sort((x, y) => x - y);
  let worst = 0;
  for (let k = 1; k <= 99; k++) {
    const p = k / 100;
    const want = quantile(a, p);
    const have = quantile(b, p);
    worst = Math.max(worst, (Math.abs(want - have) / (Math.abs(want) || 1)) * 100);
  }
  return worst;
};

console.log(`\nread="quantile" — the promises that only show up at scale\nCLI: ${CLI}\n`);

// -- 1. A tail six orders of magnitude long
{
  const src = Array.from({ length: 5000 }, () => Number((1 / Math.pow(rnd(), 1 / 0.8)).toFixed(4)));
  const name = write('tail.txt', src.map(String));
  const got = generate(name, 100000, ' sample="exact"', 'tail').map(Number);
  const worst = worstQuantileGap(src, got);
  check(
    'Pareto a=0.8: worst deviation across 99 quantiles is zero',
    worst < 0.001,
    `${worst.toFixed(4)}%, distinct values ${new Set(got).size} of ${new Set(src).size}`,
  );
  check(
    '  and the comb is gone: many times more distinct values than the sample',
    new Set(got).size > new Set(src).size * 5,
  );
}

// -- 2. An edge owns exactly its share
{
  const src = Array.from({ length: 100 }, (_, i) => i + 1);
  const name = write('even.txt', src.map(String));
  const got = generate(name, 200000, ' sample="exact"', 'even');
  const share = (v) => (got.filter((x) => x === String(v)).length / got.length) * 100;
  const worst = Math.max(...src.map((v) => Math.abs(share(v) - 1)));
  check(
    'a hundred distinct values: each owns exactly 1.000%',
    worst < 0.005,
    `worst deviation ${worst.toFixed(4)} pp, first ${share(1).toFixed(3)}%, last ${share(100).toFixed(3)}%`,
  );
}

// -- 3. No gaps means exact shares ────────────────────────────────────────────────
{
  const src = [];
  for (let i = 0; i < 3000; i++) src.push(Math.min(20, Math.floor(-Math.log(1 - rnd()) * 3)));
  const name = write('ints.txt', src.map(String));
  const got = generate(name, 200000, ' sample="exact"', 'ints');
  check(
    'whole numbers in, whole numbers out',
    got.every((x) => !x.includes('.')),
  );
  const vals = [...new Set(src)];
  const worst = Math.max(
    ...vals.map((v) => {
      const want = (src.filter((x) => x === v).length / src.length) * 100;
      const have = (got.filter((x) => x === String(v)).length / got.length) * 100;
      return Math.abs(want - have);
    }),
  );
  check(
    'whole numbers with no gaps: every share is exact',
    worst < 0.01,
    `worst deviation ${worst.toFixed(4)} pp across ${vals.length} values`,
  );
}

// -- 4. A big atom survives the ramps at its edges ───────────────────────────────
{
  const src = [];
  for (let i = 0; i < 4000; i++) src.push(0);
  for (let i = 0; i < 1500; i++) src.push(100);
  for (let i = 0; i < 4500; i++) src.push(Number((rnd() * 500).toFixed(2)));
  const name = write('atoms.txt', src.map(String));
  const got = generate(name, 100000, ' sample="exact"', 'atoms');
  const share = (v) => (got.filter((x) => Number(x) === v).length / got.length) * 100;
  check(
    'the 40% atom comes back almost whole',
    Math.abs(share(0) - 40) < 0.05,
    `${share(0).toFixed(3)}%`,
  );
  check(
    'the 15% atom comes back almost whole',
    Math.abs(share(100) - 15) < 0.05,
    `${share(100).toFixed(3)}%`,
  );
  const near = (got.filter((x) => Number(x) > 0 && Number(x) < 0.5).length / got.length) * 100;
  const nearSrc = (src.filter((x) => x > 0 && x < 0.5).length / src.length) * 100;
  check(
    '  and the plateau does not smear into its neighbours',
    Math.abs(near - nearSrc) < 0.01,
    `next to zero ${near.toFixed(4)}% against ${nearSrc.toFixed(4)}% in the source`,
  );
}

// -- 5. The share is held by the distance to the neighbour, not by multiplicity ─────────────────
{
  // EVERY value here appears once. The dense ones must keep their share; the far ones must not.
  const dense = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const far = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
  const name = write('gaps.txt', [...dense, ...far].map(String));
  const got = generate(name, 400000, ' sample="exact"', 'gaps');
  const share = (v) => (got.filter((x) => x === String(v)).length / got.length) * 100;
  const denseWorst = Math.max(...dense.slice(1, -1).map((v) => Math.abs(share(v) - 5)));
  check(
    'densely spaced values keep exactly their 5%',
    denseWorst < 0.05,
    `worst deviation ${denseWorst.toFixed(4)} pp`,
  );
  const farWorst = Math.max(...far.slice(0, -1).map(share));
  check(
    '  while the ones with gaps dissolve into the gap',
    farWorst < 1,
    `the most persistent of the far ones — ${farWorst.toFixed(3)}% instead of 5%`,
  );
}

// -- 6. The features beside it do not break the signature ─────────────────────────────
{
  const src = Array.from({ length: 2000 }, () => Number((rnd() * 1000).toFixed(3)));
  const name = write('plain.txt', src.map(String));
  // First the same run with NO missing cells: it has to be exact, and that is the
  // sharp half of the check. The jitter below belongs to missing=, not to the read.
  const clean = generate(name, 60000, ' sample="exact"', 'clean').map(Number);
  check(
    'with no missing cells the signature is exact',
    worstQuantileGap(src, clean) < 0.001,
    `${worstQuantileGap(src, clean).toFixed(4)}%`,
  );

  const config = `<tdc><env count="60000" seed="nbr" local="en">
      <sequence name="V"><gen type="file" src="${name}" read="quantile" sample="exact" missing="0.1"/></sequence>
    </env><block><line><data>\${{V}}</data></line></block></tdc>`;
  const cfg = path.join(DIR, 'nbr.tdc');
  const out = path.join(DIR, 'nbr.out');
  fs.writeFileSync(cfg, config);
  run([cfg, '--data-path', DIR, '-o', out]);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  const blank = (lines.filter((x) => x === '').length / lines.length) * 100;
  check(
    'missing= blanks exactly its share',
    Math.abs(blank - 10) < 0.5,
    `${blank.toFixed(2)}% blank`,
  );

  /**
   * What is left is measured AS A FRACTION OF THE RANGE, not relative to the
   * value.
   *
   * `missing=` blanks a random tenth, and what survives carries the ordinary
   * sampling jitter — which is correct in itself. A relative measure turns that
   * jitter into percentages wherever the denominator is small: at the 9th
   * quantile a difference of 0.65 against a value of 88 reads as 0.7% when it is
   * 0.2% of the range. The first version of this check tripped on exactly that —
   * the threshold was mine, not the engine's.
   */
  const kept = lines.filter((x) => x !== '').map(Number);
  const a = [...src].sort((x, y) => x - y);
  const b = [...kept].sort((x, y) => x - y);
  const span = quantile(a, 0.99) - quantile(a, 0.01);
  let worst = 0;
  for (let k = 1; k <= 99; k++) {
    const p = k / 100;
    worst = Math.max(worst, (Math.abs(quantile(a, p) - quantile(b, p)) / span) * 100);
  }
  check(
    '  and what is left keeps the signature within sampling jitter',
    worst < 1,
    `${worst.toFixed(3)}% of the range across 99 quantiles`,
  );
}

// -- 7. The same bytes on every engine and at any --jobs ──────────────────────
{
  const src = Array.from({ length: 800 }, () => Number((rnd() * 100).toFixed(2)));
  const name = write('det.txt', src.map(String));
  const config = `<tdc><env count="50000" seed="det" local="en"><sequence name="OUT">
    <gen type="file" src="${name}" read="quantile" sample="exact"/></sequence></env>
    <block><line><data>\${{OUT}}</data></line></block></tdc>`;
  const cfg = path.join(DIR, 'det.tdc');
  fs.writeFileSync(cfg, config);
  const variants = [[], ['--engine', '2'], ['--engine', '3'], ['--jobs', '7']];
  const outs = variants.map((args, k) => {
    const out = path.join(DIR, `det${k}.out`);
    try {
      run([cfg, '--data-path', DIR, '-o', out, ...args]);
      return fs.readFileSync(out, 'utf8');
    } catch {
      return null;
    }
  });
  check(
    'engines 1, 2, 3 and --jobs 7 produce the same bytes',
    outs.every((x) => x !== null && x === outs[0]),
  );
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(failed ? `\nfailed: ${failed}\n` : '\nall clean\n');
process.exit(failed ? 1 : 0);
