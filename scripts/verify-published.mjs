#!/usr/bin/env node
/**
 * Install all five from the PUBLIC registries and run the same config in each.
 *
 * ── Why this file exists, next to `verify-artefacts.mjs` ─────────────────────
 *
 * Its sibling proves what `git archive HEAD` builds: it packs, installs and runs
 * the artefacts, and it is the gate before a tag. This one asks the other half of
 * the question — **what the registries actually serve** — and it can only be asked
 * after publishing, because until then there is nothing there to install.
 *
 * The two are not the same question. Between them sit the publish workflow, five
 * uploads, and whatever each registry does to a package on the way in. Until this
 * file, nothing in the repository ever downloaded a published TDC and ran it: the
 * gap between "it builds here" and "it works for a stranger" was closed by hope.
 *
 * ── What it runs ─────────────────────────────────────────────────────────────
 *
 * The config is the one the installation page hands a newcomer, copied verbatim,
 * and the commands are the ones that page names. Three rows from one seed — small
 * enough to read, and enough to prove the whole path: the parser, the generators,
 * the interpolation, the starter packs being present at all.
 *
 * The verdict that matters is not that five commands exited 0. It is that all five
 * printed the SAME BYTES. One seed and one engine produce one output whatever
 * language read the config, and five packages built five ways and delivered by five
 * registries either still agree or the release is not what it claims to be.
 *
 * `--version` is checked too, because 0.1.4 shipped a Java and a C# that answered
 * `0.1.0` — built correctly, labelled wrongly, and nothing looked.
 *
 * ── It cleans up after itself ────────────────────────────────────────────────
 *
 * Everything lands in one temporary directory — the npm project, the virtualenv,
 * the jar, `--tool-path` for the dotnet tool, `--root` for the cargo install — and
 * that directory is removed on the way out, whatever the verdict. Nothing is
 * installed globally and nothing is left behind. `--keep` holds on to it when a
 * failure needs reading.
 *
 * Cargo's download cache under `~/.cargo` is shared and is left alone; it is a
 * cache, not something this script created.
 *
 *   node scripts/verify-published.mjs             # the version in this working tree
 *   node scripts/verify-published.mjs 0.3.1       # a particular one
 *   node scripts/verify-published.mjs --only npm,pypi
 *   node scripts/verify-published.mjs --keep      # leave the directory to read
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The config `getting-started/installation` hands a newcomer, verbatim. */
const DEMO = `<tdc>
    <env count="3" seed="demo">
        <sequence name="Name">
            <gen type="text" value="Alice,Bob,Carol,David,Emma"/>
        </sequence>
        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line>
            <data>\${{Name}}, age \${{Age}}</data>
        </line>
    </block>
</tdc>
`;

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") ? new Set(onlyArg.split(",")) : null;
const version =
  args.find((a) => /^\d+\.\d+\.\d+/.test(a)) ??
  /"version":\s*"([^"]+)"/.exec(
    readFileSync(join(ROOT, "typescript/package.json"), "utf8"),
  )[1];

const run = (cmd, argv, opts = {}) =>
  spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });

/**
 * One per registry: install into `dir`, then answer with the command that runs it.
 *
 * Every install is confined to `dir`. `cargo install --root` and `dotnet tool
 * install --tool-path` are what keep those two out of the user's home, and they
 * are the reason this can be run on a laptop without leaving anything behind.
 */
