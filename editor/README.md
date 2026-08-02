# Editor support for `.tdc`

Everything that makes TDC files comfortable to write in **any** editor, without a
separate plugin per IDE.

Two pieces, both "written once, works everywhere":

| File                                   | What it gives you                                                     | Who understands it                                      |
| -------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| `tdc.tmLanguage.json`                  | **Syntax highlighting** — tags, attributes, strings, `${{…}}`         | A TextMate grammar: IntelliJ, VS Code, Sublime, GitHub… |
| `../typescript/src/lsp/` → `tdcv2-lsp` | **Language server (LSP):** live errors, completion, hover, navigation | Any editor that speaks LSP                              |
| `language-configuration.json`          | Bracket and quote auto-closing, commenting                            | Editors that read it (VS Code and friends)              |

What works today, in full:

- **Syntax highlighting.**
- **Live error checking** — red underlines as you type, with the exact position
  and a "did you mean…" suggestion.
- **Completion** — tags, attributes and values: generator types, pack addresses
  (`person.es.…`, with descriptions), sequence names for `parent=`.
- **Hover** — a short description on a tag or attribute; on `${{Name}}`, which
  sequence it is and whether it is declared.
- **Go to definition** — Ctrl+click on `${{Name}}` or `parent="Name"` jumps to
  `<sequence name="Name">`.
- **Find all references** and **rename** a sequence across the whole file.

## Build the server

```bash
cd typescript
npm install
npm run build
```

After that the server starts with:

```bash
node <path-to-repository>/typescript/dist/lsp/server.js --stdio
```

(or just `tdcv2-lsp --stdio` if the package is installed or linked).

## IntelliJ IDEA (and other JetBrains IDEs)

**Highlighting** — no server needed, works immediately:

1. Settings → Editor → **TextMate Bundles** → "+" → point it at the `editor/`
   folder.
2. Settings → Editor → File Types → check that `*.tdc` is associated.

**Live errors (LSP):**

1. Install the free **LSP4IJ** plugin (Red Hat) from the Marketplace.
2. LSP4IJ → New Language Server:
   - Name: `TDC`
   - Command: `node /absolute/path/typescript/dist/lsp/server.js --stdio`
   - File name patterns: `*.tdc`, language id `tdc`.
3. Open a `.tdc` file — errors are underlined as you type.

## VS Code

A ready-made wrapper extension lives in
**[`editor/vscode/`](./vscode/README.md)** and wires up both the highlighting and
the server. It installs **locally, without the marketplace**. In short:

```bash
cd ../typescript && npm install && npm run build    # build the server (once)
cd ../editor/vscode && npm install && npm run build # build the extension
```

From there, two ways (the details are in [vscode/README.md](./vscode/README.md)):

- **Try it:** open the `editor/vscode` folder in VS Code and press **F5** — in
  the second window, open a `.tdc` file and everything works.
- **Install it for good:** `npx @vscode/vsce package` produces a `.vsix`, which
  you install through "Install from VSIX…". Then set `tdc.server.path` to the
  absolute path of `server.js`.

Publishing to the Marketplace is a separate step, and only on request.

## Neovim

`nvim-lspconfig`, as a custom server:

```lua
local configs = require('lspconfig.configs')
local lspconfig = require('lspconfig')
if not configs.tdc then
  configs.tdc = {
    default_config = {
      cmd = { 'node', '/absolute/path/typescript/dist/lsp/server.js', '--stdio' },
      filetypes = { 'tdc' },
      root_dir = lspconfig.util.root_pattern('.git', 'data'),
    },
  }
end
lspconfig.tdc.setup({})
```

Highlighting in Neovim comes either from a TextMate-compatible plugin or, better,
from a Tree-sitter grammar — that can be added later if it is wanted.

## How it works inside

- The server's brains are **pure functions** with no external dependencies:
  `typescript/src/lsp/diagnostics.ts` (text → list of errors) and `convert.ts`
  (our coordinates → LSP coordinates). Both are unit-tested.
- `server.ts` is a thin wrapper over the LSP protocol (the
  `vscode-languageserver` library) and holds nothing else.
- The server reuses **the same parser and validator** as the library and the CLI.
  Change the language and the server gets smarter for free, with no duplicated
  logic.
