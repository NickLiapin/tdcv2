"""``tdcv2`` — the command line.

The library is the recommended way to embed TDC; this exists so that a `.tdc` file can be run
without writing a program around it, and so that a Python user never needs another language's
toolchain to do it. The surface deliberately matches the TypeScript CLI flag for flag: the same
config run through either must behave the same way, including its exit codes.

Three commands beyond generating:

* ``init``  — write a ``tdcv2.config.json``, by asking rather than by making anyone hand-write JSON
* ``pack``  — list, install and remove data packs from the shared registry
* ``check`` — validate a config and say nothing when it is fine

Exit codes: 0 fine, 1 the run failed (an invalid config, a refused preflight), 2 the command line
itself was wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path

from ..errors import Diagnostic, Severity, TdcError, format_diagnostic, format_diagnostics
from .args import Options, UsageError, parse

VERSION = "0.1.0"

HELP = """tdcv2 — The Data Constructor

Usage:
  tdcv2 <input.tdc> [options]       Generate data from a config
  tdcv2 init [--global]             Set up a config (asks where; --yes for defaults)
  tdcv2 pack [list|add|remove <id>] Install / remove data packs (list with no args)
  tdcv2 check <input.tdc>           Validate a config without generating anything
  tdcv2 format [-w] <file.tdc>      Pretty-print a config (-w writes it in place)

