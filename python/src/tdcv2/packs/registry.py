"""Data packs, fetched on demand from the registry every implementation shares.

The pack collection is a body of DATA with its own release rhythm, and it grows without bound —
every locale, every country, eventually every corpus. It lives in one repository, and each library
ships only a starter set: locale-agnostic packs, one language, one country. Everything past that is
downloaded.

One registry for all of them is the point. A locale added there appears in TypeScript, in Java and
in Python at once, and there is exactly one place to publish to. This is the Python client for it —
the same ``index.json``, the same bundle zips, the same digests and the same store layout, so a
project can be set up by whichever implementation happens to be at hand and used by any of the
others.
"""

from __future__ import annotations

import hashlib
import io
import json
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_BASE_URL = "https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master"

# The folder inside a bundle that is a pack scan root.
BUNDLE_PACKS_DIR = "packs"

_TIMEOUT_SECONDS = 60


class PackError(RuntimeError):
    """Anything that stops a bundle being installed, said plainly."""


@dataclass(frozen=True, slots=True)
class Bundle:
    """One downloadable bundle, as the registry's index describes it."""

    id: str
    name: str
    description: str
    file: str
    bytes: int
    sha256: str
    locale: str | None = None
    country: str | None = None
    contents: list[str] = field(default_factory=list)
    #: Continents a country belongs to, and roughly where it sits as (longitude, latitude).
    #:
    #: Both come from the registry so the interactive picker can group and plot a country without
    #: keeping a copy of world geography — the picker exists in three languages, and three copies
    #: would be three copies that drift. Absent for languages and for ``common``, and absent from
    #: an older index, which is why neither is required.
    regions: list[str] = field(default_factory=list)
    point: tuple[float, float] | None = None


@dataclass(frozen=True, slots=True)
class Index:
    schema_version: int
    description: str | None
    bundles: list[Bundle]

    def find(self, bundle_id: str) -> Bundle:
        for bundle in self.bundles:
            if bundle.id == bundle_id:
                return bundle
        known = ", ".join(b.id for b in self.bundles) or "(none)"
        raise PackError(f'unknown bundle "{bundle_id}". Available: {known}')


class Registry:
    __slots__ = ("base_url",)

    def __init__(self, base_url: str = DEFAULT_BASE_URL) -> None:
        self.base_url = base_url.rstrip("/")

    def index(self) -> Index:
        """The catalogue of what can be installed."""
        return parse_index(self._fetch(f"{self.base_url}/index.json").decode("utf-8"))

    def install(self, bundle: Bundle, store: Path) -> Path:
        """A bundle downloaded and unpacked into the store.

        The bytes are checked against the digest the registry published BEFORE anything is
        written. Data that arrives corrupted, or altered on the way, is refused rather than
        unpacked: a generator quietly fed the wrong names produces a dataset nobody can tell is
        wrong.

        A bundle's zip nests everything under its own top folder — ``en/packs/…`` — so it is
        unpacked into the STORE, not into ``<store>/<id>``: the archive already carries the id.
        Unpacking a level deeper would give ``<store>/en/en/packs`` and nothing would resolve.
        That layout is the registry's, shared by every implementation, so getting it wrong here
        breaks packs published for the others rather than only ours.

        Returns the pack root to register, ``<store>/<id>/packs``.
        """
        archive = self._fetch(f"{self.base_url}/{bundle.file}")
        if bundle.bytes > 0 and len(archive) != bundle.bytes:
            raise PackError(
                f'bundle "{bundle.id}": expected {bundle.bytes} bytes, got {len(archive)}'
            )
        digest = hashlib.sha256(archive).hexdigest()
        if digest.lower() != bundle.sha256.strip().lower():
            raise PackError(
                f'bundle "{bundle.id}" failed its checksum — download corrupt or tampered; '
                "not installed"
            )

        store.mkdir(parents=True, exist_ok=True)
        _unzip(archive, store)

        root = store / bundle.id / BUNDLE_PACKS_DIR
        if not root.is_dir():
            raise PackError(
                f'bundle "{bundle.id}" has no "packs" folder at its root — cannot register it'
            )
        return root

    def _fetch(self, url: str) -> bytes:
        try:
            with urllib.request.urlopen(url, timeout=_TIMEOUT_SECONDS) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise PackError(f"not found: {url}") from None
            raise PackError(f"{url} returned {e.code}") from None
        except OSError as e:
            raise PackError(f"cannot reach {url} ({e})") from e


