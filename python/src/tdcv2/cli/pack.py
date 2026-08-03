"""``tdcv2 pack`` — the data packs, from the shared registry.

The library ships with English and the USA and nothing else, because the packs are meant to grow to
a size no library should carry. Everything else is downloaded on demand from one registry that all
three implementations read, so a pack fetched by any of them works in the other two.

A bundle is axis-pure — one language (``en``), or one country (``usa``), or ``common`` — because
language and country are independent and compose: US English is common + en + usa. Everything lands
in ONE tree, at its address path: ``<store>/ru/…``, ``<store>/countries/russia/…``. Which bundle
owns which path is written down in ``<store>/.tdcv2-installed.json`` rather than implied by a folder
name, so ten languages and a hundred countries are one folder and one ``dataPaths`` entry.

Where things go is decided by the config cascade, not guessed: ``packStore`` from the nearest
``tdcv2.config.json``, else the global one. With neither, `init` has not been run and this says so
rather than inventing a folder.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from ..packs import project_config
from ..packs.registry import DEFAULT_BASE_URL, Registry
from ..packs.store import (
    PackError,
    StoreMigration,
    delete_owned_paths,
    find_bundle,
    installed,
    migrate_store,
    read_installed,
    without_bundle,
    write_installed,
)

USAGE = """Usage: tdcv2 pack [command]

  list                  Show what can be installed, and what already is
  add <id>...           Download and install one or more bundles
  remove <id>...        Uninstall, and drop them from the config

  --registry <url>      Use another registry (default: the public one)
