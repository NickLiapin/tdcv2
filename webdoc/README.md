# `webdoc/` — the documentation source

This is the source of the TDC documentation: a [Docusaurus](https://docusaurus.io/)
site in three languages. **English is canonical**; `i18n/ru` and `i18n/es` are its
translations.

The folder is called `webdoc` and not `website` on purpose — there will be more
than one web thing in this repository, and a name should say which one it is.

`docs/` at the repository root is **generated from here** and committed so the
pages are readable on GitHub. Never edit it by hand; `npm run docs:check` fails on
drift.

## Everyday commands

Run these from the repository root.

```bash
npm --prefix webdoc run start    # dev server with live reload
npm --prefix webdoc run build    # build all three languages into webdoc/build/
npm run docs:export              # regenerate the committed docs/ from here
npm run docs:check               # links, anchors, drift and three-way parity
```

## What the scripts do

| Script                          | What it is for                                                      |
| ------------------------------- | ------------------------------------------------------------------- |
| `export-markdown.mjs`           | MDX → the GitHub-readable Markdown in `docs/` (`docs:export`)       |
| `check-markdown-export.mjs`     | Links, anchors, images; `--drift` compares `docs/` with this source |
| `check-translation-parity.mjs`  | The three trees must have the same shape                            |
| `audit-doc-coverage.mjs`        | Every name the engine implements is mentioned in the English docs   |
| `audit-example-consistency.mjs` | An example's prose must agree with the output printed beside it     |
| `make-*-figures.mjs`            | The SVG figures, generated from real CLI runs — never drawn by hand |
| `make-review-bundle.mjs`        | A zip of the built site plus a comment layer, for a reviewer        |
| `fix-translated-anchors.mjs`    | Repairs anchors that a translated heading moved                     |

Style rules for writing the pages live in [`STYLE.md`](./STYLE.md).
