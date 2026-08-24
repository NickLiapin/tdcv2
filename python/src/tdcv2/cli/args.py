"""Command-line arguments, parsed by hand.

`argparse` was the obvious choice and the wrong one. The TypeScript CLI is the interface users
already know, and matching it exactly matters more than saving fifty lines: `--engine 2` and
`--engine=2` both work there, an unknown flag is exit code 2 with a specific message, and a
positional argument may follow flags. Getting argparse to agree on all of that costs more than
writing the loop, and leaves the agreement undocumented.

Kept apart from `main` so the parsing can be tested without a filesystem or a run.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..date import parse as date_parse
from ..date import plain


class UsageError(ValueError):
    """A command line that cannot be obeyed. Reported, then exit code 2."""


@dataclass(frozen=True, slots=True)
class Options:
    """What the command line asked for, before anything has been read or run."""

    input: str | None = None
    output: str | None = None
    seed: str | None = None
    count: int | None = None
    locale: str | None = None
    now: int | None = None
    data_paths: list[str] = field(default_factory=list)
    jobs: int | None = None
    mode: str | None = None
    engine: int | None = None
    progress: bool = False
    help: bool = False
    version: bool = False


#: Flags that take a value, in both the `--flag value` and `--flag=value` spellings.
_VALUED = (
    "--output",
    "--seed",
    "--count",
    "--locale",
    "--now",
    "--data-path",
    "--jobs",
    "--mode",
    "--engine",
)


def parse(argv: list[str]) -> Options:
    """The generate command's arguments. Raises `UsageError` with the message to print."""
    out: dict[str, object] = {"data_paths": []}
    i = 0
    while i < len(argv):
        arg = argv[i]

        name, value = _split(arg)
        if name in _VALUED:
            if value is None:
                i += 1
                if i >= len(argv) or argv[i] == "":
                    raise UsageError(f"missing value for {name}")
                value = argv[i]
            _store(out, name, value)
            i += 1
            continue

        if arg in ("-o", "--output"):
            i += 1
            if i >= len(argv):
                raise UsageError("missing value for --output")
            out["output"] = argv[i]
        elif arg in ("-h", "--help"):
            out["help"] = True
        elif arg in ("-v", "--version"):
            out["version"] = True
        elif arg == "--stream":
            # The legacy spelling of --engine 2, kept because configs and scripts still say it.
            out["engine"] = 2
        elif arg == "--disk":
            out["mode"] = "disk"
        elif arg == "--progress":
            out["progress"] = True
        elif arg.startswith("-"):
            raise UsageError(f"unknown option: {arg}")
        elif out.get("input") is None:
            out["input"] = arg
        else:
            raise UsageError(f"unexpected positional argument: {arg}")
        i += 1

    return Options(**out)  # type: ignore[arg-type]


def _split(arg: str) -> tuple[str, str | None]:
    """`--flag=value` into its parts; anything else unchanged with no value."""
    if arg.startswith("--") and "=" in arg:
        name, _, value = arg.partition("=")
        if value == "":
            raise UsageError(f"missing value for {name}")
        return name, value
    return arg, None


def _store(out: dict[str, object], name: str, value: str) -> None:
    if name == "--output":
        out["output"] = value
    elif name == "--seed":
        out["seed"] = value
    elif name == "--locale":
        out["locale"] = value
    elif name == "--now":
        out["now"] = _now_millis(value)
    elif name == "--data-path":
        paths = out["data_paths"]
        assert isinstance(paths, list)
        paths.append(value)
    elif name == "--count":
        out["count"] = _non_negative(value, "--count")
    elif name == "--jobs":
        out["jobs"] = _positive(value, "--jobs")
    elif name == "--engine":
        if value not in ("1", "2", "3"):
            raise UsageError(
                f'invalid --engine "{value}" — expected 1 (in-memory), 2 (streaming), '
                "or 3 (exact-on-disk)"
            )
        out["engine"] = int(value)
    elif name == "--mode":
        if value not in ("memory", "disk"):
            raise UsageError(f'invalid --mode "{value}" — expected "memory" or "disk"')
        out["mode"] = value


def _now_millis(value: str) -> int:
    """The clock `--now` pins, in milliseconds since the epoch.

    The syntax is the date generator's own — whatever ``<gen type="date" value="…">`` accepts is
    what this accepts, down to the same parser — so the project has one date syntax rather than
    two. It carries no zone, so like every date in the engine it is read as UTC. A value that does
    not parse is refused rather than falling back to the real clock, which would hand back the very
    irreproducibility the flag exists to remove.
    """
    try:
        return plain.to_epoch_millis(date_parse.date_time(value).value)
    except plain.DateError:
        raise UsageError(
            f'invalid --now "{value}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)'
        ) from None


def _non_negative(value: str, flag: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise UsageError(f'invalid {flag} "{value}" — expected a non-negative integer') from None
    if parsed < 0:
        raise UsageError(f'invalid {flag} "{value}" — expected a non-negative integer')
    return parsed


def _positive(value: str, flag: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise UsageError(f'invalid {flag} "{value}" — expected a positive integer') from None
    if parsed < 1:
        raise UsageError(f'invalid {flag} "{value}" — expected a positive integer')
    return parsed
