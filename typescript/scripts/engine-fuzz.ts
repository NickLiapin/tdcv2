/**
 * Random configs built from the features that met in the hospital report, on every engine.
 *
 * B1, B2, the repeat-element bug and B3 had one thing in common: each feature worked on its
 * own, every shared case passed, and the bug lived where two of them met — a `<uniq>` group
 * read by a pool lookup, a `distinct` repeat inside a pool, a generator pack under `repeat`, a
 * filter inside a pool. Nobody writes a case for every pair. This writes configs that combine
 * them at random — pools and the lookups that read them, `<uniq>` and `<distinct>` groups,
 * `repeat`, plain and generator packs, `switch`, `parent=`, formulas, distributions reading a
 * sibling — and runs each on engines 1, 2 and 3, with an `<assert>` beside every lookup.
 *
 * Engines that produce output must produce the same output. A `<uniq>` may arrange its columns
 * differently on the in-memory engine and on the disk engines, both correctly, so a config with
 * one is compared column by column, as multisets, instead of line by line. An engine that stops
 * on an `<assert>` the others pass has disagreed, refusal or not.
 *
 * `--ports` runs the configs through the other four implementations too, on the engine each
 * picks, and compares with this one. That spawns a process per config per implementation, so it
 * is slower; it needs the CLIs built (`rust/target/debug/tdcv2`, the Java CLI jar, the Python
 * virtual environment, the C# tool).
 *
 *   npx tsx scripts/engine-fuzz.ts                    # 200 configs, seed "fuzz" — what `check` runs
 *   npx tsx scripts/engine-fuzz.ts --n 2000 --seed x  # more, elsewhere
 *   npx tsx scripts/engine-fuzz.ts --ports            # and against the four ports
 *   npx tsx scripts/engine-fuzz.ts --keep /tmp/fz     # write each disagreeing config there
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TDC, type TdcOptions } from '../src/index.js';

type Engine = NonNullable<TdcOptions['engine']>;
const ENGINES: readonly Engine[] = [1, 2, 3];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const TOTAL = Number(arg('--n') ?? '200');
const SEED = arg('--seed') ?? 'fuzz';
const KEEP = arg('--keep');
const VERBOSE = process.argv.includes('--verbose');
const PORTS = process.argv.includes('--ports');

/** mulberry32 over a string hash — the fuzzer's own dice, unrelated to the engine's. */
function dice(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Built {
  readonly config: string;
  /**
   * Printed columns that follow a `<uniq>` group — its members and whatever reads them. The
   * in-memory engine and the disk engines may arrange a group differently, both correctly, and
   * a lookup filtered on a member then draws for a different key. Those columns are held by the
   * config's `<assert>`s instead of being compared.
   */
  readonly loose: ReadonlySet<number>;
  /** What the config combines, for the report. */
  readonly features: readonly string[];
}

const LETTERS = ['a', 'b', 'c', 'd', 'e'];

function build(index: number): Built {
  const rnd = dice(`${SEED}#${String(index)}`);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const chance = (p: number): boolean => rnd() < p;
  const count = 6 + Math.floor(rnd() * 19);
  const features = new Set<string>();
  const env: string[] = [];
  const shown: string[] = [];
  const asserts: string[] = [];
  // Names that follow a top-level `<uniq>` group, and the printed columns that do.
  const followers = new Set<string>();
  let n = 0;
  const name = (): string => `C${String(++n)}`;
  // Columns a later column may read: text ones draw from LETTERS, numeric ones are numbers.
  const texts: string[] = [];
  const numbers: string[] = [];

  // A pool, and sometimes a second one that looks the first up — with a filter written inside it.
  const pools: { name: string; size: number }[] = [];
  if (chance(0.6)) {
    const size = 4 + Math.floor(rnd() * 5);
    const members = [
      '<sequence name="pid"><gen type="increment" value="1"/></sequence>',
      // Every key at least once, so a lookup never asks for one the pool lacks: a filter that
      // matches nobody is refused on every engine, and a refusal tests nothing.
      `<sequence name="pkey"><gen type="text" value="${LETTERS.slice(0, 4).join(',')}" order="sequential"/></sequence>`,
      '<sequence name="pval"><gen type="number" value="1..90"/></sequence>',
    ];
    if (chance(0.3)) {
      members.push(
        '<sequence name="pmail"><gen type="template" value="common.internet.email"/></sequence>',
      );
      features.add('generator pack in a pool');
    }
    if (chance(0.3)) {
      members.push(
        `<sequence name="pallg"><gen type="template" value="medical.allergy" repeat="1..2" separator=";"${chance(0.5) ? ' distinct="true"' : ''}/></sequence>`,
      );
      features.add('repeat in a pool');
    }
    if (chance(0.3)) {
      members.push(
        '<uniq><sequence name="pu1"><gen type="text" value="a,b,c,d"/></sequence><sequence name="pu2"><gen type="number" value="1..9"/></sequence></uniq>',
      );
      features.add('uniq group in a pool');
    }
    env.push(`<pool name="P1" count="${String(size)}">${members.join('')}</pool>`);
    pools.push({ name: 'P1', size });
    features.add('pool');
    if (chance(0.4)) {
      const inner = [
        '<sequence name="qid"><gen type="increment" value="1"/></sequence>',
        '<sequence name="qwant"><gen type="text" value="a,b,c,d"/></sequence>',
        '<sequence name="qref"><gen type="pool" value="P1" filter="pkey == qwant"/></sequence>',
        '<sequence name="qsum"><gen type="formula" expr="qref.pval + qid"/></sequence>',
      ];
      env.push(
        `<pool name="P2" count="${String(3 + Math.floor(rnd() * 4))}">${inner.join('')}</pool>`,
      );
      pools.push({ name: 'P2', size: 0 });
      features.add('pool lookup inside a pool');
    }
  }

  const columns = 2 + Math.floor(rnd() * 5);
  for (let c = 0; c < columns; c++) {
    const col = name();
    const kind = pick([
      'text',
      'text',
      'number',
      'plainPack',
      'genPack',
      'repeatText',
      'repeatPack',
      'repeatGenPack',
      'date',
      'regex',
      'formula',
      'poisson',
      'switch',
      'uniqNumber',
      'parent',
    ]);
    switch (kind) {
      case 'text':
        env.push(
          `<sequence name="${col}"><gen type="text" value="${LETTERS.slice(0, 4).join(',')}"${chance(0.4) ? ' percent="10,20,30,40"' : ''}/></sequence>`,
        );
        texts.push(col);
        break;
      case 'number':
        env.push(`<sequence name="${col}"><gen type="number" value="1..60"/></sequence>`);
        numbers.push(col);
        break;
      case 'plainPack':
        env.push(
          `<sequence name="${col}"><gen type="template" value="medical.allergy"/></sequence>`,
        );
        features.add('plain pack');
        break;
      case 'genPack':
        env.push(
          `<sequence name="${col}"><gen type="template" value="common.internet.email"/></sequence>`,
        );
        features.add('generator pack');
        break;
      case 'repeatText':
        env.push(
          `<sequence name="${col}"><gen type="text" value="a,b,c,d,e" repeat="1..3" separator=";"${chance(0.5) ? ' distinct="true"' : ''}/></sequence>`,
        );
        features.add('repeat');
        break;
      case 'repeatPack':
        env.push(
          `<sequence name="${col}"><gen type="template" value="medical.allergy" repeat="2" separator=";"${chance(0.5) ? ' distinct="true"' : ''}/></sequence>`,
        );
        features.add('repeat over a plain pack');
        break;
      case 'repeatGenPack':
        env.push(
          `<sequence name="${col}"><gen type="template" value="common.internet.email" repeat="1..2" separator=";"/></sequence>`,
        );
        features.add('repeat over a generator pack');
        break;
      case 'date':
        env.push(
          `<sequence name="${col}"><gen type="date" from="2024-01-01" to="2024-12-31" format="YYYY-MM-DD"/></sequence>`,
        );
        break;
      case 'regex':
        env.push(`<sequence name="${col}"><gen type="regex" value="[A-Z]{2}[0-9]{3}"/></sequence>`);
        break;
      case 'formula': {
        const from = numbers.length > 0 ? pick(numbers) : undefined;
        if (from === undefined) {
          env.push(`<sequence name="${col}"><gen type="formula" expr="_count * 3"/></sequence>`);
        } else {
          env.push(
            `<sequence name="${col}"><gen type="formula" expr="${from} * 2 + 1"/></sequence>`,
          );
          features.add('formula over a column');
        }
        numbers.push(col);
        break;
      }
      case 'poisson': {
        const rate = name();
        env.push(`<sequence name="${rate}"><gen type="text" value="1,20,200"/></sequence>`);
        const rep = chance(0.5) ? ' repeat="2" separator=" "' : '';
        env.push(
          `<sequence name="${col}"><gen type="number" distribution="poisson" lambda="${rate}"${rep}/></sequence>`,
        );
        shown.push(rate);
        features.add(
          rep ? 'repeat over a sibling-reading distribution' : 'sibling-reading distribution',
        );
        break;
      }
      case 'switch': {
        const on = texts.length > 0 ? pick(texts) : undefined;
        if (on === undefined) {
          env.push(`<sequence name="${col}"><gen type="text" value="x,y"/></sequence>`);
          break;
        }
        env.push(
          `<switch name="${col}" on="${on}"><case is="a"><gen type="number" value="1..9"/></case><case is="b|c"><gen type="template" value="medical.allergy"/></case><default><data>other</data></default></switch>`,
        );
        features.add('switch');
        break;
      }
      case 'uniqNumber':
        env.push(
          `<sequence name="${col}" uniq="true"><gen type="number" value="1..400"/></sequence>`,
        );
        features.add('uniq column');
        break;
      case 'parent': {
        const on = texts.length > 0 ? pick(texts) : undefined;
        if (on === undefined) {
          env.push(`<sequence name="${col}"><gen type="text" value="p,q"/></sequence>`);
          break;
        }
        env.push(
          `<sequence name="${col}" parent="${on}.a"><gen type="number" value="1..9"/></sequence>`,
        );
        features.add('parent');
        break;
      }
    }
    shown.push(col);
  }

  // A group over two fresh columns: rearranged (<uniq>) or repaired (<distinct>).
  if (chance(0.45)) {
    const g1 = name();
    const g2 = name();
    const tag = chance(0.5) ? 'uniq' : 'distinct';
    env.push(
      `<${tag}><sequence name="${g1}"><gen type="text" value="${LETTERS.slice(0, 4).join(',')}"/></sequence><sequence name="${g2}"><gen type="number" value="1..12"/></sequence></${tag}>`,
    );
    shown.push(g1, g2);
    texts.push(g1);
    numbers.push(g2);
    if (tag === 'uniq') {
      followers.add(g1);
      followers.add(g2);
    }
    features.add(`${tag} group`);
  }

  // A lookup at the top level, read by a formula and pinned by an assert — the B1 shape.
  if (pools.some((p) => p.name === 'P1') && texts.length > 0) {
    const on = pick(texts);
    const ref = name();
    env.push(
      `<sequence name="${ref}"><gen type="pool" value="P1" filter="pkey == ${on}"/></sequence>`,
    );
    const reader = name();
    if (followers.has(on)) {
      followers.add(`${ref}.pid`);
      followers.add(reader);
    }
    env.push(`<sequence name="${reader}"><gen type="formula" expr="${ref}.pval + 1"/></sequence>`);
    asserts.push(
      `<assert each="${ref}.pkey == ${on}" says="the lookup found what it filtered on"/>`,
    );
    asserts.push(`<assert each="${reader} == ${ref}.pval + 1" says="the reader saw the lookup"/>`);
    shown.push(`${ref}.pid`, reader);
    features.add('pool lookup on a column');
    if (pools.some((p) => p.name === 'P2')) {
      const ref2 = name();
      env.push(`<sequence name="${ref2}"><gen type="pool" value="P2"/></sequence>`);
      asserts.push(
        `<assert each="${ref2}.qref.pkey == ${ref2}.qwant" says="the inner lookup held"/>`,
      );
      shown.push(`${ref2}.qsum`);
      features.add('nested pool path');
    }
  }

  const data = shown.map((s) => `\${{${s}}}`).join('|');
  const config =
    `<tdc><env count="${String(count)}" seed="fz${String(index)}" local="en">` +
    env.join('') +
    asserts.join('') +
    `</env><block><line><data>${data}</data></line></block></tdc>`;
  const loose = new Set(shown.flatMap((s, i) => (followers.has(s) ? [i] : [])));
  return { config, loose, features: [...features].sort() };
}

interface Outcome {
  readonly output?: string;
  readonly refused?: string;
}

function attempt(run: () => string): Outcome {
  try {
    return { output: run() };
  } catch (err) {
    return { refused: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '' };
  }
}

/** The output with the loose columns blanked, so everything else is compared byte for byte. */
function strict(text: string, loose: ReadonlySet<number>): string {
  if (loose.size === 0) return text;
  return text
    .split('\n')
    .map((row) =>
      row
        .split('|')
        .map((v, i) => (loose.has(i) ? '' : v))
        .join('|'),
    )
    .join('\n');
}

function agree(a: string, b: string, loose: ReadonlySet<number>): boolean {
  return strict(a, loose) === strict(b, loose);
}

// ---- the four ports, by CLI ------------------------------------------------------------------

const repo = resolve(import.meta.dirname, '..', '..');
function javaJar(): string | undefined {
  const dir = join(repo, 'java', 'build', 'libs');
  if (!existsSync(dir)) return undefined;
  const jar = readdirSync(dir)
    .filter((f) => f.endsWith('-cli.jar'))
    .sort()
    .pop();
  return jar === undefined ? undefined : join(dir, jar);
}
const PORT_COMMANDS: readonly { name: string; argv: (file: string) => [string, string[]] }[] = [
  { name: 'Python', argv: (f) => [join(repo, 'python', '.venv', 'bin', 'tdcv2'), [f]] },
  { name: 'Rust', argv: (f) => [join(repo, 'rust', 'target', 'debug', 'tdcv2'), [f]] },
  { name: 'Java', argv: (f) => ['java', ['-jar', javaJar() ?? 'missing.jar', f]] },
  {
    name: 'C#',
    argv: (f) => [
      'dotnet',
      [join(repo, 'csharp', 'Tdcv2.Cli.Tool', 'bin', 'Debug', 'net6.0', 'Tdcv2.Cli.dll'), f],
    ],
  },
];

function runPort(command: [string, string[]]): Outcome {
  try {
    return {
      output: execFileSync(command[0], command[1], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    return { refused: stderr.split('\n').find((l) => l.trim() !== '') ?? '' };
  }
}

// ---- the run ----------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'tdc-engine-fuzz-'));
process.on('exit', () => {
  rmSync(scratch, { recursive: true, force: true });
});
if (KEEP !== undefined) mkdirSync(KEEP, { recursive: true });

let rendered = 0;
let refusedEverywhere = 0;
const featureCounts = new Map<string, number>();
const problems: { index: number; built: Built; detail: string[] }[] = [];

for (let index = 0; index < TOTAL; index++) {
  const built = build(index);
  for (const f of built.features) featureCounts.set(f, (featureCounts.get(f) ?? 0) + 1);
  const outcomes = new Map<Engine, Outcome>();
  for (const engine of ENGINES) {
    outcomes.set(
      engine,
      attempt(() => new TDC({ configString: built.config, engine }).toString()),
    );
  }
  const produced = [...outcomes.entries()].filter(([, o]) => o.output !== undefined);
  if (produced.length === 0) {
    refusedEverywhere += 1;
    if (VERBOSE) console.log(`#${String(index)} refused: ${outcomes.get(1)?.refused ?? ''}`);
    continue;
  }
  rendered += 1;
  const detail: string[] = [];
  const first = produced[0];
  for (const [engine, o] of produced.slice(1)) {
    if (first && !agree(first[1].output ?? '', o.output ?? '', built.loose)) {
      detail.push(`engine ${String(first[0])} and engine ${String(engine)} print different data`);
    }
  }
  for (const [engine, o] of outcomes) {
    if (o.refused?.includes('assert failed')) detail.push(`engine ${String(engine)}: ${o.refused}`);
  }
  if (PORTS) {
    const file = join(scratch, `fz${String(index)}.tdc`);
    writeFileSync(file, built.config);
    const reference = attempt(() => new TDC({ configString: built.config }).toString());
    for (const port of PORT_COMMANDS) {
      const o = runPort(port.argv(file));
      if (reference.output !== undefined && o.output !== undefined) {
        if (!agree(reference.output, o.output, built.loose)) {
          detail.push(`${port.name} prints different data from the reference`);
        }
      } else if ((reference.output === undefined) !== (o.output === undefined)) {
        detail.push(
          `${port.name} ${o.output === undefined ? `refused: ${o.refused ?? ''}` : 'rendered'} where the reference ${reference.output === undefined ? `refused: ${reference.refused ?? ''}` : 'rendered'}`,
        );
      }
    }
  }
  if (detail.length > 0) {
    problems.push({ index, built, detail });
    if (KEEP !== undefined)
      writeFileSync(join(KEEP, `fz${String(index)}.tdc`), built.config + '\n');
  }
}

console.log(
  `${String(TOTAL)} configs (seed "${SEED}") × engines ${ENGINES.join(', ')}${PORTS ? ' and the four ports' : ''}`,
);
console.log(`  ${String(rendered)} rendered, ${String(refusedEverywhere)} refused everywhere`);
console.log(`  ${String(problems.length)} disagree`);
for (const [f, c] of [...featureCounts.entries()].sort()) {
  console.log(`    ${f.padEnd(44)} ${String(c)}`);
}
for (const p of problems.slice(0, VERBOSE ? problems.length : 10)) {
  console.log(`\n✗ #${String(p.index)} [${p.built.features.join(', ')}]`);
  for (const d of p.detail) console.log(`    ${d}`);
  console.log(`    ${p.built.config}`);
}
process.exit(problems.length === 0 ? 0 : 1);