"""


@dataclass(frozen=True, slots=True)
class Store:
    """Where downloads go, and which config file records them."""

    path: Path
    config_path: Path


def resolve_store(cwd: Path | None = None) -> Store:
    """The pack folder and the config that owns it, from the cascade.

    A project config wins over the global one — packs belong to the project that uses them. Neither
    means `init` has not run, and guessing a folder here would put data somewhere the next command
    would not look.
    """
    here = (cwd or Path.cwd()).resolve()
    resolved = project_config.load(here)

    config_path = project_config.find_project_config(here)
    if config_path is None:
        config_path = project_config.global_config_path()
    if config_path is None or not config_path.is_file():
        raise PackError("no tdcv2.config.json found — run `tdcv2 init` first")

    if resolved.pack_store is None:
        raise PackError(
            f'config "{config_path}" does not name a "packStore" — '
            "add one, or re-run `tdcv2 init --force`"
        )
    return Store(resolved.pack_store, config_path)


def run_pack(argv: list[str], cwd: Path | None = None) -> int:
    if any(a in ("-h", "--help") for a in argv):
        sys.stdout.write(USAGE)
        return 0

    registry_url = DEFAULT_BASE_URL
    rest: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--registry":
            i += 1
            if i >= len(argv):
                sys.stderr.write("tdcv2: missing value for --registry\n")
                return 2
            registry_url = argv[i]
        elif arg.startswith("--registry="):
            registry_url = arg[len("--registry=") :]
        else:
            rest.append(arg)
        i += 1

    # No subcommand and a real terminal on both ends: browse the catalogue instead of printing it.
    # Anywhere else — a pipe, a script, CI — printing is the only sensible thing to do.
    # TDCV2_NO_PICKER turns the picker off deliberately: for a script that wants the printed list,
    # and for anyone who would rather not be dropped into a full-screen program.
    interactive = (
        not rest
        and not os.environ.get("TDCV2_NO_PICKER")
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    )
    command = rest[0] if rest else "list"
    ids = rest[1:]

    try:
        store = resolve_store(cwd)
    except PackError as e:
        sys.stderr.write(f"tdcv2: {e}\n")
        return 2

    try:
        # Before anything reads the store: a store from an older tdcv2 is in the old per-bundle
        # layout, which `list`, `add` and `remove` all now misread. The first `tdcv2 pack` after
        # an upgrade fixes it, once, and says what it did.
        migration = migrate_store(store.path, store.config_path)
        if migration is not None:
            _report_migration(migration)

        if interactive:
            return _browse(Registry(registry_url), store)
        if command == "list":
            return _list(Registry(registry_url), store)
        if command == "add":
            if not ids:
                sys.stderr.write("tdcv2: `pack add` needs at least one bundle id\n")
                return 2
            return _add(Registry(registry_url), store, ids)
        if command == "remove":
            if not ids:
                sys.stderr.write("tdcv2: `pack remove` needs at least one bundle id\n")
                return 2
            return _remove(store, ids)
    except PackError as e:
        sys.stderr.write(f"tdcv2: {e}\n")
        return 2

    sys.stderr.write(f'tdcv2: unknown pack command "{command}" (use list | add | remove)\n')
    return 2


#: Where a description starts: two spaces, the id column, a space.
# The narrowest the id column ever gets: two spaces, twelve, a space. It grows to fit the widest
# id in the catalogue — "sao_tome_and_principe" is twenty-one characters, and a fixed twelve
# pushed every column after it out of line on that row alone. It never shrinks below this, so a
# short catalogue keeps the shape the shared CLI fixture pins.
_MIN_ID_WIDTH = 12


def _wrap(text: str, indent: int) -> list[str]:
    """Text folded to the terminal, with every line under the same indent.

    Descriptions run to two hundred characters. Printed as one line each they wrap wherever the
    window happens to end and the remainder lands hard against the left margin, which turns a list
    of a hundred packs into a wall nobody can read down. Off a terminal there is no width to ask
    for, so 80 is assumed — the same answer every implementation gives, which keeps their output
    identical when it is piped.
    """
    try:
        columns = os.get_terminal_size().columns
    except OSError:
        columns = 80
    width = max(40, columns) - indent
    pad = " " * indent
    lines: list[str] = []
    line = ""
    for word in text.split():
        if not line:
            line = word
        elif len(line) + 1 + len(word) <= width:
            line += " " + word
        else:
            lines.append(pad + line)
            line = word
    if line:
        lines.append(pad + line)
    return lines


def _browse(registry: Registry, store: Store) -> int:
    """The catalogue, browsed rather than listed.

    The picker only decides; installing and removing stay here, so the digests, the progress
    reporting and the config writing have one home whether the ids were typed or pointed at.
    """
    from .pack_picker import run_picker

    index = registry.index()
    if not index.bundles:
        sys.stdout.write("No bundles in the registry.\n")
        return 0

    decision = run_picker(index.bundles, set(installed(store.path)))
    if decision is None:
        return 0

    if decision.remove:
        _remove(store, decision.remove)
    if decision.install:
        return _add(registry, store, decision.install)
    if not decision.remove:
        sys.stdout.write("Nothing selected.\n")
    return 0


def _list(registry: Registry, store: Store) -> int:
    index = registry.index()
    here = set(installed(store.path))

    if not index.bundles:
        sys.stdout.write("No bundles in the registry.\n")
        return 0

    id_width = max(_MIN_ID_WIDTH, *(len(b.id) for b in index.bundles))
    # Two spaces of margin, the id column, one space — where a description and the "installed"
    # mark both start.
    indent = 2 + id_width + 1

    sys.stdout.write("Available data packs:\n\n")
    for bundle in index.bundles:
        mark = "\u2713 installed" if bundle.id in here else " "
        sys.stdout.write(
            f"  {bundle.id:<{id_width}} {mark:<12} "
            f"{bundle.name} ({bundle.bytes / 1048576:.1f} MB)\n"
        )
        for line in _wrap(bundle.description, indent):
            sys.stdout.write(line + "\n")
        sys.stdout.write("\n")

    # An id in the store that the registry no longer lists still works; saying so beats a silent
    # omission that reads like the pack is gone.
    orphans = sorted(here - {b.id for b in index.bundles})
    if orphans:
        sys.stdout.write("Installed but not in this registry: " + ", ".join(orphans) + "\n\n")

    sys.stdout.write("Install with: tdcv2 pack add <id>\n")
    return 0


def _installed_at(store: Path, paths: list[str]) -> str:
    """Where a bundle's data ended up, for the line that reports an install or a removal."""
    return ", ".join(str(store / path) for path in paths)


