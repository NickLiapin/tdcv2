"""The pack store: one flat tree, and the books that say who owns what in it.

Bundles are axis-pure — one language (``en``), or one country (``usa``), or ``common`` —
because language and country are independent dimensions that compose (US English is
common + en + usa). They all unpack into ONE tree, at the address path and nothing above
it::

    <store>/.tdcv2-installed.json
    <store>/common/…
    <store>/en/…
    <store>/countries/usa/…

The address path is the only level that has to exist, so it is the only level there is.
The store is then a single scan root, named once in ``dataPaths`` however many bundles
land in it, instead of a hundred near-duplicate roots for a hundred countries.

What that costs is the folder named after the bundle — the thing the old layout used to
know what was installed and what to delete. So the store keeps books instead: a dotfile
recording the paths each bundle owns. ``pack remove`` deletes exactly those, and
``pack list`` marks installed from the record rather than from a directory listing, which
means a tree somebody unpacked by hand is NOT installed: nothing records what it owns, so
nothing could remove it cleanly either.

Nothing here touches the network. The wire lives in :mod:`tdcv2.packs.registry` and the
printing in :mod:`tdcv2.cli.pack`, so what a bundle owns, whether a record is trustworthy
and what an old store has to become can all be tested without a byte leaving the machine.
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from . import project_config

#: The folder inside a bundle's zip that holds its pack tree, and the level the old
#: per-bundle layout put on disk.
BUNDLE_PACKS_DIR = "packs"

#: The store's bookkeeping file.
#:
#: A DOTFILE because it sits at the root of a scan root, and the pack loader skips ignored
#: NAMES rather than unknown extensions — a plain ``installed.json`` here would be read as
#: a pack at address ``installed``.
INSTALLED_FILE = ".tdcv2-installed.json"

#: Bumped only if the record's shape changes in a way older tools misread.
INSTALLED_SCHEMA_VERSION = 1


class PackError(RuntimeError):
    """Anything that stops a bundle being installed, said plainly."""


@dataclass(frozen=True, slots=True)
class InstalledBundle:
    """One bundle as the store has it."""

    id: str
    #: The paths this bundle owns, relative to the store and always ``/``-separated.
    #: ``pack remove`` deletes exactly these; a bundle sharing a tree with others cannot
    #: be found by looking for a folder with its name.
    paths: list[str] = field(default_factory=list)
    #: What the registry called this revision, or ``""`` when it called it nothing.
    version: str = ""
    #: Digest of the archive it came from; ``""`` for an install migrated from the old layout.
    sha256: str = ""
    #: How many files it wrote.
    files: int = 0


@dataclass(frozen=True, slots=True)
class InstalledRecord:
    """The bookkeeping file's contents."""

    schema_version: int = INSTALLED_SCHEMA_VERSION
    #: Sorted by id, so the file is stable to diff.
    bundles: list[InstalledBundle] = field(default_factory=list)


def installed_file_path(store: Path) -> Path:
    """Where the bookkeeping file lives."""
    return store / INSTALLED_FILE


def read_installed(store: Path) -> InstalledRecord:
    """The store's books.

    A missing file means an empty store; a malformed one is an ERROR rather than an empty
    store, because "nothing is installed" would make ``pack remove`` claim there is nothing
    to delete while the files sit there.
    """
    path = installed_file_path(store)
    if not path.is_file():
        return InstalledRecord()
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise PackError(
            f'pack store record "{path}" is not valid JSON: {e.msg}. '
            "Delete it and re-add your bundles."
        ) from None
    except OSError as e:
        raise PackError(f'cannot read pack store record "{path}": {e}') from e
    if not isinstance(parsed, dict):
        raise PackError(f'pack store record "{path}" must be a JSON object')

    version = parsed.get("schemaVersion")
    if not isinstance(version, (int, float)) or isinstance(version, bool):
        raise PackError(f'pack store record "{path}": "schemaVersion" must be a number')
    schema_version = round(version)
    if schema_version > INSTALLED_SCHEMA_VERSION:
        raise PackError(
            f'pack store record "{path}" was written by a newer tdcv2 '
            f"(schemaVersion {schema_version}) — update tdcv2"
        )
    raw = parsed.get("bundles")
    if not isinstance(raw, list):
        raise PackError(f'pack store record "{path}": "bundles" must be an array')

    bundles = [_parse_installed(entry, i, path, store) for i, entry in enumerate(raw)]
    return InstalledRecord(schema_version, _sorted_by_id(bundles))


