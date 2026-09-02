#!/usr/bin/env node
/**
 * Cut a release: one command, one tag, five registries.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * 0.2.0 was cut by hand from a runbook, and three separate things went wrong in
 * one afternoon:
 *
 *   1. The CHANGELOG named four of the twenty-odd changes in the release, because
 *      it was written from what somebody remembered rather than from the range of
 *      commits. Nobody could have noticed by reading it — a short changelog looks
 *      exactly like a small release.
 *   2. Three tags were pushed because the runbook still said so, from when Java
 *      and C# had their own release workflows. They had been merged into
 *      `publish.yml` months earlier, so Maven received the same bundle twice and
 *      the Central Portal held two identical deployments waiting for a human.
 *   3. Two of the five version numbers were missed — the C# CLI project and
 *      `Cargo.lock` — and were only found by grepping afterwards.
 *
 * Each of those is a check a machine can make in a second, and a person cannot
 * make reliably at eleven at night. So they are made here, before anything is
 * pushed, and the release is refused rather than half-done.
 *
 * ── The check that matters most ──────────────────────────────────────────────
 *
 * The other checks are bookkeeping. The one that earns this file is
 * `changelogCoversTheSurface`: it asks the engine what NAMES it has gained since
 * the last tag — generator types, attributes, compute tags, diagnostic codes,
 * expression functions — and requires every one of them to appear in the new
 * CHANGELOG section. A feature that reached users and not the changelog is
 * exactly what happened, and it is the one failure a person cannot catch by
 * re-reading their own work.
 *
 *   node scripts/release.mjs            # check everything, change nothing
 *   node scripts/release.mjs --tag      # …and, if clean, tag and push
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const push = process.argv.includes('--tag');

const problems = [];
const fail = (what) => problems.push(what);
const ok = (what) => console.log(`  ok    ${what}`);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ── 1. the five version numbers, plus the two that were missed ───────────────

/**
 * Every file that carries the version, including the two that 0.2.0 forgot.
 *
 * `Cargo.lock` and the C# CLI project are here BECAUSE they were missed: a list
 * that only holds the five obvious ones is a list that has already failed once.
 */
const VERSION_FILES = [
  ['typescript/package.json', /"version":\s*"([^"]+)"/],
  ['typescript/src/version.ts', /export const VERSION = '([^']+)'/],
  ['python/pyproject.toml', /^version = "([^"]+)"/m],
  ['rust/Cargo.toml', /^version = "([^"]+)"/m],
  ['rust/Cargo.lock', /name = "tdcv2"\nversion = "([^"]+)"/],
  ['java/build.gradle.kts', /version = "([^"]+)"/],
  ['csharp/Tdcv2/Tdcv2.csproj', /<Version>([^<]+)<\/Version>/],
  ['csharp/Tdcv2.Cli.Tool/Tdcv2.Cli.Tool.csproj', /<Version>([^<]+)<\/Version>/],
];

function versions() {
  const found = new Map();
  for (const [file, re] of VERSION_FILES) {
    const m = re.exec(read(file));
    if (!m) {
      fail(`${file}: no version found — the pattern this script looks for has moved`);
      continue;
    }
    found.set(file, m[1]);
  }
  const distinct = new Set(found.values());
  if (distinct.size > 1) {
    fail(
      'the version differs between files:\n' +
        [...found].map(([f, v]) => `        ${v}  ${f}`).join('\n'),
    );
  } else if (distinct.size === 1) {
    ok(`one version in all ${String(found.size)} files: ${[...distinct][0]}`);
  }
  return [...distinct][0];
}

// ── 2. the changelog says something, and says it about THIS version ──────────

