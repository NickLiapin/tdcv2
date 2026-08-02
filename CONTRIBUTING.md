# Contributing to TDC

Thank you for your interest in TDC. This is a solo-maintained open-source project
currently in pre-release development (v1.0 in progress). External contributions
are welcome once v1.0 ships publicly.

Until then, this document captures the conventions that the maintainer (and
AI-assisted development) follows.

## Where to start

All prospective contributors — human or AI — should begin with the
[documentation](docs/), which covers every implemented feature, and with the
[CHANGELOG](CHANGELOG.md), which records what changed and why.

## Development principles

The full set of engineering standards is kept in the project's internal notes.
The non-negotiable highlights:

- **No source file exceeds 1000 lines.** Enforced by linters. Exceptions only
  for generated code and regression fixtures.
- **Every feature has tests.** Test-first or test-alongside. No tests → no merge.
- **Conventional Commits** for commit messages: `feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `refactor:`, `style:`, `perf:`.
- **TypeScript strict mode** for TS implementation; equivalent strictness for
  Python (mypy/pyright) and Java (Checkstyle + ErrorProne).
- **Bit-identical determinism** across language implementations. Same seed +
  same DSL file → same byte-for-byte output on TS, Python, Java.
- **No direct commits to `main`.** All changes through pull requests, self-reviewed.
- **Update [CHANGELOG.md](CHANGELOG.md) and documentation** with each significant change.

## Cross-language coordination

TDC maintains multiple implementations from **one shared grammar** (`grammar/TDC.g4`).
When modifying the DSL:

1. Grammar changes are applied to `grammar/TDC.g4` first.
2. Parsers for each language are regenerated from the updated grammar.
3. Engine-level changes are ported across all active implementations.
4. All regression fixtures must pass on all implementations.
5. Only then can the change land in `main`.

This discipline ensures that the project remains a single coherent tool
regardless of which language implementation the user consumes.

Step 4 has one command:

```bash
npm run parity
```

It runs every implementation's own suite in turn — TypeScript, Python, Rust, C#,
Java — and prints one line each. A toolchain you do not have installed is reported
as `MISSING` and fails the run rather than being skipped quietly, because "four of
five passed and the fifth never ran" is exactly the state this command exists to
catch. Pass `--allow-missing` when you knowingly lack one, or `--only rust,java`
to narrow it.

It is deliberately NOT part of `npm run check`: `check` is the everyday loop, and
a cold Cargo, Gradle and dotnet build turns seconds into minutes. CI runs the five
on every push instead (`.github/workflows/five-ways.yml`), so nothing regresses
between the times a person remembers to run it.

## Issue reporting

Until public release, issue tracking is internal. Post-release, please use
GitHub Issues with appropriate templates.

## Pull requests

Once contributions are opened:

- One focused change per PR.
- Descriptive title following Conventional Commits format.
- Description explaining **why** as well as **what**.
- Tests included.
- CHANGELOG entry added under `[Unreleased]`.
- All CI checks green.
- Documentation updated if user-visible behavior changed.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
