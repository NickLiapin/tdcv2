"""``tdcv2 init`` — create a config file by asking, rather than by making anyone hand-write JSON.

People want to generate data, not learn a config format. In a real terminal this runs a short
wizard — where the config should live, where downloaded packs go, which locale — and writes the
file. With no terminal, in a script or in CI, it takes the answers from flags instead, so it stays
scriptable and testable.

The decisions are pure functions; the wizard is a thin shell over them. That is what the tests
exercise, because a prompt is hard to test and a decision is not.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

from ..packs import project_config

USAGE = """Usage: tdcv2 init [options]

  -g, --global          Write the per-user config instead of a project one
  -y, --yes             Take the defaults, ask nothing
  -f, --force           Overwrite an existing config
  --locale <loc>        Default locale for the config (default: en)
  --data-path <dir>     Folder for downloaded packs
"""


class InitError(ValueError):
    """A command line `init` cannot obey."""


@dataclass(frozen=True, slots=True)
class Plan:
    """Everything decided, nothing written yet."""

    path: Path
    pack_store: Path
    locale: str
    is_global: bool


def config_target(is_global: bool, cwd: Path) -> Path:
    """Where the config goes: the project's own folder, or the per-user location."""
    if not is_global:
        return cwd.resolve() / project_config.CONFIG_NAME
    target = project_config.global_config_path()
    if target is None:  # pragma: no cover — every supported platform has one
        raise InitError("no global config location on this platform — use a project config")
    return target


def default_pack_store(is_global: bool, config_path: Path, cwd: Path) -> Path:
    """A project keeps packs beside its config; the global config keeps them next to itself."""
    return config_path.parent / "packs" if is_global else cwd.resolve() / "tdcv2-packs"


def config_content(plan: Plan) -> str:
    """The file's JSON.

    The store is written as ``packStore``, not as a ``dataPaths`` entry: it is where ``pack add``
    downloads to, and it is not a scan root until there is something in it — the first ``pack add``
    registers the store itself, once, for every bundle that will ever land there. A project config
    stores the path relative, so the file can be checked into git and still work on another
    machine; a global config is machine-specific by nature and stores it absolute.
    """
    store = (
        str(plan.pack_store) if plan.is_global else _relative_to(plan.path.parent, plan.pack_store)
    )
    return (
        json.dumps({"packStore": store, "locale": plan.locale}, indent=2, ensure_ascii=False) + "\n"
    )


def _relative_to(base: Path, target: Path) -> str:
    absolute, root = target.resolve(), base.resolve()
    if absolute == root:
        return "."
    try:
        return "./" + absolute.relative_to(root).as_posix()
    except ValueError:
        return str(absolute)


def write_config(plan: Plan, force: bool) -> None:
    """Write it, and create the pack folder so ``pack add`` has somewhere to go."""
    if plan.path.exists() and not force:
        raise InitError(
            f'config already exists at "{plan.path}" — pass --force to overwrite, '
            "or edit it directly"
        )
    plan.path.parent.mkdir(parents=True, exist_ok=True)
    plan.path.write_text(config_content(plan), encoding="utf-8")
    plan.pack_store.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True, slots=True)
class Flags:
    is_global: bool = False
    force: bool = False
    yes: bool = False
    locale: str | None = None
    pack_store: str | None = None


def parse_flags(argv: list[str]) -> Flags:
    out: dict[str, object] = {}
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-g", "--global"):
            out["is_global"] = True
        elif arg in ("-f", "--force"):
            out["force"] = True
        elif arg in ("-y", "--yes"):
            out["yes"] = True
        elif arg.startswith("--locale="):
            out["locale"] = arg[len("--locale=") :]
        elif arg.startswith("--data-path="):
            out["pack_store"] = arg[len("--data-path=") :]
        elif arg in ("--locale", "--data-path"):
            i += 1
            if i >= len(argv):
                raise InitError(f"missing value for {arg}")
            out["locale" if arg == "--locale" else "pack_store"] = argv[i]
        else:
            raise InitError(f"unknown option for init: {arg}")
        i += 1
    return Flags(**out)  # type: ignore[arg-type]


def plan_from_flags(flags: Flags, cwd: Path) -> Plan:
    path = config_target(flags.is_global, cwd)
    store = (
        (cwd / flags.pack_store).resolve()
        if flags.pack_store
        else default_pack_store(flags.is_global, path, cwd)
    )
    return Plan(path, store, flags.locale or "en", flags.is_global)


def run_init(argv: list[str], cwd: Path | None = None) -> int:
    here = (cwd or Path.cwd()).resolve()

    if any(a in ("-h", "--help") for a in argv):
        sys.stdout.write(USAGE)
        return 0

    try:
        flags = parse_flags(argv)
    except InitError as e:
        sys.stderr.write(f"tdcv2: {e}\nRun `tdcv2 init --help` for usage.\n")
        return 2

    interactive = sys.stdin.isatty() and sys.stdout.isatty() and not flags.yes
    try:
        plan = _ask(flags, here) if interactive else plan_from_flags(flags, here)
    except (EOFError, KeyboardInterrupt):
        sys.stderr.write("\ntdcv2: cancelled\n")
        return 1
    except InitError as e:
        sys.stderr.write(f"tdcv2: {e}\n")
        return 2

    try:
        write_config(plan, flags.force)
    except (InitError, OSError) as e:
        sys.stderr.write(f"tdcv2: {e}\n")
        return 2

    sys.stdout.write(
        f"Wrote {'global' if plan.is_global else 'project'} config: {plan.path}\n"
        f"  data packs → {plan.pack_store}\n"
        f"  locale     → {plan.locale}\n"
        f"\nNext: run `tdcv2 pack` to download data packs into that folder.\n"
    )
    return 0


def _ask(flags: Flags, cwd: Path) -> Plan:
    """The wizard. Plain `input`, because one dependency for three questions is not worth it."""
    is_global = flags.is_global
    if not flags.pack_store and not flags.is_global:
        answer = input(
            "Where should this config live?\n"
            "  1) This project — a tdcv2.config.json here, check it into git\n"
            "  2) Global — all your projects, in your home folder\n"
            "Choice [1]: "
        ).strip()
        is_global = answer == "2"

    path = config_target(is_global, cwd)
    suggested = (
        (cwd / flags.pack_store).resolve()
        if flags.pack_store
        else default_pack_store(is_global, path, cwd)
    )

    typed = input(f"Folder for downloaded data packs [{suggested}]: ").strip()
    store = (cwd / typed).resolve() if typed else suggested

    locale = input(f"Default locale [{flags.locale or 'en'}]: ").strip()
    return Plan(path, store, locale or flags.locale or "en", is_global)