def _parse_installed(raw: object, i: int, path: Path, store: Path) -> InstalledBundle:
    if not isinstance(raw, dict):
        raise PackError(f'pack store record "{path}": bundles[{i}] must be an object')
    bundle_id = _text(raw.get("id"), path, f"bundles[{i}].id")
    raw_paths = raw.get("paths")
    if not isinstance(raw_paths, list):
        raise PackError(f'pack store record "{path}": bundles[{i}].paths must be an array')

    paths: list[str] = []
    for j, entry in enumerate(raw_paths):
        value = _text(entry, path, f"bundles[{i}].paths[{j}]")
        # Everything in here is deleted verbatim by `pack remove`, so a hand-edited or
        # hostile record must not be able to point outside the store.
        if Path(value).is_absolute() or not is_path_inside(store / value, store):
            raise PackError(
                f'pack store record "{path}": bundle "{bundle_id}" '
                f'claims a path outside the store: "{value}"'
            )
        paths.append(value)

    return InstalledBundle(
        id=bundle_id,
        paths=paths,
        version=raw["version"] if isinstance(raw.get("version"), str) else "",
        sha256=raw["sha256"] if isinstance(raw.get("sha256"), str) else "",
        files=(
            round(raw["files"])
            if isinstance(raw.get("files"), (int, float)) and not isinstance(raw.get("files"), bool)
            else 0
        ),
    )


def _text(value: object, path: Path, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PackError(f'pack store record "{path}": {what} must be a non-empty string')
    return value


def _sorted_by_id(bundles: Sequence[InstalledBundle]) -> list[InstalledBundle]:
    return sorted(bundles, key=lambda b: b.id)


def write_installed(store: Path, record: InstalledRecord) -> None:
    """The store's books written down, ids sorted so re-installing the same set is a no-diff."""
    store.mkdir(parents=True, exist_ok=True)
    document = {
        "schemaVersion": INSTALLED_SCHEMA_VERSION,
        "bundles": [
            {
                "id": bundle.id,
                "paths": list(bundle.paths),
                "version": bundle.version,
                "sha256": bundle.sha256,
                "files": bundle.files,
            }
            for bundle in _sorted_by_id(record.bundles)
        ],
    }
    installed_file_path(store).write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def with_bundle(record: InstalledRecord, entry: InstalledBundle) -> InstalledRecord:
    """The record with ``entry`` in place of any earlier install of the same id."""
    kept = [b for b in record.bundles if b.id != entry.id]
    return InstalledRecord(INSTALLED_SCHEMA_VERSION, _sorted_by_id([*kept, entry]))


def without_bundle(record: InstalledRecord, bundle_id: str) -> InstalledRecord:
    """The record without ``bundle_id``."""
    return InstalledRecord(
        INSTALLED_SCHEMA_VERSION, [b for b in record.bundles if b.id != bundle_id]
    )


def find_bundle(record: InstalledRecord, bundle_id: str) -> InstalledBundle | None:
    """The record's entry for one id, or nothing."""
    return next((b for b in record.bundles if b.id == bundle_id), None)


def installed(store: Path) -> list[str]:
    """Bundle ids the store has, from its books.

    A missing store is nothing installed rather than an error — the folder is created by the
    first install, and asking before then is a perfectly ordinary thing to do.
    """
    return sorted(b.id for b in read_installed(store).bundles)


def bundle_owned_paths(files: Sequence[str]) -> list[str]:
    """The paths a bundle owns, given every file it carries (store-relative, ``/``-separated).

    Usually one path: every file of ``ru`` sits under ``ru/`` and every file of ``russia``
    under ``countries/russia/``, so the longest shared directory IS the subtree the bundle
    owns — and ``countries/``, which several bundles share, is correctly claimed by none of
    them. A bundle whose files diverge at the top level owns each of those top-level entries
    instead, which keeps the answer an antichain: no owned path contains another.
    """
    if not files:
        return []
    directories = [f.split("/")[:-1] for f in files]
    common = list(directories[0])
    for parts in directories[1:]:
        shared = 0
        while shared < len(common) and shared < len(parts) and common[shared] == parts[shared]:
            shared += 1
        del common[shared:]
        if not common:
            break
    if common:
        return ["/".join(common)]
    return sorted({f.split("/")[0] for f in files} - {""})


def is_path_inside(child: Path, parent: Path) -> bool:
    """Whether ``child`` is ``parent`` itself or sits under it. Guards zip-slip."""
    return child.resolve().is_relative_to(parent.resolve())


def walk_relative(directory: Path) -> list[str]:
    """Every file under ``directory``, as ``/``-separated relative paths, sorted.

    Dotfiles included: ``_locale.json`` and anything else the packs carry has to travel with
    them, and deciding what is "really" data is the loader's job, not this one's.
    """
    if not directory.is_dir():
        return []
    return sorted(
        entry.relative_to(directory).as_posix() for entry in directory.rglob("*") if entry.is_file()
    )


def prune_empty_dirs(directory: Path, stop_at: Path) -> None:
    """``directory`` and every parent left empty behind it, up to but never ``stop_at`` itself."""
    current = directory.resolve()
    root = stop_at.resolve()
    while current != root and current.is_relative_to(root):
        try:
            if any(current.iterdir()):
                return
            current.rmdir()
        except OSError:
            return
        current = current.parent


def delete_owned_paths(store: Path, paths: Sequence[str]) -> None:
    """The paths a bundle owns deleted, and any parent left empty behind them."""
    for rel in paths:
        target = store / rel
        # The record is a file on disk and may have been edited; a path that does not resolve
        # inside the store is not deleted on its say-so.
        if not is_path_inside(target, store) or target.resolve() == store.resolve():
            raise PackError(f'refusing to delete "{rel}": it is not inside the pack store')
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)
        prune_empty_dirs(target.parent, store)


