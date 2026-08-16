"""Where pack files come from.

Two places, and both have to work. The library ships a small set of packs inside the wheel so that
``person.male.firstName`` resolves with nothing configured — a library that needed a data directory
pointed at it before it could produce a single name would be a poor library. The other place is a
folder on disk, which is how this repository's tests read the same packs the other implementations
read, and how a project adds a downloaded or hand-written one.

Only the starter set is bundled: ``common``, ``en``, and the USA country pack. Everything else is
downloaded on demand from the shared registry, because the full catalogue is far larger than any
library has business carrying and it keeps growing.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

# Where the build puts the bundled packs inside the package.
BUNDLED_DIR = "packs_data"
INDEX_NAME = "index.txt"


def is_ignored_entry(name: str) -> bool:
    """Whether a directory entry is repository noise rather than a pack.

    This runs over directory names too, so it must not look at extensions — that is
    :func:`is_pack_file`'s job. It is the same short list ``load.ts`` keeps.
    """
    if name == "_locale.json" or name.startswith("."):
        return True
    stem, dot, _ = name.lower().rpartition(".")
    return (stem if dot else name.lower()) in {"readme", "license", "changelog"}


#: The two extensions a pack FILE can carry: ``.txt`` for a list or a generator written in a
#: header, ``.tdc`` for a generator written as a config.
PACK_FILE_EXTENSIONS = frozenset({".txt", ".tdc"})


def is_pack_file(name: str) -> bool:
    """Whether a file name is a pack file rather than metadata sitting beside one.

    This used to allow everything — the spec said a data file's extension is ignored, written
    before a pack carried anything but data. Once ``DATE_LOCALE.json`` arrived, fifteen locales
    silently grew an address (``bn.DATE_LOCALE``, ``hu.DATE_LOCALE``, …) whose values were the
    lines of the JSON source: ``{``, ``"months": [``, ``"Január",``. No diagnostic, because
    nothing was malformed — a file was read as a list, which is what the loader was told to do
    with any file it found. An allowlist rather than a ``.json`` denylist, so the next metadata
    file to be added does not have to remember to come here first.
    """
    stem, dot, extension = name.rpartition(".")
    return bool(dot) and bool(stem) and f".{extension.lower()}" in PACK_FILE_EXTENSIONS


class Source(Protocol):
    """Whatever can answer "is there a pack at this path, and what is in it"."""

    def has(self, relative_path: str) -> bool:
        """Whether a pack exists at e.g. ``en/person/lastName.txt``."""
        ...

    def read_lines(self, relative_path: str) -> list[str]: ...

    def has_top_level(self, name: str) -> bool:
        """Whether a top-level folder by this name exists — ``en``, ``common``.

        This is how a dotted address is judged absolute or relative: ``usa.ssn`` names a country
        pack directly, while ``person.lastName`` is relative to the active locale.
        """
        ...

    def list_files(self) -> list[str]:
        """Every pack file this source can serve, as relative paths.

        The address index is built from this: a file's header may place it at an address that
        has nothing to do with its path, and the only way to know is to look inside every file.
        """
        ...

    def has_country(self, name: str) -> bool:
        """Whether ``countries/<name>`` exists.

        The ``countries/`` folder is a physical grouping, not part of an address: a pack at
        ``countries/usa/finance/aba_routing.txt`` is addressed as ``usa.finance.aba_routing``.
        Without this, every country pack would look like a relative address and be searched for
        under the active locale, where it is not.
        """
        ...

    def locate(self, relative_path: str) -> str | None:
        """Where a file physically is, for a complaint that has to name it.

        A relative path is ambiguous the moment two roots are layered, and "which file did you
        mean" is the one thing such a message must not leave open. Packs shipped inside the
        wheel have no path at all, which is why this can answer nothing.
        """
        ...


class Directory:
    """Packs from a folder on disk."""

    __slots__ = ("root",)

    def __init__(self, root: Path) -> None:
        self.root = root

    def has(self, relative_path: str) -> bool:
        return (self.root / relative_path).exists()

    def read_lines(self, relative_path: str) -> list[str]:
        return (self.root / relative_path).read_text(encoding="utf-8").split("\n")

    def list_files(self) -> list[str]:
        found = []
        for path in self.root.rglob("*"):
            if not path.is_file():
                continue
            relative = str(path.relative_to(self.root)).replace("\\", "/")
            parts = relative.split("/")
            if any(is_ignored_entry(part) for part in parts):
                continue
            if not is_pack_file(parts[-1]):
                continue
            found.append(relative)
        return sorted(found)

    def has_top_level(self, name: str) -> bool:
        return (self.root / name).is_dir()

    def has_country(self, name: str) -> bool:
        return (self.root / "countries" / name).is_dir()

    def locate(self, relative_path: str) -> str | None:
        path = self.root / relative_path
        return str(path) if path.is_file() else None

    def __str__(self) -> str:
        return str(self.root)


class Bundled:
    """The packs shipped inside the wheel.

    An index file is read rather than the directory listed, for the same reason Java reads one:
    a package may be installed as a zip, where there is nothing to list, and probing per candidate
    would make "does the locale ``sv`` exist?" unanswerable — the only way to find out would be to
    guess a filename inside it.
    """

    __slots__ = ("_countries", "_index", "_root", "_top_level")

    def __init__(self) -> None:
        self._root = Path(__file__).resolve().parent.parent / BUNDLED_DIR
        self._index: set[str] = set()
        self._top_level: set[str] = set()
        self._countries: set[str] = set()

        index_file = self._root / INDEX_NAME
        if index_file.is_file():
            for line in index_file.read_text(encoding="utf-8").splitlines():
                path = line.strip()
                if not path:
                    continue
                self._index.add(path)
                head, _, rest = path.partition("/")
                if rest:
                    self._top_level.add(head)
                if head == "countries":
                    country, _, tail = rest.partition("/")
                    if tail:
                        self._countries.add(country)
        # No index at all means a wheel built without packs. Every lookup then fails by name,
        # which is a far better outcome than silently producing rows with empty fields.

    def has(self, relative_path: str) -> bool:
        return relative_path in self._index

    def read_lines(self, relative_path: str) -> list[str]:
        target = self._root / relative_path
        if not target.is_file():
            raise ValueError(f"bundled pack is missing: {relative_path}")
        return target.read_text(encoding="utf-8").split("\n")

    def list_files(self) -> list[str]:
        return sorted(self._index)

    def has_top_level(self, name: str) -> bool:
        return name in self._top_level

    def has_country(self, name: str) -> bool:
        return name in self._countries

    def locate(self, relative_path: str) -> str | None:
        path = self._root / relative_path
        return str(path) if path.is_file() else None

    def __str__(self) -> str:
        return f"bundled packs ({len(self._index)} files)"


class Layered:
    """Several sources searched in order, the last one winning.

    This is what lets a project's own packs shadow the bundled ones without replacing them: a
    downloaded or hand-written pack at the same address is found first, and everything else still
    resolves. The order is low priority to high, so the search runs backwards.
    """

    __slots__ = ("sources",)

    def __init__(self, sources: list[Source]) -> None:
        self.sources = list(sources)

    def _owning(self, relative_path: str) -> Source | None:
        for source in reversed(self.sources):
            if source.has(relative_path):
                return source
        return None

    def has(self, relative_path: str) -> bool:
        return self._owning(relative_path) is not None

    def read_lines(self, relative_path: str) -> list[str]:
        source = self._owning(relative_path)
        if source is None:
            raise ValueError(f"no pack at {relative_path}")
        return source.read_lines(relative_path)

    def list_files(self) -> list[str]:
        seen: list[str] = []
        for source in self.sources:
            for path in source.list_files():
                if path not in seen:
                    seen.append(path)
        return seen

    def has_top_level(self, name: str) -> bool:
        return any(source.has_top_level(name) for source in self.sources)

    def has_country(self, name: str) -> bool:
        return any(source.has_country(name) for source in self.sources)

    def locate(self, relative_path: str) -> str | None:
        source = self._owning(relative_path)
        return None if source is None else source.locate(relative_path)

    def __str__(self) -> str:
        return ", ".join(str(source) for source in self.sources)


#: The folder that makes a directory recognisably THIS repository. Walking up for a bare
#: ``data/packs`` is not enough: the name is ordinary enough that an unrelated folder above an
#: installed package could answer, and then the same config would read different data depending on
#: where the user happened to install it. ``fixtures/cross-language`` holds the contract all five
#: implementations are tested against, and exists here and nowhere else.
CHECKOUT_MARKER = ("fixtures", "cross-language")


def source_checkout_packs(start_from: Path) -> Path | None:
    """``<repo>/data/packs``, if this code is running out of a TDC source checkout.

    In a checkout that folder is the copy every implementation reads and the one a contributor
    edits, so finding it is what keeps all five seeing the same data instead of five copies free to
    drift. An installed wheel has no repository above it, the walk finds nothing, and the packs
    inside the wheel answer instead.
    """
    current = start_from.resolve()
    while True:
        if current.joinpath(*CHECKOUT_MARKER).is_dir():
            packs = current / "data" / "packs"
            if packs.is_dir():
                return packs
        if current.parent == current:
            return None
        current = current.parent


def discover() -> Source:
    """Where a run's packs start from, before any config or command line adds to them.

    The same three questions, in the same order, in all five implementations: ``TDCV2_PACKS`` if it
    names a folder, then the source checkout this build came from, then the starter set shipped
    inside the package.
    """
    from_env = os.environ.get("TDCV2_PACKS", "").strip()
    if from_env and Path(from_env).is_dir():
        return Directory(Path(from_env))

    checkout = source_checkout_packs(Path(__file__))
    if checkout is not None:
        return Directory(checkout)

    return Bundled()
