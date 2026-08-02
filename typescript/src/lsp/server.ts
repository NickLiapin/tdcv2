#!/usr/bin/env node
/**
 * TDC language server entry — the `tdcv2-lsp` bin.
 *
 * A thin loader whose only job is to turn a missing optional LSP dependency
 * into an actionable message instead of a raw ERR_MODULE_NOT_FOUND stack.
 * `vscode-languageserver` / `vscode-languageserver-textdocument` are OPTIONAL
 * peer dependencies: a plain `npm install tdcv2` (for data
 * generation) does NOT pull them in — they matter only when you run the LSP.
 * The real server lives in `server-impl.ts`, imported dynamically so its
 * top-level `vscode-languageserver` imports resolve here where we can catch.
 *
 * Launch (any LSP client points at this): `node dist/lsp/server.js --stdio`.
 */

async function main(): Promise<void> {
  try {
    await import('./server-impl.js');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes('vscode-languageserver')) {
      process.stderr.write(
        'tdcv2-lsp: the TDC language server needs its optional packages, which are not\n' +
          'installed by default. Install them to use the LSP:\n' +
          '  npm i vscode-languageserver vscode-languageserver-textdocument\n',
      );
      process.exit(1);
    }
    throw err;
  }
}

void main();
