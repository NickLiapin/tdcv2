# TDC Grammar

This directory contains the ANTLR grammar files that serve as the source of
truth for TDC DSL syntax across language implementations.

## Status

**Active.** The grammar is split into `TDCLexer.g4` and `TDCParser.g4` because
ANTLR lexer modes require a pure lexer grammar.

## Why one grammar

TDC is a cross-language project. TypeScript, Python, and Java implementations must
parse the same `.tdc` files identically. Rather than maintaining three parallel
parsers, a single ANTLR4 grammar generates a parser for each target language.

When grammar changes:

1. `TDCLexer.g4` / `TDCParser.g4` are updated here.
2. Parsers are regenerated for each language via their build tools.
3. Tests verify no behavioral regressions on `../fixtures/`.

## Scope

The grammar covers:

- Top-level structure (`<tdc>`, `<env>`, `<block>`)
- Sequence declarations (`<sequence>`, `<gen>`)
- Output wrappers (`<before>`, `<after>`, `<before_block>`, etc.)
- Attributes (including `parent="X.Value"` dot-notation)
- Raw-text `<data>`; `pair` close-tag disambiguation is normalized before lexing
- Unescaped `<` and `>` inside attribute values (for `if="gender < 50"`)
- Expressions in `if` attributes (`&&`, `||`, `==`, comparisons, arithmetic)
- `<switch>/<case>` (generic tags in grammar, semantics in runtime)
- Comments

## References

- [../docs/reference/tags.md](../docs/reference/tags.md) — every tag the grammar accepts
- [../docs/reference/attributes.md](../docs/reference/attributes.md) — every attribute
- [../docs/bindings/](../docs/bindings/) — how one grammar serves three languages
