"""``tdcv2.config.json`` — where a project's data packs live, written down instead of guessed.

A pack downloaded by the command-line tool lands in a folder the config names. If this
implementation did not read that file, a config using a downloaded pack would work in one language
and fail in another — a portability bug of the worst kind, because nothing is wrong with the config,
only with which runtime is asked to run it.

Resolution is a cascade, later levels overriding earlier ones: the global config, then the
project's. Paths accumulate — every root is searched — while a scalar like ``locale`` takes the
value from the highest level that set one. A relative path is relative to the config file that
contains it, the way a compiler's configuration behaves.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_NAME = "tdcv2.config.json"


class ConfigError(ValueError):
    """A config file that exists but cannot be used. Never silently ignored."""


@dataclass(frozen=True, slots=True)
class Resolved:
    data_paths: list[Path] = field(default_factory=list)
    locale: str | None = None
    pack_store: Path | None = None
    sources: list[Path] = field(default_factory=list)
    """The files that contributed, low level to high."""


def load(cwd: Path | None = None) -> Resolved:
    """The cascade, starting from a directory — usually the one the run was launched in."""
    data_paths: list[Path] = []
    sources: list[Path] = []
    locale: str | None = None
    pack_store: Path | None = None

    global_path = global_config_path()
    if global_path is not None and global_path.is_file():
        paths, locale_value, store = _read(global_path)
        data_paths.extend(paths)
        locale = locale_value or locale
        pack_store = store or pack_store
        sources.append(global_path)

    project_path = find_project_config(cwd)
    if project_path is not None:
        paths, locale_value, store = _read(project_path)
        data_paths.extend(paths)
        if locale_value:
            locale = locale_value  # the project overrides the global one
        if store:
            pack_store = store
        sources.append(project_path)

    return Resolved(data_paths, locale, pack_store, sources)


def global_config_path() -> Path | None:
    """The global config's location, following each platform's own convention.

    The same places the command-line tool writes to, because a config only one of them can find is
    worse than no config at all.
    """
    home = Path.home()
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        base = Path(app_data) if app_data else home / "AppData" / "Roaming"
        return base / "tdcv2" / "config.json"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else home / ".config"
    return base / "tdcv2" / "config.json"


def find_project_config(cwd: Path | None = None) -> Path | None:
    """The nearest ``tdcv2.config.json`` at or above this directory."""
    directory = (cwd or Path.cwd()).resolve()
    for candidate in [directory, *directory.parents]:
        config = candidate / CONFIG_NAME
        if config.is_file():
            return config
    return None


def register(config_path: Path, pack_roots: list[Path]) -> bool:
    """Pack roots added to a config's ``dataPaths``, creating the file if there is none.

    Written relative when the path sits under the config's own folder, the way the command-line
    tool writes them, so a checked-in config keeps working on another machine. Existing settings
    are preserved and duplicates dropped.

    Returns whether anything was actually added, so a caller can tell "installed and wired up"
    from "installed, and it was already wired up".
    """
    config_dir = config_path.resolve().parent
    document = _document(config_path)
    entries = [e for e in document.get("dataPaths", []) if isinstance(e, str)]

    for root in pack_roots:
        # De-duped by RESOLVED path, so an entry written "./x" and the same folder named
        # absolutely do not both land in the file.
        target = root.resolve()
        if not any(_against(config_dir, e).resolve() == target for e in entries):
            entries.append(_storable(config_dir, target))

    added = entries != document.get("dataPaths")
    document["dataPaths"] = entries
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return added


def storable(config_path: Path, target: Path) -> str:
    """How ``target`` would be written down in this config — relative to it, or absolute."""
    return _storable(config_path.resolve().parent, target)


def unregister(config_path: Path, pack_roots: list[Path]) -> bool:
    """The inverse of :func:`register`: pack roots dropped from a config's ``dataPaths``.

    Matched by resolved path, so an entry written relative and one written absolute both go. Returns
    whether the file changed. Removing a root does not remove data — a bundled pack covering the
    same addresses simply resurfaces, being a lower-priority root.
    """
    if not config_path.is_file():
        return False

    config_dir = config_path.resolve().parent
    document = _document(config_path)
    entries = [e for e in document.get("dataPaths", []) if isinstance(e, str)]
    targets = {root.resolve() for root in pack_roots}
    kept = [e for e in entries if _against(config_dir, e).resolve() not in targets]
    if len(kept) == len(entries):
        return False

    document["dataPaths"] = kept
    config_path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return True


def _document(path: Path) -> dict[str, object]:
    """The config as it is written, or an empty one.

    Kept WHOLE, and rewritten in place: every key the file already had survives in the order it
    was written, including keys this version knows nothing about. Rebuilding the document from
    the three settings we happen to parse would silently delete anything else a project put there.
    """
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise ConfigError(f'cannot read config "{path}": {e}') from e
    except json.JSONDecodeError as e:
        raise ConfigError(f'config "{path}" is not valid JSON: {e.msg}') from e
    if not isinstance(parsed, dict):
        raise ConfigError(f'config "{path}" must be a JSON object')
    return parsed


def _read(path: Path) -> tuple[list[Path], str | None, Path | None]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise ConfigError(f'cannot read config "{path}": {e}') from e
    except json.JSONDecodeError as e:
        raise ConfigError(f'config "{path}" is not valid JSON: {e.msg}') from e
    if not isinstance(parsed, dict):
        raise ConfigError(f'config "{path}" must be a JSON object')

    base = path.parent
    data_paths: list[Path] = []
    raw_paths = parsed.get("dataPaths")
    if raw_paths is not None:
        if not isinstance(raw_paths, list):
            raise ConfigError(f'config "{path}": "dataPaths" must be an array of strings')
        for entry in raw_paths:
            if not isinstance(entry, str) or not entry.strip():
                raise ConfigError(f'config "{path}": "dataPaths" entries must be non-empty strings')
            data_paths.append(_against(base, entry))

    locale = _text(parsed.get("locale"), path, "locale")
    store = _text(parsed.get("packStore"), path, "packStore")
    return data_paths, locale, _against(base, store) if store else None


def _text(value: object, path: Path, key: str) -> str | None:
    """A scalar string setting: absent, or present and non-empty. Nothing in between."""
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f'config "{path}": "{key}" must be a non-empty string')
    return value.strip()


def _against(base: Path, value: str) -> Path:
    candidate = Path(value.strip())
    return candidate if candidate.is_absolute() else Path(os.path.normpath(base / candidate))


def _storable(config_dir: Path, target: Path) -> str:
    """Relative when it sits under the config's folder; absolute when it does not.

    The relative form keeps the leading ``./`` the reference writes. It is the same path either
    way, but a config is a file people read and diff across implementations, so "the same" should
    also LOOK the same.
    """
    absolute = target.resolve()
    base = config_dir.resolve()
    if absolute == base:
        return "."
    try:
        return "./" + absolute.relative_to(base).as_posix()
    except ValueError:
        return str(absolute)