def installed(store: Path) -> list[str]:
    """Bundle ids already in the store — a folder that carries a ``packs/`` directory."""
    if not store.is_dir():
        return []
    return sorted(p.name for p in store.iterdir() if (p / BUNDLE_PACKS_DIR).is_dir())


def parse_index(text: str) -> Index:
    """A registry index parsed and checked. Malformed input is a clear error, never a guess."""
    try:
        root = json.loads(text)
    except json.JSONDecodeError as e:
        raise PackError(f"registry index is not valid JSON: {e.msg}") from None
    if not isinstance(root, dict):
        raise PackError("registry index must be a JSON object")

    version = root.get("schemaVersion")
    if not isinstance(version, (int, float)) or isinstance(version, bool):
        raise PackError('registry index: "schemaVersion" must be a number')
    schema_version = round(version)
    if schema_version != 1:
        raise PackError(
            f"registry index: unsupported schemaVersion {schema_version} — update tdcv2"
        )
    raw = root.get("bundles")
    if not isinstance(raw, list):
        raise PackError('registry index: "bundles" must be an array')

    bundles = [_parse_bundle(entry, i) for i, entry in enumerate(raw)]
    return Index(schema_version, _optional(root.get("description"), "description"), bundles)


def _parse_bundle(raw: object, i: int) -> Bundle:
    if not isinstance(raw, dict):
        raise PackError(f"registry index: bundles[{i}] must be an object")

    size = raw.get("bytes")
    if not isinstance(size, (int, float)) or isinstance(size, bool) or size < 0:
        raise PackError(f"registry index: bundles[{i}].bytes must be a non-negative number")

    contents: list[str] = []
    raw_contents = raw.get("contents")
    if raw_contents is not None:
        if not isinstance(raw_contents, list):
            raise PackError(f"registry index: bundles[{i}].contents must be an array")
        contents = [
            _required(item, f"bundles[{i}].contents[{j}]") for j, item in enumerate(raw_contents)
        ]

    return Bundle(
        id=_required(raw.get("id"), f"bundles[{i}].id"),
        name=_required(raw.get("name"), f"bundles[{i}].name"),
        description="" if raw.get("description") is None else str(raw["description"]),
        file=_required(raw.get("file"), f"bundles[{i}].file"),
        bytes=int(size),
        sha256=_required(raw.get("sha256"), f"bundles[{i}].sha256").lower(),
        locale=_optional(raw.get("locale"), f"bundles[{i}].locale"),
        country=_optional(raw.get("country"), f"bundles[{i}].country"),
        contents=contents,
        regions=_regions(raw.get("regions"), i),
        point=_point(raw.get("point"), i),
    )


def _regions(value: object, i: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise PackError(f"registry index: bundles[{i}].regions must be an array")
    return [_required(item, f"bundles[{i}].regions[{j}]") for j, item in enumerate(value)]


def _point(value: object, i: int) -> tuple[float, float] | None:
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or len(value) != 2
        or any(not isinstance(n, (int, float)) or isinstance(n, bool) for n in value)
    ):
        raise PackError(f"registry index: bundles[{i}].point must be [longitude, latitude]")
    return (float(value[0]), float(value[1]))


def _required(value: object, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PackError(f"registry index: {what} must be a non-empty string")
    return value


def _optional(value: object, what: str) -> str | None:
    return None if value is None else _required(value, what)


def _unzip(archive: bytes, target: Path) -> None:
    """Unpacked, refusing any entry that would land outside the target.

    A zip can name ``../../etc/something``, and an extractor that trusts the name writes wherever
    it is told. The archive is data from the network; it does not get to choose paths.
    """
    root = target.resolve()
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        for entry in zf.infolist():
            destination = Path(root / entry.filename).resolve()
            if not (destination == root or root in destination.parents):
                raise PackError(f'bundle entry "{entry.filename}" would escape the pack store')
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(entry) as src, destination.open("wb") as out:
                out.write(src.read())