function changelogSection(version) {
  const text = read('CHANGELOG.md');
  const start = text.indexOf(`## [${version}]`);
  if (start < 0) {
    fail(`CHANGELOG.md has no "## [${version}]" section`);
    return '';
  }
  const next = text.indexOf('\n## [', start + 1);
  const body = text.slice(start, next < 0 ? undefined : next);
  const bullets = body.match(/^- \*\*/gm)?.length ?? 0;
  if (bullets === 0) {
    fail(`CHANGELOG.md's ${version} section has no entries`);
  } else {
    ok(`CHANGELOG has ${String(bullets)} entries for ${version}`);
  }
  // An Unreleased section left holding entries means work was described and then
  // released under a heading that does not mention it.
  const unreleased = /## \[Unreleased\]([\s\S]*?)\n## \[/.exec(text)?.[1] ?? '';
  if (/^- /m.test(unreleased)) {
    fail('CHANGELOG.md still has entries under [Unreleased] — they are not in this release');
  }
  return body;
}

/**
 * The five package changelogs — the ones that actually ship, inside the npm tarball,
 * the wheel, the crate, the jar and the nupkg.
 *
 * The root changelog is engine-wide: what a config produces, true of all five at one
 * version. Each package file carries what is specific to that package. Nothing checked
 * them until 0.2.1, and by then two had stopped at 0.1.4 and three were still holding
 * shipped work under [Unreleased] — a reader who installed from PyPI and opened the
 * changelog would have been told the package had not changed since August 3rd.
 *
 * "Nothing package-specific happened" is a fine thing for a release to say. It just has
 * to be SAID: silence and nothing-to-report are indistinguishable in a changelog, and
 * only one of them is an answer.
 */
function packageChangelogs(version) {
  const files = [
    'typescript/CHANGELOG.md',
    'python/CHANGELOG.md',
    'rust/CHANGELOG.md',
    'java/CHANGELOG.md',
    'csharp/CHANGELOG.md',
  ];
  const missing = [];
  const stillUnreleased = [];
  for (const file of files) {
    const text = read(file);
    if (!text.includes(`## [${version}]`)) missing.push(file);
    const unreleased = /## \[Unreleased\]([\s\S]*?)(\n## \[|$)/.exec(text)?.[1] ?? '';
    if (/^- /m.test(unreleased)) stillUnreleased.push(file);
  }
  if (missing.length > 0) {
    fail(`no "## [${version}]" section in: ${missing.join(', ')}`);
  }
  if (stillUnreleased.length > 0) {
    fail(`entries still under [Unreleased] in: ${stillUnreleased.join(', ')}`);
  }
  if (missing.length === 0 && stillUnreleased.length === 0) {
    ok(`all ${String(files.length)} package changelogs have a ${version} section`);
  }
}

// ── 3. every NAME the engine gained is mentioned ─────────────────────────────

/**
 * Ask the engine what it has that it did not have at the last tag, and require
 * the changelog to mention each one.
 *
 * The comparison runs the surface enumeration against a checkout of the last
 * tag, so it answers with names rather than with a diff of source lines: adding
 * `peak_at` shows up as `peak_at`, and moving a file does not show up at all.
 */
async function changelogCoversTheSurface(section, lastTag) {
  const { groups } = await import('./engine-surface.mjs');
  const now = groups();

  let before;
  try {
    const worktree = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
    git('worktree', 'add', '--detach', worktree, lastTag);
    try {
      const mod = await import(`${join(worktree, 'scripts', 'engine-surface.mjs')}`);
      before = mod.groups();
    } finally {
      git('worktree', 'remove', '--force', worktree);
    }
  } catch (e) {
    fail(`could not read the engine surface at ${lastTag}: ${e.message}`);
    return;
  }

  const wasThere = new Map(before.map((g) => [g.id, new Set(g.names)]));
  const acknowledged = coversDeclared(section);
  const missing = [];
  let added = 0;
  for (const group of now) {
    for (const name of group.names) {
      if (wasThere.get(group.id)?.has(name)) continue;
      added++;
      if (section.includes(name) || acknowledged.has(name)) continue;
      missing.push(`${group.title}: ${name}`);
    }
  }
  if (missing.length > 0) {
    fail(
      `the engine gained ${String(added)} names since ${lastTag} and the changelog does not ` +
        `mention ${String(missing.length)} of them:\n` +
        missing.map((m) => `        ${m}`).join('\n'),
    );
  } else {
    ok(`all ${String(added)} names added since ${lastTag} appear in the changelog`);
  }
}


