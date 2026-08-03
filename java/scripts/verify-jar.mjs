#!/usr/bin/env node
/**
 * Use the jar the way a stranger receives it, and run one.
 *
 * Every test in this repository runs INSIDE the repository, where `data/packs`
 * is a few directories up. Java does not read it from there — the Gradle build
 * copies the starter set into the jar as classpath resources — so this
 * implementation is the one of the five that was already correct. That is
 * exactly why the check is worth having: nothing in the suite would notice if a
 * build change stopped packing the resources, and the failure would reach a user
 * before it reached us. The Rust crate and the NuGet package both shipped
 * dataless for precisely that reason.
 *
 * So this builds the LIBRARY jar (not the self-contained CLI one, which could
 * hide the problem), compiles a program against it in a directory outside the
 * repository, runs it with only the jar and the ANTLR runtime on the classpath,
 * and compares the output against the TypeScript reference.
 *
 *   node scripts/verify-jar.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(projectDir, '..');

/** Three packs, three shapes: a plain list, a check-digited id, a composed one. */
const CONFIG =
  '<tdc><env count="3" seed="jar-check" local="en">' +
  '<sequence name="Name"><gen type="template" value="person.lastName"/></sequence>' +
  '<sequence name="Ssn"><gen type="template" value="usa.docs.ssn"/></sequence>' +
  '<sequence name="Iban"><gen type="template" value="common.finance.iban"/></sequence></env>' +
  '<block><line><data>${{Name}} | ${{Ssn}} | ${{Iban}}</data></line></block></tdc>';

const PROGRAM = `import io.github.nickliapin.tdc.TDC;

public class Check {
  public static void main(String[] args) {
    System.out.print(TDC.options().configString(${JSON.stringify(CONFIG)}).build());
  }
}
`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

/** The ANTLR runtime Gradle already downloaded — the jar's one dependency. */
function antlrRuntime() {
  const cache = join(homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', 'org.antlr', 'antlr4-runtime');
  if (!existsSync(cache)) {
    throw new Error(`no ANTLR runtime in ${cache}; run ./gradlew build first`);
  }
  for (const version of readdirSync(cache)) {
    for (const hash of readdirSync(join(cache, version))) {
      const jar = readdirSync(join(cache, version, hash)).find(
        // Not the -sources one: it has no classes, and picking it produces a
        // NoClassDefFoundError that looks like a missing dependency.
        (f) => f.endsWith('.jar') && !f.includes('-sources') && !f.includes('-javadoc'),
      );
      if (jar) {
        return join(cache, version, hash, jar);
      }
    }
  }
  throw new Error('no ANTLR runtime jar found');
}

const work = mkdtempSync(join(tmpdir(), 'tdcv2-jar-'));

try {
  console.log('building the library jar…');
  run('./gradlew', ['jar', '-q'], { cwd: projectDir });

  const libs = join(projectDir, 'build', 'libs');
  // The plain library jar of the DECLARED version. Naming what to exclude instead
  // is how this once picked up the javadoc archive after a publish left one lying
  // here, and reported the library as dataless — and matching any version is how
  // its sibling check for the Rust crate went on verifying yesterday's artefact
  // through a release. This directory keeps everything ever built in it, so the
  // only safe selection is by exact name.
  const declared = /^version\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(projectDir, 'build.gradle.kts'), 'utf8'),
  )?.[1];
  if (!declared) {
    throw new Error('could not read the version from java/build.gradle.kts');
  }
  const jar = `tdcv2-${declared}.jar`;
  if (!existsSync(join(libs, jar))) {
    throw new Error(`no ${jar} in ${libs}`);
  }

  const packs = run('unzip', ['-l', join(libs, jar)])
    .split('\n')
    .filter((l) => / tdc\/packs\/.*\.txt$/.test(l)).length;
  if (packs === 0) {
    console.error(`${jar} carries no pack resources — the build stopped embedding them.`);
    process.exit(1);
  }
  console.log(`${jar} carries ${String(packs)} pack files; compiling against it in ${work}`);

  const classpath = [join(libs, jar), antlrRuntime()].join(':');
  writeFileSync(join(work, 'Check.java'), PROGRAM);
  run('javac', ['-cp', classpath, '-d', work, join(work, 'Check.java')]);

  const fromJar = run('java', ['-cp', `${classpath}:${work}`, 'Check']).trimEnd();

  const configFile = join(work, 'check.tdc');
  writeFileSync(configFile, CONFIG);
  const fromReference = run('node', [
    join(repo, 'typescript', 'dist', 'cli', 'main.js'),
    configFile,
  ]).trimEnd();

  if (fromJar !== fromReference) {
    console.error('the jar does not agree with the reference.\n');
    console.error(`jar:\n${fromJar}\nreference:\n${fromReference}`);
    process.exit(1);
  }

  console.log(
    `the library jar runs outside the repository and matches the reference (${String(fromJar.split('\n').length)} rows)`,
  );

  // The second artefact under the same coordinates: the command line. It ships as a
  // file people download rather than a dependency they declare, because Maven puts
  // nothing on a PATH — so it is self-contained, and `java -jar` has to be enough.
  // Checked here for the same reason as the library: nothing else in the suite runs
  // it from outside the repository, where its data has to come from inside itself.
  console.log('building the cli jar…');
  run('./gradlew', ['cliJar', '-q'], { cwd: projectDir });

  const cli = `tdcv2-${declared}-cli.jar`;
  if (!existsSync(join(libs, cli))) {
    throw new Error(`no ${cli} in ${libs}`);
  }

  // Only the jar on the command line — no classpath, no ANTLR runtime. If the merge
  // dropped a dependency, this is where it shows.
  const fromCli = run('java', ['-jar', join(libs, cli), configFile]).trimEnd();

  if (fromCli !== fromReference) {
    console.error('the cli jar does not agree with the reference.\n');
    console.error(`cli:\n${fromCli}\nreference:\n${fromReference}`);
    process.exit(1);
  }

  console.log(`${cli} runs outside the repository with nothing beside it and matches the reference`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