def plan_extract(archive: bytes, bundle_id: str, store: Path) -> tuple[list[str], dict[str, bytes]]:
    """What a bundle's zip would put where, decided before a single byte is written.

    The archive nests everything under ``<id>/packs/``, which is the bundler's business and
    not the user's: those two levels are stripped here so the address path lands directly in
    the store and ``ru/person/lastName.txt`` is what appears under it. Every entry must carry
    that prefix — an archive that is not the bundle it claims to be, or that carries something
    beside its packs, is refused whole rather than scattered into a shared tree that nothing
    could then take apart again.
    """
    try:
        archive_file = zipfile.ZipFile(io.BytesIO(archive))
    except zipfile.BadZipFile as e:
        raise PackError(f'bundle "{bundle_id}" is not a valid zip: {e}') from None

    prefix = f"{bundle_id}/{BUNDLE_PACKS_DIR}/"
    files: dict[str, bytes] = {}
    rels: list[str] = []
    with archive_file:
        for entry in archive_file.infolist():
            name = entry.filename
            if name.endswith("/"):
                continue
            if not name.startswith(prefix):
                raise PackError(
                    f'bundle "{bundle_id}" carries "{name}", which is not under '
                    f'"{prefix}" — refusing to unpack it'
                )
            rel = name[len(prefix) :]
            if not rel:
                continue
            # Zip-slip, checked here rather than at the write: an archive with one escaping
            # path must not first lay down the files that came before it.
            if not is_path_inside(store / rel, store):
                raise PackError(f'bundle "{bundle_id}" contains an unsafe path: {rel}')
            files[rel] = archive_file.read(entry)
            rels.append(rel)

    if not rels:
        raise PackError(f'bundle "{bundle_id}" has no files under "{prefix}"')
    return sorted(rels), files


def write_extract(files: dict[str, bytes], store: Path) -> None:
    """A planned extract written into the store. Every path was checked by the plan."""
    for rel, data in files.items():
        destination = store / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def assert_no_overlap(bundle_id: str, paths: Sequence[str], record: InstalledRecord) -> None:
    """Refuse a bundle that would write into a path another one owns.

    The registry's bundles are axis-pure and no two of them name the same path, so this never
    fires on the real catalogue — it fires on a hand-built or renamed archive, where the
    alternative is two bundles interleaved in one tree and a ``pack remove`` that takes half
    of the other with it.
    """
    for other in record.bundles:
        if other.id == bundle_id:
            continue
        for mine in paths:
            for theirs in other.paths:
                if mine == theirs or mine.startswith(f"{theirs}/") or theirs.startswith(f"{mine}/"):
                    raise PackError(
                        f'bundle "{bundle_id}" would write into "{mine}", which '
                        f'"{other.id}" already owns — remove "{other.id}" first'
                    )


# ── migrating a store written by an older tdcv2 ──────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StoreMove:
    """One bundle's tree, moved out of its old folder."""

    id: str
    #: Store-relative source, e.g. ``ru/packs``.
    source: str
    #: Store-relative destinations, e.g. ``["ru"]``.
    to: list[str]
    files: int


@dataclass(frozen=True, slots=True)
class StoreMigration:
    """What :func:`migrate_store` did, for the caller to report."""

    store: Path
    moves: list[StoreMove]
    #: Files that were in a bundle's old folder but OUTSIDE its ``packs/`` tree. They belong
    #: to no pack address, so they are left exactly where they are rather than guessed at or
    #: deleted.
    leftovers: list[str]
    dropped_data_paths: int
    #: The store, as written into ``dataPaths``; ``None`` if it was already there.
    registered: str | None


def legacy_bundle_ids(store: Path) -> list[str]:
    """Bundle folders in the old layout: ``<store>/<id>/packs/…``."""
    if not store.is_dir():
        return []
    return sorted(
        entry.name
        for entry in store.iterdir()
        if entry.is_dir() and (entry / BUNDLE_PACKS_DIR).is_dir()
    )