/**
 * Names a prose entry covers without spelling out.
 *
 * The strict form of this check — every new name must appear literally — failed
 * on its first real use, and failed for a good reason: "the trigonometric and
 * hyperbolic functions and their inverses" is a better sentence than fourteen
 * bullet points, and eighteen diagnostic codes are the diagnostics OF a feature
 * described two lines above rather than eighteen separate pieces of news.
 *
 * So an entry may carry `<!-- covers: TDC247-TDC250, acos, asin -->`. The point
 * is that waving something through is then an ACT — a line somebody wrote, sitting
 * next to the entry it belongs to — rather than the silence that let a release
 * announce a quarter of itself.
 */
function coversDeclared(section) {
  const names = new Set();
  for (const [, list] of section.matchAll(/<!--\s*covers:\s*([^>]*?)\s*-->/g)) {
    for (const item of list.split(',').map((s) => s.trim())) {
      const span = /^TDC(\d{3})\s*-\s*TDC(\d{3})$/.exec(item);
      if (span) {
        for (let n = Number(span[1]); n <= Number(span[2]); n++) {
          names.add(`TDC${String(n).padStart(3, '0')}`);
        }
      } else if (item) {
        names.add(item);
      }
    }
  }
  return names;
}

// ── 4. the tree, the branch, and the one tag ─────────────────────────────────

/**
 * The subject of the commit `tagAndPush` writes, in one place.
 *
 * It is written there and read here, and the two must agree: the check below
 * recognises this commit to let a retry through. Two spellings of it would make
 * a failed release unrecoverable without anybody understanding why.
 */
const CATALOGUE_COMMIT = 'Clear the release marks that ';

function treeIsReleasable(version) {
  if (git('status', '--porcelain') !== '') fail('the working tree has uncommitted changes');
  else ok('working tree clean');

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') fail(`on branch "${branch}" rather than main`);
  else ok('on main');

  /*
   * A `git()` that throws leaves a Node stack trace where a sentence belongs.
   * Every other failure in this file is a line in the "not releasable" list, and
   * an unreachable origin — no network, a VPN down, a bad remote — is the most
   * ordinary of them. It reported itself as an uncaught exception until it was
   * seen while testing the tag path.
   */
  try {
    git('fetch', '--quiet', 'origin', 'main');
  } catch {
    fail(`cannot reach origin (${git('remote', 'get-url', 'origin')}) — check the network or the remote`);
    return;
  }
  const ahead = git('rev-list', '--count', 'origin/main..HEAD');
  const behind = git('rev-list', '--count', 'HEAD..origin/main');
  if (behind !== '0') {
    fail(`main is ${behind} commits behind origin — pull first`);
  } else if (ahead !== '0') {
    /*
     * One kind of unpushed commit is this script's own.
     *
     * A `--tag` run that fails after writing the catalogue commit leaves exactly
     * that: one commit, no tag, nothing pushed. Refusing it would dead-end the
     * retry — the release would be blocked by its own work, with a message
     * telling the user to push, which is the one thing the atomic push is there
     * to do. Any OTHER unpushed commit is still a reason to stop: a release must
     * not publish work nobody has seen as a side effect of tagging.
     */
    const subjects = git('log', '--format=%s', 'origin/main..HEAD').split('\n').filter(Boolean);
    if (subjects.every((subject) => subject.startsWith(CATALOGUE_COMMIT))) {
      ok(`main is ${ahead} ahead: the catalogue commit of an earlier attempt, which goes up with the tag`);
    } else {
      fail(`main is ${ahead} commits ahead of origin — push first`);
    }
  } else {
    ok('main matches origin');
  }

  const tags = git('tag', '--list').split('\n');
  for (const t of [`v${version}`, `java-v${version}`, `csharp-v${version}`]) {
    if (tags.includes(t)) fail(`tag ${t} already exists — a version number is spent once`);
  }
}


// ── 5. Maven Central's monthly budget ────────────────────────────────────────

