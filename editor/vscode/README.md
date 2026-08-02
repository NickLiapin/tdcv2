# TDC — VS Code extension (local install)

A small wrapper: it hooks up `.tdc` highlighting (the grammar from `../`) and
starts our language server (errors, completion, hover, navigation). It is **not**
published to the marketplace — install it by hand from this folder.

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
   path to `.../tdc-v2/typescript/dist/lsp/server.js`.

## Highlighting only, without the server

If all you want is colour and no errors or completion, either option above is
enough — the language server is optional, and the highlighting comes from the
grammar, which always works.