def _add(registry: Registry, store: Store, ids: list[str]) -> int:
    index = registry.index()
    # Every id is looked up before anything is downloaded, so a typo in the third one does not
    # leave the first two half-installed.
    bundles = [index.find(bundle_id) for bundle_id in ids]
    for bundle in bundles:
        sys.stderr.write(f"tdcv2: downloading {bundle.id} ({bundle.bytes / 1048576:.1f} MB)…\n")
        result = registry.install(bundle, store.path)
        # The STORE goes into the config, once, however many bundles land in it \u2014 not each one.
        stored = project_config.storable(store.config_path, store.path)
        added = project_config.register(store.config_path, [store.path])
        sys.stdout.write(
            f"Installed {bundle.id}: {result.files} files "
            f"\u2192 {_installed_at(store.path, result.paths)}\n"
            + (
                f"  registered {stored} in {store.config_path}\n"
                if added
                else f"  already registered in {store.config_path}\n"
            )
        )
    return 0


def _remove(store: Store, ids: list[str]) -> int:
    """Bundles uninstalled: exactly the paths the store recorded for each, and nothing beside them.

    Deleting by record rather than by folder name is what a shared tree costs and what it buys:
    ``russia`` lives at ``countries/russia`` next to ``countries/usa``, and only the recorded path
    goes. Because installs SHADOW the bundled default rather than replacing it, removing a bundle
    simply lets the default resurface — no hole. Nothing here touches the network.
    """
    record = read_installed(store.path)
    for bundle_id in ids:
        entry = find_bundle(record, bundle_id)
        if entry is None:
            # Not an error. `remove` is asked for to reach a state, and that state already holds;
            # exiting non-zero would make an idempotent script fail on its second run.
            sys.stderr.write(f'tdcv2: "{bundle_id}" is not installed — nothing to remove\n')
            continue
        delete_owned_paths(store.path, entry.paths)
        record = without_bundle(record, bundle_id)
        write_installed(store.path, record)
        sys.stdout.write(f"Removed {bundle_id} ({_installed_at(store.path, entry.paths)})\n")

    # The store stays registered while it still holds something: one entry serves every bundle in
    # it, so it only comes out when the last one leaves.
    if not record.bundles and project_config.unregister(store.config_path, [store.path]):
        sys.stdout.write(
            f"  store now empty — unregistered {store.path} from {store.config_path}\n"
        )
    return 0


def _report_migration(migration: StoreMigration) -> None:
    """A store moved to the flat layout, said out loud.

    On stderr: `pack list` prints a catalogue people pipe, and a one-off notice about the store is
    no part of it.
    """
    lines = [
        f'tdcv2: pack store "{migration.store}" used the old per-bundle layout; '
        "moved it to the flat one."
    ]
    for move in migration.moves:
        lines.append(f"  {move.id}: {move.source} → {', '.join(move.to)} ({move.files} files)")
    if migration.dropped_data_paths > 0:
        lines.append(f"  dropped {migration.dropped_data_paths} per-bundle dataPaths entries")
    if migration.registered is not None:
        lines.append(f"  registered {migration.registered} instead")
    if migration.leftovers:
        shown = ", ".join(migration.leftovers[:3])
        rest = len(migration.leftovers) - 3
        more = f", … and {rest} more" if rest > 0 else ""
        lines.append(f"  left where they were (not pack data): {shown}{more}")
    sys.stderr.write("\n".join(lines) + "\n")