/**
 * Maven Central limits publishing PER CALENDAR MONTH, per organisation: 7
 * releases, 80 MB, 1000 files. They are visible at
 * central.sonatype.com → Publishing Settings → Usage Center, and the counter
 * there updates once a day — which is exactly late enough to be useless as a
 * brake while you are cutting releases.
 *
 * So the brake lives here, counted from the tags in this repository, which is
 * the same event: one `v*` tag is one Central release.
 *
 * The month this was written cost five of the seven — 0.1.3, 0.1.4, 0.1.5 and
 * 0.1.6 in two days, then 0.1.7 — and the size sat at 83% because every one of
 * those carried the ANTLR compiler inside the CLI jar (16.68 MB, fixed in
 * 0.1.7; a release is about 4 MB now). Neither number had anything to do with
 * how the bundle was NAMED on the Portal, which is a label and nothing else.
 */
const CENTRAL_RELEASES_PER_MONTH = 7;

function centralBudget() {
  // Both tag shapes reached Central: `java-v*` was the Java-only release path
  // until 0.1.7, and `v*` is the merged one. Deduplicated by VERSION, because
  // v0.2.0 and java-v0.2.0 were one release uploaded twice — which is the very
  // mistake that made this month tight, and must not also be miscounted here.
  const month = new Date().toISOString().slice(0, 7);
  const versions = new Set(
    git('for-each-ref', '--format=%(creatordate:format:%Y-%m) %(refname:short)', 'refs/tags/*')
      .split('\n')
      .filter((line) => line.startsWith(month))
      .map((line) => /\b(?:java-)?v(\d+\.\d+\.\d+)$/.exec(line)?.[1])
      .filter(Boolean),
  );

  const used = versions.size;
  const left = CENTRAL_RELEASES_PER_MONTH - used - 1; // -1 for the one being cut
  if (left < 0) {
    fail(
      `Maven Central allows ${String(CENTRAL_RELEASES_PER_MONTH)} releases a month and ${month} ` +
        `already has ${String(used)}: ${[...versions].join(', ')}. Cutting another exceeds it — ` +
        'wait for the month to turn, or ask Central for an open-source adjustment.',
    );
  } else if (left <= 1) {
    console.log(
      `  warn  ${String(used)} Central releases already in ${month}; this one leaves ` +
        `${String(left)} of ${String(CENTRAL_RELEASES_PER_MONTH)}`,
    );
  } else {
    ok(`Central budget: ${String(used)} used in ${month}, ${String(left)} left after this one`);
  }
}

// ── 6. the suite CI is not allowed to run ────────────────────────────────────

/** A command whose output belongs on screen, failing loudly. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

/**
 * The heavy tests, run here because this is the only gate that comes before a tag.
 *
 * They write real gigabyte-scale files and are deliberately kept OUT of CI: a
 * runner would be out of disk before it was out of minutes, and each file refuses
 * to start when `CI` is set so a mistaken workflow line cannot burn an hour. That
 * exclusion is right, and it leaves a hole — nothing then requires them ever to
 * run at all.
 *
 * They fell straight through it. `starting`, a progress phase written before any
 * work begins, landed on 27 August across five implementations and three languages
 * of documentation; `progress.heavy.ts` kept asserting the old first phase and was
 * red for five days. It was found only because 0.3.0 happened to be cut by hand.
 *
 * Run rather than remembered. A stamp file recording "the suite passed at commit
 * X" was the alternative, and it is the worse one: it goes stale on any later
 * commit, including a documentation typo, so it would refuse releases for reasons
 * that are not about the engine — and a gate that cries wolf gets edited out.
 * Running costs about three and a half minutes and under a gigabyte, cannot lie
 * about having happened, and only fires under `--tag`, so the ordinary check stays
 * quick enough to keep running often.
 */
