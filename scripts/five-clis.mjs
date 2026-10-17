/**
 * The five command lines, built from this checkout — shared by the scripts that drive all five.
 *
 * Moved out of `audit-doc-examples-five-ways.mjs` when the scenario check needed the same table
 * and the same refusal to run against a missing or stale build.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./doc-examples.mjs";

/**
 * How each implementation is invoked, and the artefact whose absence means it
 * was never built. A missing build is a hard error: "four of five agreed and the
 * fifth never ran" is precisely the result this audit exists to not produce.
 */
export const IMPLEMENTATIONS = [
  {
    id: "typescript",
    label: "TypeScript (reference)",
    artefact: "typescript/dist/cli/main.js",
    sources: "typescript/src",
    command: [process.execPath, [join(REPO, "typescript/dist/cli/main.js")]],
    build: "npm --prefix typescript run build",
  },
  {
    id: "python",
    label: "Python",
    artefact: "python/.venv/bin/tdcv2",
    sources: "python/src",
    command: [join(REPO, "python/.venv/bin/tdcv2"), []],
    build:
      'python3 -m venv python/.venv && python/.venv/bin/pip install -e "python[dev]"',
  },
  {
    id: "rust",
    label: "Rust",
    artefact: "rust/target/release/tdcv2",
    sources: "rust/src",
    command: [join(REPO, "rust/target/release/tdcv2"), []],
    build: "cargo build --release --manifest-path rust/Cargo.toml",
  },
  {
    id: "csharp",
    label: "C#",
    artefact: "csharp/Tdcv2.Cli.Tool/bin/Release/net6.0/Tdcv2.Cli.dll",
    sources: "csharp/Tdcv2",
    // The engine lives in a DIFFERENT assembly from the command line that loads it, so the
    // freshness question has to be asked of the engine's own copy. `Tdcv2.Cli.dll` is built
    // from `Tdcv2.Cli.Tool/`, which an engine edit never touches: it kept its old mtime while
    // the engine beside it was rebuilt, and the audit read that as a stale build and refused
    // to run. Measured 2026-08-25: Tdcv2.Cli.dll 13:59, Tdcv2.dll 14:32, the edit 14:31 —
    // the CLI was running the new code and being called stale for it.
    freshness: "csharp/Tdcv2.Cli.Tool/bin/Release/net6.0/Tdcv2.dll",
    command: [
      "dotnet",
      [join(REPO, "csharp/Tdcv2.Cli.Tool/bin/Release/net6.0/Tdcv2.Cli.dll")],
    ],
    build: "dotnet build csharp/Tdcv2.Cli.Tool -c Release",
  },
  {
    id: "java",
    label: "Java",
    // The jar carries the version in its name, so naming one pins the audit to a release
    // that will stop existing at the next bump. Found by the file itself instead.
    artefact: javaCliJar(),
    sources: "java/src/main",
    command: ["java", ["-jar", join(REPO, javaCliJar() ?? "")]],
    build: "cd java && ./gradlew cliJar",
  },
];

/**
 * The CLI jar for the version this tree declares.
 *
 * It used to be "whatever `-cli.jar` readdir hands back first", which is
 * alphabetical, so a jar left behind by an earlier release WON. That is how this
 * audit came to report six port disagreements on a fixed engine: `build/libs`
 * held 0.1.5, 0.1.6 and 0.1.7 side by side, and Java was judged on a jar built
 * the day before the fix. The report said the ports disagreed. They agreed; the
 * harness was reading the wrong file.
 *
 * So: the version decides, and a missing jar says so by name instead of quietly
 * running an old one.
 */
function javaCliJar() {
  const version = JSON.parse(
    readFileSync(join(REPO, "typescript/package.json"), "utf8"),
  ).version;
  return `java/build/libs/tdcv2-${version}-cli.jar`;
}

/**
 * The implementations asked for, each one built from THIS checkout and no older than its own
 * sources — or a message naming the build to run, and exit 2. A missing or stale build reads as a
 * disagreement between implementations, which is the one result a five-way check must not invent.
 */
export function chosenImplementations(only) {
  const chosen = IMPLEMENTATIONS.filter((i) => !only || only.has(i.id));
  const missing = chosen.filter(
    (i) =>
      !i.artefact ||
      !existsSync(join(REPO, i.artefact)) ||
      (i.freshness && !existsSync(join(REPO, i.freshness))),
  );
  if (missing.length > 0) {
    console.error(
      "These implementations are not built, so the audit would be a lie:\n",
    );
    for (const i of missing) console.error(`  ${i.label}\n    ${i.build}\n`);
    process.exit(2);
  }

  /**
   * Directories that live among the sources but are OUTPUT, and so must not be read as
   * sources: a build writes into them, which would make every project permanently newer
   * than its own build. `csharp/Tdcv2/obj/` did exactly that — `dotnet test` builds Debug,
   * Debug writes `obj/Debug/net6.0/refint/Tdcv2.dll`, and from then on the audit reported
   * the Release build as stale no matter how recently it was made. Running the tests
   * disabled the audit.
   */
  const OUTPUT_DIRS = new Set([
    "bin",
    "obj",
    "target",
    "dist",
    "build",
    "node_modules",
    "__pycache__",
    ".venv",
  ]);

  /** The newest mtime anywhere under a directory, build output excluded. */
  function newestUnder(dir) {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (OUTPUT_DIRS.has(entry.name)) continue;
        newest = Math.max(newest, newestUnder(path));
      } else if (entry.isFile()) {
        newest = Math.max(newest, statSync(path).mtimeMs);
      }
    }
    return newest;
  }

  // A build that EXISTS is not the same as a build that is CURRENT, and the second
  // mistake is the more expensive one: a stale binary reports as a disagreement
  // between implementations, which reads as a defect in the code rather than in the
  // build. That is exactly what happened while preparing 0.2.1 — the Rust release
  // binary was a day old, and this audit blamed the engine for a bug that had been
  // fixed hours earlier.
  //
  // One implementation is exempt, and not as a favour: an EDITABLE Python install
  // (`pip install -e`) puts a console script in the venv that imports the sources
  // where they lie, so it runs the current code the moment the code changes — and
  // its own mtime never moves again. Comparing the two therefore refuses forever
  // after the first edit, which is why this audit sat unrunnable rather than
  // unrun: reinstalling silenced it until the next keystroke. Measured on
  // 2026-08-25: script 3 August, source 25 August, `__editable__.tdcv2-0.1.5.pth`
  // in site-packages, and the CLI answering with the day's work in it.
  const editable = (i) =>
    i.id === "python" &&
    existsSync(join(REPO, i.artefact)) &&
    readdirSync(join(REPO, "python/.venv/lib")).some(
      (v) =>
        existsSync(join(REPO, "python/.venv/lib", v, "site-packages")) &&
        readdirSync(join(REPO, "python/.venv/lib", v, "site-packages")).some(
          (f) => f.startsWith("__editable__") && f.includes("tdcv2"),
        ),
    );

  const stale = chosen.filter(
    (i) =>
      i.sources &&
      !editable(i) &&
      newestUnder(join(REPO, i.sources)) >
        statSync(join(REPO, i.freshness ?? i.artefact)).mtimeMs,
  );
  if (stale.length > 0) {
    console.error(
      "These builds are older than their own sources, so the audit would be a lie:\n",
    );
    for (const i of stale) console.error(`  ${i.label}\n    ${i.build}\n`);
    process.exit(2);
  }
  return chosen;
}
