/**
 * The TypeScript runner: config in, file out, nothing else.
 *
 * Deliberately NOT the CLI. The CLI spreads a run across worker processes, and neither of the
 * other two implementations has that — timing it against them would measure a feature rather
 * than a language. This calls the library the same way the Java and Python runners do: one
 * thread, one process, `writeFile`.
 *
 *   node run.mjs <config> <output>
 */
import { TDC } from '../../typescript/dist/index.js';

const [config, output] = process.argv.slice(2);
new TDC({ configFile: config, now: 1776945600000 }).writeFile(output);
