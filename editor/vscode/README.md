# TDC — VS Code extension (local install)

A small wrapper: it hooks up `.tdc` highlighting (the grammar from `../`) and
starts our language server (errors, completion, hover, navigation). It is **not**
published to the marketplace — install it by hand from this folder.

## Where it looks for the language server

Highlighting is contributed by the manifest and always works. Everything else —
completion, hover, diagnostics, go-to-definition — needs the server, and the
extension looks for it in this order:

1. `tdc.server.path`, if you have set it. Taken as given, with no fallback: if
   you name a path, a typo should fail loudly rather than quietly land you on a
   different server.
2. `node_modules/tdcv2/dist/lsp/server.js` in an open workspace folder. This is
   the ordinary case — a project that depends on `tdcv2` already carries it.
3. Anywhere Node can resolve `tdcv2` from the extension, which covers a global
   install.
4. `../../typescript/dist/lsp/server.js`, for working on TDC itself.

If none of those exists the extension says so once and stops, instead of
starting a client against a path that is not there. It used to check only the
fourth, so outside a clone of this repository it silently did nothing.

**The packs it completes** are the ones a run would use: the bundled packs, the
`dataPaths` from `tdcv2.config.json` and `~/.config/tdcv2/config.json`, and the
conventional `data/packs` and `packs` folders in the workspace. So a locale you
installed with `tdcv2 pack add` is offered in autocomplete, and installing one
while the editor is open takes effect without a restart.

## Step 0 — build the language server (once)

```bash
cd ../../typescript
npm install
npm run build          # produces typescript/dist/lsp/server.js
```

## Step 1 — build the extension

```bash
cd ../editor/vscode     # (this folder)
npm install             # installs vscode-languageclient + types; syncs the grammar
npm run build           # compiles out/extension.js
```

## Option A — just try it (Development Host)

Nothing gets installed anywhere:

1. Open the `editor/vscode` folder in VS Code.
2. Press **F5** (Run → Start Debugging). A second VS Code window opens with the
   extension already enabled.
3. In it, open any `.tdc` file — highlighting, red errors, completion
   (`Ctrl+Space`), hover and `Ctrl`+click to definition all work right away.

This is the best way to check it. The path to the server is filled in
automatically, because the extension sits in the repository next to
`typescript/`.

## Option B — install it for good (.vsix)

1. Build the `.vsix`:
   ```bash
   npx @vscode/vsce package     # → tdc-language-support-0.1.0.vsix
   ```
2. Install it: in VS Code open the Extensions panel → "…" menu → **Install from
   VSIX…** → pick the file. Or from a terminal:
   ```bash
   code --install-extension tdc-language-support-0.1.0.vsix
   ```
3. **Important:** installing from a `.vsix` copies the extension into
   `~/.vscode/extensions/`, so the relative path to the server is lost. Set it
   once in the VS Code settings: `Settings → "tdc.server.path"` → the absolute
   path to `.../tdcv2/typescript/dist/lsp/server.js`.

## Highlighting only, without the server

If all you want is colour and no errors or completion, either option above is
enough — the language server is optional, and the highlighting comes from the
grammar, which always works.