function heavyTestsPass() {
  console.log('\nthe heavy suite — the one CI may not run (~3.5 min, <1 GB)\n');
  const result = spawnSync('npm', ['--prefix', 'typescript', 'run', 'test:heavy'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('\nthe heavy suite failed — nothing was tagged, the version is not spent.\n');
    process.exit(1);
  }
}

// ── 7. tag, catalogue, commit, tag again, push once ──────────────────────────

/**
 * ONE tag — created twice, on purpose.
 *
 * `webdoc/scripts/build-pack-catalogue.mjs` derives each pack's "next release"
 * mark from the newest `v*` tag. A pack the PUBLISHED build cannot address yet is
 * downloadable and unusable, and it makes unrelated configs warn; the mark is
 * derived rather than written precisely so it clears itself at the next release
 * instead of becoming a sentence somebody must remember to delete.
 *
 * That derivation is a loop. The catalogue can only be computed once the tag
 * exists, and the tag must point at a commit that already holds the computed
 * catalogue — otherwise CI rebuilds a different one from the tag and `docs:check`
 * fails. Cutting 0.3.0 walked into it: the pre-push hook refused the tag, and the
 * rest was finished by hand. So: tag, rebuild under it, commit, move the tag onto
 * that commit. Moving a tag is only a normal thing to do because it has not been
 * pushed yet, which is why the push is last and why a failure deletes it.
 *
 * The branch and the tag go up TOGETHER. Pushed separately they left a 42-second
 * window in which the branch's own Documentation run checked out a repository
 * whose newest tag was still the old one, rebuilt the old catalogue, and failed on
 * it. `--atomic` is one ref update or none.
 *
 * publish.yml publishes all five registries from `v*`; the per-registry workflows
 * are manual-only, because when they also fired on their own tags the same Java
 * bundle went to Central twice.
 */
function tagAndPush(version) {
  const tag = `v${version}`;
  let committed = false;
  git('tag', '-a', tag, '-m', version);
  try {
    run('node', ['webdoc/scripts/build-pack-catalogue.mjs']);
    run('npm', ['--prefix', 'webdoc', 'run', 'docs:export']);

    if (git('status', '--porcelain') !== '') {
      git('add', '-A');
      git(
        'commit',
        '-m',
        `${CATALOGUE_COMMIT}${tag} settles`,
        '-m',
        'The docs catalogue marks a pack whose address the published build cannot ' +
          'resolve yet. The mark is derived from the newest v* tag, so this release ' +
          'clears it for everything added since the last one. Generated, not written.',
      );
      git('tag', '-f', '-a', tag, '-m', version);
      committed = true;
    }

    /*
     * Proof rather than hope. Rebuilt under the tag it now names, the catalogue
     * has to be exactly what was committed — which is the same question CI asks
     * when it builds from that tag, answered here where it is still cheap.
     */
    run('node', ['webdoc/scripts/build-pack-catalogue.mjs']);
    if (git('status', '--porcelain') !== '') {
      throw new Error(
        'the catalogue does not settle: rebuilt under its own tag it differs from ' +
          'the commit the tag points at',
      );
    }

    git('push', '--atomic', 'origin', 'main', tag);
  } catch (error) {
    /*
     * The tag goes, because a version number half-spent is worse than one not
     * spent at all. The COMMIT stays if there was one: it holds the regenerated
     * catalogue, deleting it would throw away work a hook may have touched, and
     * a commit sitting in the log is visible in a way a deleted one is not.
     */
    git('tag', '-d', tag);
    console.error(`\n${error.message}`);
    console.error(`\nthe tag was deleted — ${version} is not spent, and nothing was pushed.`);
    if (committed) {
      console.error('The catalogue commit was made and is still here; fix the cause and run again.');
    }
    console.error('');
    process.exit(1);
  }

  console.log(`\npushed main and ${tag} together — one tag, five registries.`);
  console.log('Watch: gh run list --limit 4\n');
}

// ── run ─────────────────────────────────────────────────────────────────────


const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
console.log(`\nreleasing over ${lastTag}\n`);

const version = versions();
if (version) {
  const section = changelogSection(version);
  packageChangelogs(version);
  if (section) await changelogCoversTheSurface(section, lastTag);
  treeIsReleasable(version);
  centralBudget();
}

if (problems.length > 0) {
  console.error('\nnot releasable:\n');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    '\nNothing was pushed. Every one of these is something 0.2.0 got wrong by hand.\n',
  );
  process.exit(1);
}

console.log(`\n${version} is releasable.`);
if (!push) {
  console.log('Run again with --tag to tag and push. Publishing is CI, from the tag.\n');
  process.exit(0);
}

heavyTestsPass();
tagAndPush(version);
