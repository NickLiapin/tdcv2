/**
 * Where the language server is — the whole of the interesting logic in this
 * extension, kept apart from `extension.ts` so it can be exercised without a
 * running VS Code.
 *
 * The first version resolved `../../typescript/dist/lsp/server.js` relative to
 * the extension and nothing else, so the extension worked from a clone of the
 * repository and did nothing at all anywhere else — no diagnostics, no
 * completion, and no message saying why. `tdc.server.path` existed as an
 * escape hatch, but somebody who does not know the server exists cannot be
 * expected to point at it.
 *
 * So it is looked for where it actually tends to be, in order:
 *
 *   1. `tdc.server.path`, when somebody has said exactly where it is.
 *   2. The workspace's own `node_modules` — a project depending on `tdcv2`
 *      carries the server, which is the ordinary case for a team.
 *   3. Anywhere Node can resolve `tdcv2` from this extension.
 *   4. This repository, two levels up, for working on TDC itself.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** The compiled language server, or undefined when it is nowhere to be found. */
export function findServerModule(
  // Structural, not VS Code's type: this file must stay importable
  // without the editor, which is the point of it being a file of its own.
  context: { asAbsolutePath(relative: string): string },
  configuredPath: string | undefined,
  workspaceDirs: readonly string[],
): string | undefined {
  if (configuredPath !== undefined && configuredPath.length > 0) {
    // Taken as given. Somebody who sets an absolute path means it, and a
    // silent fallback would hide their typo behind a server that half works.
    return configuredPath;
  }

  const relative = path.join("tdcv2", "dist", "lsp", "server.js");
  for (const dir of workspaceDirs) {
    const candidate = path.join(dir, "node_modules", relative);
    if (existsSync(candidate)) return candidate;
  }

  try {
    // A globally or otherwise installed tdcv2: let Node answer where it is.
    const require = createRequire(__filename);
    return require.resolve("tdcv2/dist/lsp/server.js");
  } catch {
    // Not installed anywhere Node can see — fall through to the repo layout.
  }

  const inRepo = context.asAbsolutePath(
    path.join("..", "..", "typescript", "dist", "lsp", "server.js"),
  );
  return existsSync(inRepo) ? inRepo : undefined;
}
