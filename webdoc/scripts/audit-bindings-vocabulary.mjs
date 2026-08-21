/**
 * The bindings page's table IS `fixtures/cross-language/api.json`, cell for cell.
 *
 * The five test suites enforce that table in code. This asks the same question of the
 * DOCUMENTATION, because the failure that made the table necessary was a documented
 * promise the code did not keep: the Python page said the TypeScript API "is there under
 * snake_case names" when `to_string`, `to_array`, `get_at` and `iterate` were not, and
 * the Java page said the names mirrored the reference when `toArray` was missing. Both
 * sentences read perfectly well and were false.
 *
 * A page that gestures at another page cannot be checked. A page carrying the table can,
 * and this compares the cells rather than hunting for names in prose — a page can hold a
 * name in a sentence and still get the table wrong.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const API = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'cross-language', 'api.json'), 'utf8'));
const PAGE = join(ROOT, 'webdoc', 'docs', 'bindings', 'same-names.mdx');
const LANGUAGES = ['typescript', 'python', 'java', 'csharp', 'rust'];

const text = readFileSync(PAGE, 'utf8');
const problems = [];

/**
 * Rows of a markdown table, as trimmed cell arrays, skipping the header and its rule.
 *
 * The header is found by its FIRST CELL rather than by a line prefix: prettier pads every
 * cell to the column width when it formats the page, and a prefix match silently found no
 * table at all — a check that passes by looking at nothing, which is the failure this file
 * exists to prevent.
 */
function tableRows(source, firstHeaderCell) {
  const lines = source.split('\n');
  const start = lines.findIndex(
    (l) => l.startsWith('|') && l.split('|')[1]?.trim() === firstHeaderCell,
  );
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows.push(
      lines[i]
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

const shared = tableRows(text, 'What it gives you');
if (shared === null) {
  problems.push('same-names.mdx has no shared-vocabulary table');
} else if (shared.length !== API.members.length) {
  problems.push(
    `the table has ${shared.length} rows, api.json has ${API.members.length} members`,
  );
} else {
  API.members.forEach((member, index) => {
    const row = shared[index];
    LANGUAGES.forEach((language, column) => {
      const name = member[language];
      if (name === undefined) {
        problems.push(`api.json: "${member.concept}" has no ${language} spelling`);
        return;
      }
      // `getAt(i)` in the table, `getAt` in the fixture: the call shape is the page's,
      // the NAME is the contract.
      const cell = row[column + 1] ?? '';
      const written = /^`([A-Za-z_][A-Za-z_0-9]*)\(/.exec(cell)?.[1];
      if (written !== name) {
        problems.push(
          `row ${index + 1} (${member.concept}), ${language}: page says ${cell || '(nothing)'}, api.json says \`${name}()\``,
        );
      }
    });
  });
}

// The second table lists each package's own older spellings. Every one has to come out of
// the fixture too, or the page could promise an alias nothing keeps alive.
const alsoDeclared = new Set();
for (const member of API.members) {
  for (const [language, spelling] of Object.entries(member.also ?? {})) {
    alsoDeclared.add(`${language}:${spelling}`);
  }
}
const LABEL = { TypeScript: 'typescript', Python: 'python', Java: 'java', 'C#': 'csharp', Rust: 'rust' };
const also = tableRows(text, 'Also valid') ?? [];
for (const [spelling, where] of also) {
  const language = LABEL[where];
  if (language === undefined) {
    problems.push(`"Also valid" names an unknown implementation: ${where}`);
    continue;
  }
  const bare = spelling.replace(/^`|`$/g, '');
  if (!alsoDeclared.has(`${language}:${bare}`)) {
    problems.push(`"Also valid" claims ${where} keeps "${bare}", which api.json does not record`);
  }
}
for (const entry of alsoDeclared) {
  const [language, spelling] = entry.split(/:(.*)/s);
  const where = Object.keys(LABEL).find((k) => LABEL[k] === language);
  if (!also.some(([s, w]) => s.replace(/^`|`$/g, '') === spelling && w === where)) {
    problems.push(`api.json records ${where}'s "${spelling}", which the page does not list`);
  }
}

if (problems.length > 0) {
  console.error('bindings vocabulary:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(
  `bindings vocabulary: ${API.members.length} members × ${LANGUAGES.length} languages and ` +
    `${alsoDeclared.size} kept spellings — the page and api.json agree cell for cell`,
);
