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

import json
import math
import os
import sys
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from ..errors import Diagnostic, Severity, TdcError, format_diagnostic, format_diagnostics
from .args import Options, UsageError, parse

if TYPE_CHECKING:  # `TDC` is imported inside the function it is used in, to keep startup cheap.
    from ..tdc import TDC


def _version() -> str:
    """The installed distribution's version, not a second copy of it.

    A hand-written constant here is a number that agrees with itself and with
    nothing else: bumping ``pyproject.toml`` for a release left ``tdcv2
    --version`` reporting the old one, silently. The TypeScript package had
    exactly this bug and it went unnoticed through a release. The fallback
    covers running from a source tree that was never installed, where there is
    no distribution to ask.
    """
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("tdcv2")
    except PackageNotFoundError:
        return "0+unknown"


VERSION = _version()

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
  --now <date>             Pin the clock date generators read as "now" —
                           YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss, always UTC.
                           Without it the run reads the real clock, so a config
                           using today / now / b_day cannot be reproduced later
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Split the run across n processes. Same output either
                           way — a pure speed knob. Needs -o and the streaming
                           engine; ignored where the run cannot be split
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --progress               Write <output>.progress — a small JSON status file
                           refreshed about once a second (phase, rows done,
                           percent). Needs -o. Poll it, or watch its mtime as
                           a heartbeat: not updated for minutes = not running
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the current
directory) and the global config — { "dataPaths": [...], "locale": ".." }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdcv2 for the DSL reference.
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


MISSING_CONFIG_HINT = (
    "  `tdcv2 init` writes a config and three worked examples into this folder,\n"
    "  then prints the command that runs the first one.\n"
)


def _missing_config(path: str) -> str:
    """What to say when the config named on the command line is not there.

    Byte-identical in all five: it is one command with five front ends, and a reader who
    hits this in one must not get less help in the next.
    """
    return f'tdcv2: no config file at "{path}"\n\n' + MISSING_CONFIG_HINT


