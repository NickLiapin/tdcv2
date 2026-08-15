#!/usr/bin/env node
/**
 * Prove the WHEEL, from a clean clone, the way PyPI hands it to a stranger.
 *
 * 0.1.7, 0.2.0 and 0.2.1 all shipped a wheel that cannot be imported:
 *
 *   >>> import tdcv2
 *   ModuleNotFoundError: No module named 'tdcv2.parser.generated'
 *
 * Three releases over ten days, and nothing in this repository noticed, because
 * nothing here had ever installed a built wheel. The tests run against the
 * working tree, where two directories exist that a clean clone does not carry:
 *
 *   src/tdcv2/parser/generated/   the ANTLR parser, ignored repository-wide
 *   src/tdcv2/packs_data/         the starter packs, ignored by python/.gitignore
 *
 * Both are produced by scripts. The publish job checked out clean and ran
 * `python -m build` straight away, so the wheel carried neither: no parser, so
 * no import at all, and no packs, so `type="template"` would have had nothing to
 * draw from even if it had imported. That second half is the Rust 0.1.5 bug
 * again, in another language — see the header of `scripts/verify-artefacts.mjs`.
 *
 * So this check does what the publish job does, in the order it does it, and
 * then uses the result:
 *
 *   1. `git archive HEAD` into a temporary directory — TRACKED FILES ONLY.
 *      Building from the working tree is what hid this for ten days: the two
 *      directories are sitting right there on a developer's disk.
 *   2. The recipe: generate the parser, install the runtime, bundle the packs.
 *   3. `python -m build --wheel`.
 *   4. A fresh virtualenv, `pip install <the wheel>` — not `-e`, not the source.
 *   5. Import it, and generate from a pack address, which is the one thing that
 *      needs both halves to be present.
 *
 *   node python/scripts/verify-wheel.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The names the run must produce — the same three every other implementation gives. */
const EXPECTED = "Williams Smith Johnson";

const CONFIG =
  '<tdc><env count="3" seed="s" local="en"><sequence name="V">' +
  '<gen type="template" value="person.lastName"/></sequence></env>' +
  "<block><line><data>${{V}}</data></line></block></tdc>";

function run(command, args, cwd, label) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    throw new Error(`${label} failed:\n${out}`);
  }
  return (r.stdout ?? "").trim();
}

const work = mkdtempSync(join(tmpdir(), "tdc-wheel-"));
let ok = false;
try {
  console.log("  clean clone       git archive HEAD");
  execFileSync(
    "sh",
    ["-c", `git archive HEAD | tar -x -C ${JSON.stringify(work)}`],
    { cwd: ROOT },
  );

  const py = join(work, "python");
  // Exactly what the publish job must do, in order. A step missing here is a
  // step missing there.
  console.log("  parser            generate-parsers --only python");
  run(
    "node",
    ["scripts/generate-parsers.mjs", "--only", "python"],
    work,
    "parser generation",
  );

  console.log("  build venv        python3 -m venv");
  run("python3", ["-m", "venv", ".venv"], py, "venv");
  const pip = join(py, ".venv", "bin", "pip");
  const python = join(py, ".venv", "bin", "python");

  console.log("  runtime + build   pip install");
  run(
    pip,
    ["install", "--quiet", "--upgrade", "pip", "setuptools", "wheel", "build"],
    py,
    "pip",
  );
  // The runtime only, not the project: `pip install .` would build a wheel from
  // the very tree whose completeness is the thing under test. `bundle_packs.py`
  // puts `src` on `sys.path` itself and needs nothing else.
  run(
    pip,
    ["install", "--quiet", "antlr4-python3-runtime==4.13.2"],
    py,
    "antlr runtime",
  );

  console.log("  starter packs     bundle_packs.py");
  run(python, ["scripts/bundle_packs.py"], py, "bundle_packs");

  console.log("  wheel             python -m build --wheel");
  run(
    python,
    ["-m", "build", "--wheel", "--no-isolation", "-o", "dist"],
    py,
    "build",
  );

  const wheels = readdirSync(join(py, "dist")).filter((f) =>
    f.endsWith(".whl"),
  );
  if (wheels.length !== 1)
    throw new Error(`expected one wheel, found ${wheels.length}`);
  const wheel = join(py, "dist", wheels[0]);
  console.log(`  built             ${wheels[0]}`);

  // A separate environment, so nothing the build needed can stand in for what
  // the wheel forgot to carry.
  console.log("  install           pip install <wheel> into a fresh venv");
  const probe = join(work, "probe");
  run("python3", ["-m", "venv", probe], work, "probe venv");
  run(
    join(probe, "bin", "pip"),
    ["install", "--quiet", wheel],
    work,
    "install the wheel",
  );

  const site = execFileSync(
    join(probe, "bin", "python"),
    ["-c", "import tdcv2, os; print(os.path.dirname(tdcv2.__file__))"],
    { encoding: "utf8" },
  ).trim();
  console.log("  import            ok");

  for (const [what, path] of [
    ["the ANTLR parser", join(site, "parser", "generated", "TDCLexer.py")],
    ["the starter packs", join(site, "packs_data")],
  ]) {
    if (!existsSync(path))
      throw new Error(`the wheel does not carry ${what}: ${path}`);
  }
  console.log("  contents          parser and starter packs present");

  const cfg = join(work, "probe.tdc");
  writeFileSync(cfg, CONFIG);
  const printed = execFileSync(join(probe, "bin", "tdcv2"), [cfg], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .join(" ");
  if (printed !== EXPECTED) {
    throw new Error(
      `the CLI printed ${JSON.stringify(printed)}, expected ${JSON.stringify(EXPECTED)}`,
    );
  }
  console.log(`  generates         ${printed}`);
  ok = true;
} catch (e) {
  console.error(`\n  ${e.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
