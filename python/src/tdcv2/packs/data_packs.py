"""Reading data packs.

A pack is a text file: an optional ``---`` header, then one value per line. With ``weighted: true``
each line is ``value,count`` instead, and the counts become exact proportions rather than
probabilities — the same machinery ``percent=`` uses. That is why a run of 30,000 rows from the SSA
name file contains precisely as many Jameses as the census says, not approximately.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ..errors import Diagnostic
from . import project_config, source

#: `<sequence name="…">` in a pack generator body — the pack's parameter list. Read by
#: scanning rather than by parsing: the validator asks before anything is built, and
#: parsing a pack body there would report a pack author's syntax error at the caller's line.
from .param_width import parameter_widths
from .registry import Registry
from .source import Source

_SEQUENCE_NAME = re.compile(r'<sequence\s+[^>]*name\s*=\s*"([^"]+)"')

#: The extensions a dotted address is tried against, in order. Nearly every pack is a ``.txt``
#: list; a COMPOSED pack — one whose value a generator body builds rather than a line of the file
#: — is a ``.tdc``. The reference ignores the extension altogether, and so does the address index;
#: this list is only the fast path that spares an ordinary run the scan.
_PACK_EXTENSIONS = (".txt", ".tdc")


def _strip_extension(path: str) -> str:
    """A relative path without its final extension, the way the reference derives an address.

    Only the last segment is considered, so ``nl-be/person/name`` keeps the dot in its folder.
    """
    head, slash, name = path.rpartition("/")
    stem, dot, _ = name.rpartition(".")
    return head + slash + stem if dot and stem else path


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


class DuplicateAddressError(ValueError):
    """Two files claim one address.

    Its own type because :meth:`DataPacks.exists` has to tell it apart from "no such address":
    a collision RESOLVES, and reporting it as a misspelling sends the reader hunting for a typo
    that is not there.
    """


class DataPacks:
    """Where a run's data comes from: the packs, and the folders a file source may name.

    The two travel together because they answer the same question and come from the same place —
    ``--data-path`` on the command line, and ``dataPaths`` in ``tdcv2.config.json``, feed both.
    Keeping the folders here is also what lets every engine and the validator reach them: they are
    already handed a ``DataPacks``, so nothing new has to be threaded through fifteen signatures.
    """

    __slots__ = ("_cache", "_index", "_unaddressable", "data_roots", "source")

    def __init__(self, from_source: Source | Path, data_roots: list[Path] | None = None) -> None:
        self.source: Source = (
            source.Directory(from_source) if isinstance(from_source, Path) else from_source
        )
        self._cache: dict[tuple[str, str], Entry] = {}
        #: address -> relative file path, built on first use. ``None`` until then: most runs
        #: resolve every address straight from the path and never pay for the scan.
        self._index: dict[str, str] | None = None
        #: The files the index build read and could not place — TDC171. Filled by the same pass,
        #: so saying so costs nothing over dropping them silently.
        self._unaddressable: list[Diagnostic] = []
        #: Folders searched by ``src="@data/…"``, and by a relative ``src=`` the config's own
        #: folder does not hold. Highest priority last, as the layers are.
        self.data_roots: list[Path] = list(data_roots or [])

    @staticmethod
    def bundled() -> DataPacks:
        """The packs a run starts from — the default, and no configuration needed.

        ``TDCV2_PACKS`` if it names a folder, then the source checkout this build came from, then
        the packs shipped inside the wheel. See :func:`tdcv2.packs.source.discover`.
        """
        return DataPacks(source.discover())

    @staticmethod
    def for_project(cwd: Path | None = None, extra_roots: list[Path] | None = None) -> DataPacks:
        """The discovered packs plus whatever ``tdcv2.config.json`` adds, searched from here upward.

        A pack downloaded into a project belongs to the project, not to whichever runtime happens
        to read it. Honouring the same config file the command-line tool writes is what keeps a
        config that uses a downloaded pack working in every implementation rather than only the one
        that fetched it.

        ``extra_roots`` are named at the call site — the command line's ``--data-path`` — and go on
        last, so they shadow both the config's roots and the bundled packs. Something typed for
        this one run should beat something written down for every run.
        """
        discovered = source.discover()
        layers: list[Source] = [discovered]
        config = project_config.load(cwd)
        layers.extend(source.Directory(d) for d in config.data_paths if d.is_dir())
        # The pack STORE is not a scan root on its own account. It is scanned when `pack add` has
        # put something in it and written it into `dataPaths` — the same as any other data path,
        # and by the entry above rather than by anything special here. A `packStore` nobody has
        # installed into is a folder the project named, not a folder of packs.
        for root in extra_roots or []:
            if root.is_dir():
                layers.append(source.Directory(root))

        roots = [*config.data_paths, *(extra_roots or [])]
        if len(layers) == 1:
            return DataPacks(discovered, roots)
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
        for bundle_id in bundle_ids:
            client.install(index.find(bundle_id), store)
        # One entry for the store, whatever went into it: every bundle unpacks at its address
        # path inside that single folder, so there is no per-bundle root left to name.
        project_config.register(config_path or config_dir / project_config.CONFIG_NAME, [store])
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
            base = dotted_path.replace(".", "/")
        elif self.source.has_country(first):
            # A country is absolute too, but its files live under the countries/ grouping, which
            # is not part of the address anyone writes.
            base = "countries/" + dotted_path.replace(".", "/")
        else:
            base = (locale + "." + dotted_path).replace(".", "/")

        candidates = [c for c in (base + ext for ext in _PACK_EXTENSIONS) if self.source.has(c)]
        if len(candidates) > 1:
            # The extension is not part of an address, so two files that differ only by it claim
            # the SAME one. Picking the first silently would make `thing.tdc` dead weight its
            # author cannot see — the run keeps working and reads the other file forever.
            first, second = candidates[0], candidates[1]
            raise DuplicateAddressError(
                f'duplicate data-pack address "{self._absolute(dotted_path, locale)}" declared by '
                f'both "{self.source.locate(second) or second}" and '
                f'"{self.source.locate(first) or first}" — rename or move one'
            )
        file = candidates[0] if candidates else None
        if file is None:
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
                f'unknown template path "{dotted_path}" (looked for {base}.txt in {self.source})'
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
        dropped: list[Diagnostic] = []
        for file in self.source.list_files():
            lines = self.source.read_lines(file)
            header = _header_of(lines)
            declared = header.get("address", "").strip()
            if declared:
                address = declared
            else:
                address = _strip_extension(file).replace("/", ".")
                if address.startswith("countries."):
                    address = address[len("countries.") :]
                head = address.split(".", 1)[0]
                if not (self.source.has_top_level(head) or self.source.has_country(head)):
                    # Not under a locale folder: the header's own ``locale:`` is the only
                    # thing that can say where this belongs.
                    declared_locale = header.get("locale", "").strip()
                    if not declared_locale:
                        if _has_header(lines):
                            dropped.append(
                                _unaddressable_warning(
                                    self.source.locate(file) or file, address
                                )
                            )
                        continue
                    address = f"{declared_locale}.{address}"
            index[address] = file
        self._index = index
        self._unaddressable = dropped
        return index

    def header_warnings(self) -> list[Diagnostic]:
        """Every pack file the address scan read and could not place.

        Empty until something has looked an address up and missed, because that is when the scan
        runs. The reference walks every pack root before it starts and can therefore say this
        about a file no config mentions; here the walk is the fallback path, and a run that
        resolves everything by path never pays for it. The author who wrote the unplaceable file
        always takes the fallback — their own address is the one that misses — so the file gets
        named at the moment it matters. ``fixtures/cross-language/cli.json`` records the
        difference.
        """
        return list(self._unaddressable)

    def addresses(self) -> list[str]:
        """Every address these packs can answer to, in no particular order.

        The quick API needs the whole list rather than a yes-or-no about one
        address: to say "did you mean" it has to compare what was typed against
        all of them. Building the index is the cost of the first call only.
        """
        return list(self._addresses())

    def parameter_names(self, dotted_path: str, locale: str) -> set[str] | None:
        """The parameters a generator pack accepts, or ``None`` when it is not one.

        A pack's parameters ARE its local ``<sequence>`` names: writing
        ``domain="example.test"`` on the calling ``<gen>`` replaces the sequence called
        ``domain`` with that constant. A single-``<gen>`` pack declares none, and a
        plain list of values is not a generator at all — passing anything to either is
        always a no-op, so both are distinguished from "unknown pack" by returning an
        empty set rather than ``None``.

        Read by scanning the body for ``<sequence name="…">`` rather than by parsing
        it: the validator runs before anything is built, and parsing a pack body here
        would mean reporting a pack author's syntax error at the caller's line.
        """
        try:
            entry = self.load(dotted_path, locale)
        except Exception:
            return None
        if entry.generator is None:
            # A plain list of values has no parameters at all, which is not the same as
            # "unknown": an attribute aimed at one does nothing, and an attribute that
            # does nothing is indistinguishable from a typo.
            return set()
        return {m.group(1) for m in _SEQUENCE_NAME.finditer(entry.generator)}

    def parameter_widths(self, dotted_path: str, locale: str) -> dict[str, int]:
        """How many characters each parameter's own sequence produces, where that is a FACT.

        A pinned parameter replaces the pack's own sequence for the run. The packs that carry
        a CHECK DIGIT compute it over a fixed layout, so a value of the wrong width does not
        shift the layout — it breaks it. Measured on ``usa.finance.aba_routing``, whose own
        ``prefix`` is 2 characters and ``tail`` 6: ``prefix="12345"`` aborted the run inside
        the pack's compute, and ``tail="678"`` silently wrote a six-digit number that is not
        a routing number. ``check`` passed on both.

        Only the shapes whose width can be READ OFF the body are here; everything else is
        absent and the caller must stay silent, because a refusal has to be a proof.
        """
        try:
            entry = self.load(dotted_path, locale)
        except Exception:
            return {}
        if entry.generator is None:
            return {}
        return parameter_widths(entry.generator)

    def exists(self, dotted_path: str, locale: str) -> bool:
        """Whether an address resolves, without loading it.

        The validator asks this so a misspelled address is caught before the run rather than on
        its first row.
        """
        try:
            self.load(dotted_path, locale)
        except DuplicateAddressError:
            # It resolves — twice, which is the complaint. Answering "no" here would report the
            # collision as a misspelled address and send the reader hunting for a typo that is
            # not there; saying yes lets the caller load it and get the real message.
            return True
        except (ValueError, OSError):
            return False
        return True


def _has_header(lines: list[str]) -> bool:
    """Whether the file opens with the ``---`` fence.

    A file with no header at all stays silent when it cannot be placed: it is probably a raw
    ``@data`` source that happens to sit in a pack folder, not a pack somebody meant to publish.
    """
    return bool(lines) and lines[0].strip() == "---"


def _unaddressable_warning(file: str, address: str) -> Diagnostic:
    """A pack file the scan read and could not address.

    A warning rather than an error: the run continues on everything else, and the author hears
    about the file instead of meeting it later as "unknown template path" with nothing to connect
    the two.
    """
    return Diagnostic.warning(
        "TDC171",
        f'data-pack file "{file}" is not addressable: "{address}" starts with no locale, '
        "country or `common`. Add `address:` or `locale:` to its header, or move it under a "
        "locale folder.",
        f"Data pack file: {file}",
        1,
        0,
    )


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