Options:
  -o, --output <path>      Write generated content to <path> (default: stdout)
  --seed <seed>            Override the seed declared in <env>
  --count <n>              Override the count declared in <env>
  --locale <loc>           Override the default locale (default: en)
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Split the run across n processes. Same output either
                           way — a pure speed knob. Needs -o and the streaming
                           engine; ignored where the run cannot be split
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the current
directory) and the global config — { "dataPaths": [...], "locale": ".." }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdc-v2 for the DSL reference.
"""


def main(argv: list[str] | None = None) -> int:
    """Run the CLI. Returns the exit code rather than calling `exit`, so tests can drive it."""
    args = list(sys.argv[1:] if argv is None else argv)

    if args and args[0] == "init":
        from .init import run_init

        return run_init(args[1:])
    if args and args[0] == "pack":
        from .pack import run_pack

        return run_pack(args[1:])
    if args and args[0] == "check":
        return _check(args[1:])
    if args and args[0] == "format":
        return _format(args[1:])

    try:
        options = parse(args)
    except UsageError as e:
        _fail(str(e), usage=True)
        return 2

    if options.help:
        sys.stdout.write(HELP)
        return 0
    if options.version:
        sys.stdout.write(f"tdcv2 {VERSION}\n")
        return 0
    if options.input is None:
        _fail("input file is required", usage=True)
        return 2

    return _generate(options)


def cli() -> None:
    """The console-script entry point: run, then exit with the code."""
    raise SystemExit(main())


def _generate(options: Options) -> int:
    from ..tdc import TDC

    try:
        data = TDC(
            options.input,
            count=options.count,
            seed=options.seed,
            locale=options.locale,
            data_paths=[Path(p) for p in options.data_paths] or None,
            engine=options.engine if options.engine is not None else _engine_for(options.mode),
        )
    except TdcError as e:
        _report(e.diagnostics, options.input, e.source)
        return 1
    except (OSError, ValueError, RuntimeError) as e:
        # RuntimeError covers the engines' refusals (an infeasible uniq, a
        # forced streaming engine on a whole-column config) — the reference
        # prints these as one line, never a stack trace.
        _fail(str(e))
        return 1

    _report(data.diagnostics, options.input, data.source)

    # A run with no seed anywhere gets a random one. Print it, or the output cannot be reproduced —
    # which is the one promise the whole library is built to keep.
    seed = data.seed_info()
    if seed.generated:
        _note(
            f'no seed specified — using random seed "{seed.seed}". '
            f'Re-run with --seed "{seed.seed}" to reproduce this exact output.'
        )

    # Ask what the run will cost before starting it. A config that cannot fit says so in a
    # millisecond here and takes minutes to say so by thrashing.
    budget = data.preflight(materialized=options.output is None)
    if budget is not None:
        _report_one(budget, options.input, data.source)
        if budget.severity is Severity.ERROR:
            return 1

    try:
        if options.output is not None:
            data.write_file(options.output, workers=options.jobs)
        else:
            # Straight to stdout in one write per record batch rather than per record: a syscall a
            # row is most of the cost of a large run that is not being written to a file.
            sys.stdout.write(str(data))
    except (OSError, ValueError, RuntimeError) as e:
        # RuntimeError is the engines' refusal channel (an infeasible uniq, a
        # forced streaming engine on a whole-column config): one line, exit 1,
        # never a stack trace — the reference's behavior.
        _fail(str(e))
        return 1
    return 0


def _check(argv: list[str]) -> int:
    """``tdcv2 check <file>`` — the validator alone, for an editor or a pre-commit hook."""
    files = [a for a in argv if not a.startswith("-")]
    if len(argv) != len(files) or len(files) != 1:
        _fail("usage: tdcv2 check <input.tdc>")
        return 2

    from ..tdc import TDC

    try:
        data = TDC(files[0])
    except TdcError as e:
        _report(e.diagnostics, files[0], e.source)
        return 1
    except (OSError, ValueError) as e:
        _fail(str(e))
        return 1

    problems = data.diagnostics
    _report(problems, files[0], data.source)
    if not problems:
        sys.stderr.write(f"tdcv2: {files[0]} is valid\n")
    return 0


def _format(argv: list[str]) -> int:
    """``tdcv2 format [-w] <file.tdc>`` — pretty-print a config.

    Prints to stdout by default; ``-w`` overwrites the file. A file with a syntax error is
    reported and left alone: reformatting something that cannot be parsed would be a guess about
    what the author meant.
    """
    write = False
    files: list[str] = []
    for arg in argv:
        if arg in ("-w", "--write"):
            write = True
        elif arg in ("-h", "--help"):
            sys.stdout.write("Usage: tdcv2 format [-w|--write] <file.tdc>\n")
            return 0
        elif arg.startswith("-"):
            _fail(f"format: unknown option: {arg}")
            return 2
        else:
            files.append(arg)

    if len(files) != 1:
        _fail("format: a .tdc file is required")
        return 2

    from ..formatter import format_tdc

    path = Path(files[0])
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as e:
        _fail(f"format: cannot read {files[0]}: {e}")
        return 1

    # Never format a file we cannot fully parse — report the syntax error instead.
    from ..parser import facade

    parsed = facade.parse(source)
    if not parsed.ok:
        problems = [
            Diagnostic.error("TDC001", p.message, "", p.line, p.column) for p in parsed.problems
        ]
        _report(problems, files[0], source)
        return 1

    formatted = format_tdc(source)
    if not write:
        sys.stdout.write(formatted)
        return 0

    if formatted != source:
        # Write beside the file and rename over it: a crash mid-write must not
        # leave the user's config truncated.
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(formatted, encoding="utf-8")
        tmp.replace(path)
        _note(f"formatted {files[0]}")
    else:
        _note(f"{files[0]} is already formatted")
    return 0


def _engine_for(mode: str | None) -> int | None:
    """``--mode memory`` is the in-memory engine by name; ``disk`` is the default already."""
    return 1 if mode == "memory" else None


def _report(problems: list[Diagnostic], filename: str | None, source: str | None = None) -> None:
    """Diagnostics to stderr, so they stay out of a piped or redirected run's data."""
    if not problems:
        return
    sys.stderr.write(
        format_diagnostics(problems, source, filename or "<input>", sys.stderr.isatty()) + "\n"
    )


def _report_one(problem: Diagnostic, filename: str | None, source: str | None = None) -> None:
    sys.stderr.write(
        format_diagnostic(problem, source, filename or "<input>", sys.stderr.isatty()) + "\n"
    )


def _fail(message: str, usage: bool = False) -> None:
    sys.stderr.write(f"tdcv2: {message}\n")
    if usage:
        sys.stderr.write("Run `tdcv2 --help` for usage.\n")


def _note(message: str) -> None:
    sys.stderr.write(f"tdcv2: {message}\n")


if __name__ == "__main__":
    cli()
