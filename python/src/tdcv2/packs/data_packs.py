"""Reading data packs.

A pack is a text file: an optional ``---`` header, then one value per line. With ``weighted: true``
each line is ``value,count`` instead, and the counts become exact proportions rather than
probabilities — the same machinery ``percent=`` uses. That is why a run of 30,000 rows from the SSA
name file contains precisely as many Jameses as the census says, not approximately.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import project_config, source
from .registry import Registry
from .source import Source


@dataclass(frozen=True, slots=True)
class Entry:
    """A loaded pack.

    ``percents`` is absent unless the pack is weighted. ``generator`` is absent unless the pack
    describes how to BUILD a value instead of listing values — listing every UUID is not a thing
    anyone can do.
    """

    values: list[str]
    percents: list[float] | None = None
    generator: str | None = None

    @property
    def weighted(self) -> bool:
        return self.percents is not None

    @property
    def is_generator(self) -> bool:
        return self.generator is not None


class DataPacks:
    """Where a run's data comes from: the packs, and the folders a file source may name.

    The two travel together because they answer the same question and come from the same place —
    ``--data-path`` on the command line, and ``dataPaths`` in ``tdcv2.config.json``, feed both.
    Keeping the folders here is also what lets every engine and the validator reach them: they are
    already handed a ``DataPacks``, so nothing new has to be threaded through fifteen signatures.
    """

    __slots__ = ("_cache", "_index", "data_roots", "source")

    def __init__(self, from_source: Source | Path, data_roots: list[Path] | None = None) -> None:
        self.source: Source = (
            source.Directory(from_source) if isinstance(from_source, Path) else from_source
        )
        self._cache: dict[tuple[str, str], Entry] = {}
        #: address -> relative file path, built on first use. ``None`` until then: most runs
        #: resolve every address straight from the path and never pay for the scan.
        self._index: dict[str, str] | None = None
        #: Folders searched by ``src="@data/…"``, and by a relative ``src=`` the config's own
        #: folder does not hold. Highest priority last, as the layers are.
        self.data_roots: list[Path] = list(data_roots or [])

    @staticmethod
    def bundled() -> DataPacks:
        """The packs the library ships with — the default, and no configuration needed."""
        return DataPacks(source.Bundled())

    @staticmethod
    def for_project(cwd: Path | None = None, extra_roots: list[Path] | None = None) -> DataPacks:
        """The bundled packs plus whatever ``tdcv2.config.json`` adds, searched from here upward.

        A pack downloaded into a project belongs to the project, not to whichever runtime happens
        to read it. Honouring the same config file the command-line tool writes is what keeps a
        config that uses a downloaded pack working in every implementation rather than only the one
        that fetched it.

        ``extra_roots`` are named at the call site — the command line's ``--data-path`` — and go on
        last, so they shadow both the config's roots and the bundled packs. Something typed for
        this one run should beat something written down for every run.
        """
        layers: list[Source] = [source.Bundled()]
        config = project_config.load(cwd)
        layers.extend(source.Directory(d) for d in config.data_paths if d.is_dir())
        # The pack STORE is deliberately not a scan root. Bundles land in `<store>/<id>/` and each
        # registers its own `packs` folder in `dataPaths`; scanning the store as well would make
        # every installed bundle's ID look like a top-level namespace, so `france.docs.nir` would
        # be looked up as `france/docs/nir.txt` instead of `countries/france/docs/nir.txt` and a
        # country pack would stop resolving the moment it was installed.
        for root in extra_roots or []:
            if root.is_dir():
                layers.append(source.Directory(root))

        roots = [*config.data_paths, *(extra_roots or [])]
        if len(layers) == 1:
            return DataPacks(source.Bundled(), roots)
        return DataPacks(source.Layered(layers), roots)

    @staticmethod
    def install(cwd: Path | None, *bundle_ids: str, registry: Registry | None = None) -> DataPacks:
        """A bundle installed from the shared registry into this project, and registered.

        The one call a Python project needs to add a locale: it downloads, verifies the digest,
        unpacks into the project's pack store, and writes the path into ``tdcv2.config.json`` so
        the next run finds it — and so any other implementation working in the same project finds
        it too. The registry is shared, so this is not a Python-only mechanism reimplemented; it is
        the same catalogue, the same archives and the same store the command-line tool uses.
        """
        project = (cwd or Path.cwd()).resolve()
        config_path = project_config.find_project_config(project)
        config_dir = config_path.parent if config_path else project
        resolved = project_config.load(project)
        store = resolved.pack_store or config_dir / "tdcv2-packs"

        client = registry or Registry()
        index = client.index()
        roots = [client.install(index.find(bundle_id), store) for bundle_id in bundle_ids]
        project_config.register(config_path or config_dir / project_config.CONFIG_NAME, roots)
        return DataPacks.for_project(project)

    def load(self, dotted_path: str, locale: str) -> Entry:
        """A dotted address resolved against a locale, and loaded.

        If the first segment names a locale, a country, or a reserved bucket, the address is
        already absolute; otherwise the active locale is prepended, so ``person.lastName`` under
        ``ru`` is a Russian surname. The first segment is checked against the folders that actually
        exist, and a name that matches none of them fails loudly rather than being guessed at.
        """
        key = (dotted_path, locale)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        first = dotted_path.split(".", 1)[0]
        if self.source.has_top_level(first):
            file = dotted_path.replace(".", "/") + ".txt"
        elif self.source.has_country(first):
            # A country is absolute too, but its files live under the countries/ grouping, which
            # is not part of the address anyone writes.
            file = "countries/" + dotted_path.replace(".", "/") + ".txt"
        else:
            file = (locale + "." + dotted_path).replace(".", "/") + ".txt"

        if not self.source.has(file):
            # The path did not answer, so ask the headers: a file may declare its own
            # ``address:`` and then live anywhere at all — which is how a user keeps a flat
            # folder of their own lists. Scanned once, on demand, so the ordinary run where
            # every address matches its path never pays for it.
            placed = self._addresses().get(self._absolute(dotted_path, locale))
            if placed is not None:
                entry = _parse(self.source.read_lines(placed), placed)
                self._cache[key] = entry
                return entry
            raise ValueError(
                f'unknown template path "{dotted_path}" (looked for {file} in {self.source})'
            )

        entry = _parse(self.source.read_lines(file), file)
        self._cache[key] = entry
        return entry

    def _absolute(self, dotted_path: str, locale: str) -> str:
        """The address as the index holds it: locale-prefixed unless already absolute."""
        first = dotted_path.split(".", 1)[0]
        if self.source.has_top_level(first) or self.source.has_country(first):
            return dotted_path
        return f"{locale}.{dotted_path}"

    def _addresses(self) -> dict[str, str]:
        """Every pack file's address, read from its header — built once, kept.

        A header may carry ``address:`` (authoritative) and ``locale:`` (used only when the
        path-derived address has no locale of its own). Files that resolve to neither a locale,
        a country nor a reserved bucket are not addressable and are left out, the same rule the
        reference applies.
        """
        if self._index is not None:
            return self._index
        index: dict[str, str] = {}
        for file in self.source.list_files():
            header = _header_of(self.source.read_lines(file))
            declared = header.get("address", "").strip()
            if declared:
                address = declared
            else:
                address = file[:-4].replace("/", ".") if file.endswith(".txt") else file
                if address.startswith("countries."):
                    address = address[len("countries.") :]
                head = address.split(".", 1)[0]
                if not (self.source.has_top_level(head) or self.source.has_country(head)):
                    # Not under a locale folder: the header's own ``locale:`` is the only
                    # thing that can say where this belongs.
                    declared_locale = header.get("locale", "").strip()
                    if not declared_locale:
                        continue
                    address = f"{declared_locale}.{address}"
            index[address] = file
        self._index = index
        return index

    def addresses(self) -> list[str]:
        """Every address these packs can answer to, in no particular order.

        The quick API needs the whole list rather than a yes-or-no about one
        address: to say "did you mean" it has to compare what was typed against
        all of them. Building the index is the cost of the first call only.
        """
        return list(self._addresses())

    def exists(self, dotted_path: str, locale: str) -> bool:
        """Whether an address resolves, without loading it.

        The validator asks this so a misspelled address is caught before the run rather than on
        its first row.
        """
        try:
            self.load(dotted_path, locale)
        except (ValueError, OSError):
            return False
        return True


def _header_of(lines: list[str]) -> dict[str, str]:
    """Just the ``---`` fenced header, for the address scan: no body, no validation."""
    if not lines or lines[0].strip() != "---":
        return {}
    header: dict[str, str] = {}
    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        header[key.strip().lower()] = value.strip()
    return header


def _parse(lines: list[str], file: str) -> Entry:
    header: dict[str, str] = {}
    start = 0
    if lines and lines[0].strip() == "---":
        end = 1
        while end < len(lines) and lines[end].strip() != "---":
            key, sep, value = lines[end].partition(":")
            if sep and key.strip():
                header[key.strip()] = value.strip()
            end += 1
        start = end + 1

    body = [line for line in lines[start:] if line.strip()]

    # `generator: tdc` marks a pack whose body is a <gen> tag rather than a list of values. Some
    # things cannot be listed — a UUID, an account number — so the pack ships the rule instead.
    if header.get("generator") == "tdc":
        return Entry([], None, "\n".join(body))

    if header.get("weighted") != "true":
        return Entry(list(body))

    delimiter = header.get("delimiter", ",")
    values: list[str] = []
    counts: list[float] = []
    for line in body:
        at = line.rfind(delimiter)
        if at < 0:
            raise ValueError(f'weighted pack {file}: line "{line}" has no count')
        weight = float(line[at + len(delimiter) :].strip())
        # A zero weight means "never drawn". Dropping it rather than carrying it at zero
        # probability is what the reference does, and census files are full of them.
        if weight == 0:
            continue
        values.append(line[:at])
        counts.append(weight)

    if not values:
        raise ValueError(f"weighted pack {file} has no positive counts")

    total = sum(counts)
    # Written exactly as the reference computes it. Reordering these operations changes the last
    # bits of the double, which changes a Hamilton remainder, which changes which row gets a
    # leftover — and the output stops matching.
    return Entry(values, [count / total * 100 for count in counts])
