/**
 * Put the released version into the pages at build time, so no page carries it.
 *
 * The install pages tell people exactly what to type: a Maven coordinate, a
 * Gradle line, a `curl` for a jar whose filename contains the number, a table of
 * five registries. Every one of those used to be a literal, and every one of them
 * drifted — at 0.1.6 the README said 0.1.3, the intro said 0.1.4, and the curl
 * pointed at a jar that returns 404. With five packages there is no version of
 * "remember to update them all" that survives a release.
 *
 * So the sources carry a token and the build substitutes it. There is one number,
 * it lives in `typescript/package.json` beside the code it describes, and a page
 * cannot disagree with it because a page never states it.
 *
 *   version %%TDC_VERSION%%          →  version 0.1.6
 *   <version>%%TDC_VERSION%%</version>
 *
 * A remark plugin rather than a React component, and that is the whole reason it
 * exists: half the mentions are inside fenced code blocks — XML, Gradle, a shell
 * command — where a component cannot go. remark sees the code block's text, so
 * one rule covers prose, inline code and fences alike.
 *
 * The markdown export does the same substitution on its way out
 * (`scripts/export-markdown.mjs`), so the copy GitHub renders carries the real
 * number too. Both read this file's `VERSION`; there is no second definition.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The one number. The packages declare it; nothing else may. */
export const VERSION = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'typescript', 'package.json'), 'utf8'),
).version;

export const TOKEN = '%%TDC_VERSION%%';

/** Every node kind whose value a reader can end up copying. */
const CARRIES_TEXT = ['text', 'code', 'inlineCode', 'html', 'yaml'];

export default function remarkVersion() {
  return (tree) => {
    for (const type of CARRIES_TEXT) {
      visit(tree, type, (node) => {
        if (typeof node.value === 'string' && node.value.includes(TOKEN)) {
          node.value = node.value.split(TOKEN).join(VERSION);
        }
      });
    }
    // A token inside a JSX attribute — `<Terminal title="tdcv2 %%TDC_VERSION%%">`
    // — is not a text node, so it is reached through the attribute values.
    //
    // Guarded by Array.isArray, not by `?? []`: an admonition (`:::note`) is a
    // containerDirective whose `attributes` is a plain object map, and spreading
    // that threw "object is not iterable" on every page carrying one.
    visit(tree, (node) => {
      if (!Array.isArray(node.attributes)) return;
      for (const attr of node.attributes) {
        if (typeof attr.value === 'string' && attr.value.includes(TOKEN)) {
          attr.value = attr.value.split(TOKEN).join(VERSION);
        }
      }
    });
  };
}