def migrate_store(store: Path, config_path: Path) -> StoreMigration | None:
    """A store written by an older tdcv2 moved into the flat layout, in place.

    Returns ``None`` when there is nothing to move. Everything is PLANNED before anything
    moves: a store half in one layout and half in the other is worse than one that refused and
    said why, and the refusal costs the user only the two minutes it takes to move the
    offending file themselves.

    Anyone who ran ``pack add`` before the flat store has ``<store>/<id>/packs/…`` on disk and
    one ``dataPaths`` entry per bundle in their config; both are fixed here, so the first
    ``tdcv2 pack`` after an upgrade is all it takes.
    """
    ids = legacy_bundle_ids(store)
    if not ids:
        return None

    planned: dict[Path, Path] = {}
    claimed_by: dict[Path, str] = {}
    per_bundle: list[tuple[str, list[str]]] = []
    conflicts: list[str] = []
    leftovers: list[str] = []

    for bundle_id in ids:
        packs_root = store / bundle_id / BUNDLE_PACKS_DIR
        rels = walk_relative(packs_root)
        per_bundle.append((bundle_id, rels))
        # Read before anything moves: a bundle whose tree lands back under its own name
        # (`ru/packs/ru` → `ru`) would otherwise report its own data as a leftover the moment
        # it arrived.
        for rel in walk_relative(store / bundle_id):
            if not rel.startswith(f"{BUNDLE_PACKS_DIR}/"):
                leftovers.append(f"{bundle_id}/{rel}")

        for rel in rels:
            destination = store / rel
            if not is_path_inside(destination, store):
                conflicts.append(f'{bundle_id}: "{rel}" would land outside the store')
                continue
            owner = claimed_by.get(destination)
            if owner is not None:
                conflicts.append(f'{rel}: claimed by both "{owner}" and "{bundle_id}"')
                continue
            if destination.exists():
                conflicts.append(f"{rel}: something is already there")
                continue
            # Landing inside another bundle's old folder would move a file out from under a
            # move still to come.
            if any(
                other != bundle_id and is_path_inside(destination, store / other / BUNDLE_PACKS_DIR)
                for other in ids
            ):
                conflicts.append(f"{rel}: it would land inside another bundle's old folder")
                continue
            planned[destination] = packs_root / rel
            claimed_by[destination] = bundle_id

    if conflicts:
        shown = [f"  {c}" for c in conflicts[:5]]
        if len(conflicts) > 5:
            shown.append(f"  … and {len(conflicts) - 5} more")
        raise PackError(
            f'cannot move the pack store "{store}" to the flat layout — '
            f"{len(conflicts)} path(s) collide:\n" + "\n".join(shown) + "\n"
            "Nothing was moved. Clear those paths, or delete the store and run "
            "`tdcv2 pack add` again."
        )

    for destination, origin in planned.items():
        destination.parent.mkdir(parents=True, exist_ok=True)
        _move_file(origin, destination)

    record = read_installed(store)
    moves: list[StoreMove] = []
    for bundle_id, rels in per_bundle:
        paths = bundle_owned_paths(rels)
        record = with_bundle(record, InstalledBundle(bundle_id, paths, "", "", len(rels)))
        moves.append(StoreMove(bundle_id, f"{bundle_id}/{BUNDLE_PACKS_DIR}", paths, len(rels)))
        _prune_empty_tree(store / bundle_id / BUNDLE_PACKS_DIR)
        _prune_empty_tree(store / bundle_id)
    write_installed(store, record)

    dropped = project_config.remove_data_paths_inside(config_path, store)
    stored = project_config.storable(config_path, store)
    added = project_config.register(config_path, [store])
    return StoreMigration(store, moves, leftovers, dropped, stored if added else None)


def _move_file(origin: Path, destination: Path) -> None:
    """One file moved, falling back to copy-and-delete if the store spans two devices."""
    try:
        origin.replace(destination)
    except OSError:
        shutil.copyfile(origin, destination)
        origin.unlink()


def _prune_empty_tree(directory: Path) -> bool:
    """Every empty directory in ``directory``'s subtree deleted, and ``directory`` with them if
    that leaves it empty. Returns whether it is gone.

    Moving files out leaves the whole shape of the old tree behind, and empty folders in a scan
    root are noise a user then has to wonder about.
    """
    try:
        entries = list(directory.iterdir())
    except OSError:
        return False
    empty = True
    for entry in entries:
        if not entry.is_dir() or not _prune_empty_tree(entry):
            empty = False
    if not empty:
        return False
    try:
        directory.rmdir()
    except OSError:
        return False
    return True