def _generate(options: Options) -> int:
    from ..tdc import TDC

    # Checked here rather than left to the reader: this is the first error a newcomer can
    # hit and it used to be the worst one in the product — a raw "[Errno 2] No such file"
    # with no code, no hint and no mention of the command that would have created
    # something to run.
    if options.input and not Path(options.input).exists():
        sys.stderr.write(_missing_config(options.input))
        return 1

    status = None
    if options.progress:
        if not options.output:
            sys.stderr.write(
                "tdcv2: --progress needs -o (the status file lives beside the output)\n"
            )
            return 2
        status = _StatusFile(Path(f"{options.output}.progress"))

    try:
        data = TDC(
            options.input,
            count=options.count,
            seed=options.seed,
            locale=options.locale,
            now=options.now,
            data_paths=[Path(p) for p in options.data_paths] or None,
            engine=options.engine if options.engine is not None else _engine_for(options.mode),
            on_progress=status.report if status is not None else None,
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

    try:
        code = _produce(data, options)
        if code == 0 and status is not None:
            status.finish()
        return code
    except TdcError as e:
        _report(e.diagnostics, options.input, e.source)
        return 1
    except (OSError, ValueError, RuntimeError) as e:
        # The same channel, for everything after the config is built. It used to guard only the
        # WRITE, and the engine router raises from `preflight` — which sits before it — so a
        # plain mode="nonsense" printed a Python traceback where the reference prints one line.
        # A reader saw "the program broke" instead of "your config is wrong", with our own file
        # names as the evidence.
        _fail(str(e))
        return 1


class _StatusFile:
    """The ``--progress`` status file: one small JSON object, rewritten in place.

    Written atomically (temp + rename) so a poller never reads half a JSON, and throttled to about
    once a second so watching costs nothing. On success the last write says ``"phase":"done"`` with
    the wall-clock seconds the run took.

    The file is REWRITTEN at least once a second whether or not the work has anything new to say —
    the last state again, with a fresh ``updatedAt`` — so that a file which has not moved for
    minutes really does mean the process is gone. It used to mean no such thing: nothing wrote
    unless a phase reported, and a phase that is working reports nothing, so a healthy run could
    leave the file untouched for over two minutes.

    A run split across workers is counted whole: every shard reports the rows it has written and
    the parent adds them up, so the percent is the FILE's, not one worker's.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._started_at = int(time.time() * 1000)
        self._last_write = 0
        self._last: dict | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # The file exists from the first moment, under a phase that is TRUE. A watcher that finds
        # no file cannot tell "not started yet" from "died", and the opening moment used to be
        # marked `render` — a phase still two stages away.
        self._write(
            {
                "phase": "starting",
                "percent": 0,
                "startedAt": self._started_at,
                "updatedAt": self._started_at,
                "pid": os.getpid(),
            }
        )
        self._beat = threading.Thread(target=self._pulse, daemon=True)
        self._beat.start()

    def _pulse(self) -> None:
        """Rewrite the last state every second that passes without a report."""
        while not self._stop.wait(1.0):
            with self._lock:
                if self._last is not None and int(time.time() * 1000) - self._last_write >= 1000:
                    self._write({**self._last, "updatedAt": int(time.time() * 1000)})

    def _write(self, payload: dict) -> None:
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
        tmp.replace(self._path)
        self._last_write = int(time.time() * 1000)
        self._last = payload

    def report(self, phase: str, done: int, total: int) -> None:
        now = int(time.time() * 1000)
        # A finished phase is always written, throttle or not: several piles can finish inside one
        # second, and the throttle then dropped every report after the first — leaving the file
        # saying "1 of 44" while the run had moved on.
        if done != total and now - self._last_write < 1000:
            return
        with self._lock:
            self._write(
                {
                    "phase": phase,
                    "done": done,
                    "total": total,
                    "percent": self._percent(done, total),
                    "startedAt": self._started_at,
                    "updatedAt": now,
                    "pid": os.getpid(),
                }
            )

    @staticmethod
    def _percent(done: int, total: int) -> float | int:
        """A whole percentage as an int, the way every other runtime writes it.

        ``round(...)/10`` is a float in Python, so 70 would go into the file as ``70.0`` where the
        other four write ``70`` — one field, two spellings, and a poller written against one of
        them parsing the other.
        """
        if total <= 0:
            return 0
        # `round` is banker's in Python: round(812.5) is 812, where the reference's
        # Math.round gives 813. One field, two answers, on any run whose percent lands
        # exactly on a half. Floor of x+0.5 is what the other four do.
        value = math.floor(done / total * 1000 + 0.5) / 10
        return int(value) if value == int(value) else value

    def finish(self) -> None:
        self._stop.set()
        now = int(time.time() * 1000)
        self._write(
            {
                "phase": "done",
                "percent": 100,
                "startedAt": self._started_at,
                "updatedAt": now,
                "elapsedSeconds": math.floor((now - self._started_at) / 1000 + 0.5),
                "pid": os.getpid(),
            }
        )


def _produce(data: TDC, options: Options) -> int:
    """Everything after the config is built: report, seed note, preflight, write."""
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

    if options.output is not None:
        data.write_file(options.output, workers=options.jobs)
    else:
        # Straight to stdout in one write per record batch rather than per record: a syscall a
        # row is most of the cost of a large run that is not being written to a file.
        sys.stdout.write(str(data))

    return 0


def _check(argv: list[str]) -> int:
    """``tdcv2 check <file>`` — the validator alone, for an editor or a pre-commit hook."""
    # ``--brief`` prints one line per diagnostic and no source excerpt: an editor
    # listing errors in a panel wants rows, not a picture of the file.
    brief = "--brief" in argv
    files = [a for a in argv if not a.startswith("-")]
    flags = [a for a in argv if a.startswith("-")]
    if any(f != "--brief" for f in flags) or len(files) != 1:
        _fail("usage: tdcv2 check [--brief] <input.tdc>")
        return 2

    from ..tdc import TDC

    try:
        data = TDC(files[0])
    except TdcError as e:
        _report(e.diagnostics, files[0], e.source, brief=brief)
        return 1
    except (OSError, ValueError) as e:
        _fail(str(e))
        return 1

    problems = data.diagnostics
    _report(problems, files[0], data.source, brief=brief)
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


def _report(
    problems: list[Diagnostic],
    filename: str | None,
    source: str | None = None,
    *,
    brief: bool = False,
) -> None:
    """Diagnostics to stderr, so they stay out of a piped or redirected run's data."""
    if not problems:
        return
    if brief:
        sys.stderr.write("\n".join(_brief_line(d) for d in problems) + "\n")
        return
    sys.stderr.write(
        format_diagnostics(problems, source, filename or "<input>", sys.stderr.isatty()) + "\n"
    )


def _brief_line(d: Diagnostic) -> str:
    """One diagnostic on one line: code, position, message, hint after ``::``.

    The hint is kept because it carries the list of what IS allowed, which is the
    half a reader — or a model — acts on. No trailing count either, so a caller
    parsing rows need not skip a sentence at the end.
    """
    code = d.code or ("WARN" if d.severity == "warning" else "ERROR")
    hint = f" :: {d.hint}" if d.hint else ""
    return f"{code} {d.line}:{d.column} {d.message}{hint}"


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