const REGISTRIES = [
  {
    id: "npm",
    label: "npm",
    how: `npm i tdcv2@${version}`,
    install(dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"smoke","private":true}\n',
      );
      const r = run(
        "npm",
        ["i", "--no-audit", "--no-fund", `tdcv2@${version}`],
        { cwd: dir },
      );
      return r.status === 0 ? [join(dir, "node_modules/.bin/tdcv2"), []] : r;
    },
  },
  {
    id: "pypi",
    label: "PyPI",
    how: `pip install tdcv2==${version}`,
    install(dir) {
      const made = run("python3", ["-m", "venv", dir]);
      if (made.status !== 0) return made;
      const r = run(join(dir, "bin/pip"), [
        "install",
        "-q",
        `tdcv2==${version}`,
      ]);
      return r.status === 0 ? [join(dir, "bin/tdcv2"), []] : r;
    },
  },
  {
    id: "maven",
    label: "Maven Central",
    how: `tdcv2-${version}-cli.jar from repo1`,
    install(dir) {
      mkdirSync(dir, { recursive: true });
      const jar = join(dir, "tdcv2-cli.jar");
      const url = `https://repo1.maven.org/maven2/io/github/nickliapin/tdcv2/${version}/tdcv2-${version}-cli.jar`;
      const r = run("curl", ["-sSfL", "--max-time", "180", "-o", jar, url]);
      return r.status === 0 ? ["java", ["-jar", jar]] : r;
    },
  },
  {
    id: "nuget",
    label: "NuGet",
    how: `dotnet tool install Tdcv2.Cli --version ${version}`,
    install(dir) {
      const r = run("dotnet", [
        "tool",
        "install",
        "--tool-path",
        dir,
        "Tdcv2.Cli",
        "--version",
        version,
      ]);
      return r.status === 0 ? [join(dir, "tdcv2"), []] : r;
    },
  },
  {
    id: "crates",
    label: "crates.io",
    // Builds from source, so this is the slow one — minutes, not seconds.
    how: `cargo install tdcv2 --version ${version}`,
    install(dir) {
      const r = run("cargo", [
        "install",
        "tdcv2",
        "--version",
        version,
        "--root",
        dir,
        "--quiet",
      ]);
      return r.status === 0 ? [join(dir, "bin/tdcv2"), []] : r;
    },
  },
];

const sha = (text) => createHash("sha256").update(text).digest("hex");
const short = (text) => text.split("\n")[0].trim().slice(0, 160);

const work = mkdtempSync(join(tmpdir(), "tdcv2-published-"));
const results = [];

try {
  const config = join(work, "demo.tdc");
  writeFileSync(config, DEMO);
  console.log(`verifying what the registries serve for ${version}`);
  console.log(`  working in ${work}\n`);

  for (const reg of REGISTRIES) {
    if (only && !only.has(reg.id)) continue;
    process.stdout.write(`── ${reg.label} — ${reg.how}\n`);

    const installed = reg.install(join(work, reg.id));
    if (!Array.isArray(installed)) {
      const why = short(
        installed.stderr || installed.stdout || `exit ${installed.status}`,
      );
      console.log(`   could not install: ${why}`);
      results.push({ id: reg.id, ok: false, why: `install failed — ${why}` });
      continue;
    }

    const [cmd, prefix] = installed;
    const ran = run(cmd, [...prefix, config]);
    const said = run(cmd, [...prefix, "--version"]);
    if (ran.status !== 0) {
      const why = short(ran.stderr || ran.stdout || `exit ${ran.status}`);
      console.log(`   installed, but did not run: ${why}`);
      results.push({ id: reg.id, ok: false, why: `run failed — ${why}` });
      continue;
    }

    const reported = short(said.stdout || said.stderr);
    console.log(`   ran, and calls itself: ${reported}`);
    results.push({
      id: reg.id,
      ok: true,
      out: ran.stdout,
      digest: sha(ran.stdout),
      reported,
      saysVersion: reported.includes(version),
    });
  }
} finally {
  if (keep) {
    console.log(`\n--keep: left ${work} in place`);
  } else {
    rmSync(work, { recursive: true, force: true });
    console.log(`\ncleaned up — ${work} removed, nothing installed outside it`);
  }
}

// ── the verdict ──────────────────────────────────────────────────────────────

const ran = results.filter((r) => r.ok);
const broken = results.filter((r) => !r.ok);
const digests = new Set(ran.map((r) => r.digest));
const mislabelled = ran.filter((r) => !r.saysVersion);

console.log("\n  registry        bytes              --version");
for (const r of results) {
  const line = r.ok
    ? `${r.digest.slice(0, 16)}   ${r.reported}${r.saysVersion ? "" : "   ← not " + version}`
    : r.why;
  console.log(`  ${r.id.padEnd(15)} ${line}`);
}

if (ran.length > 0) {
  console.log(
    digests.size === 1
      ? `\n  all ${String(ran.length)} printed the same bytes:\n` +
          ran[0].out
            .trimEnd()
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n")
      : `\n  ${String(digests.size)} DIFFERENT outputs — one seed must give one answer`,
  );
}

const failed = broken.length > 0 || digests.size > 1 || mislabelled.length > 0;
console.log(
  failed
    ? `\n${version} is NOT what the registries claim.`
    : `\n${version} installs and runs from every registry, and they agree.`,
);
process.exit(failed ? 1 : 0);
