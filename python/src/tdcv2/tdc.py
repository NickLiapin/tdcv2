"""Generate data from a ``.tdc`` config.

The entry point. Point it at a file or hand it the config as a string, then take the result as text
or as rows::

    data = TDC("users.tdc")
    print(data)

    for row in data:
        print(row["Gender"])

Rows are the reason to use the library rather than the command line. A test that asserts on
``row["Gender"]`` says what it means; the same test parsing CSV back out of a string spends most of
its lines on the parsing.

Text output and row output read the same generated values, so the two never disagree. Row output
ignores ``<block>`` and the wrappers entirely — those describe a file format, and a row has no
format.
"""

from __future__ import annotations

import math
import os
import random
import time
from array import array
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from . import engine
from .engine import parallel, router
from .errors import Diagnostic, TdcError, has_errors, summarize
from .model.config import Config
from .output import parquet_output
from .packs import DataPacks, project_config
from .parser import config_builder, facade
from .validator import validate

# A materialized cell, roughly: a short string plus the slot holding it.
BYTES_PER_CELL = 40

# A rendered record, roughly — enough to notice a run that will not fit.
BYTES_PER_RENDERED_CARD = 200

# Past half the memory the run is worth a word; past nine tenths it is worth stopping for.
def _absolute(path: Path) -> Path:
    """The path made absolute, with symlinks left alone.

    Absolute, not RESOLVED: `Path.resolve()` follows symlinks, and the refusal that names what
    it searched then printed a path the config never mentions — `/private/tmp/x.csv` for a file
    the author wrote as `/tmp/x.csv`. The reference makes the path absolute and stops there.
    """
    return Path(os.path.abspath(path))


#: Why a parse failure is the only thing reported.
_PARSE_FAILED_HINT = (
    "The document did not parse, so the structural and semantic checks were skipped. "
    "Fix this first — anything they reported would be describing the torn tree, not "
    "your config."
)

WARN_RATIO = 0.5
ERROR_RATIO = 0.9


@dataclass(frozen=True, slots=True)
class SeedInfo:
    """The seed used, and whether the config supplied it."""

    seed: str
    generated: bool


class Row:
    """One record: its sequences, addressable by the names the config gave them."""

    __slots__ = ("_source", "index")

    def __init__(self, source, index: int) -> None:
        self._source = source
        self.index = index

    def get(self, sequence: str) -> str | None:
        """The value of one sequence on this row.

        ``None`` when the sequence does not apply here — a column declared with
        ``parent="Gender.Male"`` has no value on a female row, and an empty string would claim it
        had one that happened to be blank.
        """
        return self._source.value(sequence, self.index)

    def __getitem__(self, sequence: str) -> str | None:
        return self.get(sequence)

    def to_dict(self) -> dict[str, str]:
        """Every sequence with a value here, in declaration order."""
        out = {}
        for name in self._source.sequence_names():
            value = self._source.value(name, self.index)
            if value is not None:
                out[name] = value
        return out

    def nested(self) -> dict[str, object]:
        """The same row with compound sequences nested.

        A compound is one thing with parts, so it reads as one entry holding a dict rather than as
        several sibling entries whose shared prefix the caller has to notice:
        ``row.nested()["Address"]`` gives the whole address, keyed by field.
        """
        out: dict[str, object] = {}
        for key, value in self.to_dict().items():
            dot = key.find(".")
            if dot < 0:
                out[key] = value
                continue
            parent, field = key[:dot], key[dot + 1 :]
            group = out.get(parent)
            if not isinstance(group, dict):
                group = {}
            group[field] = value
            out[parent] = group
        return out

    def __repr__(self) -> str:
        return repr(self.to_dict())



def _as_finite_numbers(text: list[str | None]) -> list[float] | None:
    """Every cell as a finite float, or ``None`` when even one of them is not.

    ``float("")`` raises and ``float(None)`` raises, which is the answer wanted: neither is a
    value the column produced.
    """
    out: list[float] = []
    for cell in text:
        if cell is None or cell == "":
            return None
        try:
            number = float(cell)
        except ValueError:
            return None
        if not math.isfinite(number):
            return None
        out.append(number)
    return out

class TDC:
    """A configured run. Everything is decided here; the values are produced on first use."""

    __slots__ = (
        "_base_dir",
        "_config",
        "_config_file",
        "_diagnostics",
        "_now_millis",
        "_on_progress",
        "_options",
        "_packs",
        "_rendered",
        "_seed_generated",
        "_source",
        "_uniq_plan",
    )

    def __init__(
        self,
        config_file: str | Path | None = None,
        *,
        config_string: str | None = None,
        count: int | None = None,
        seed: str | None = None,
        locale: str | None = None,
        now: int | None = None,
        packs_dir: Path | None = None,
        data_paths: list[Path] | None = None,
        base_dir: Path | None = None,
        engine: int | None = None,
        on_progress=None,
        uniq_plan=None,
    ) -> None:
        """Exactly one of ``config_file`` and ``config_string``; the rest override ``<env>``.

        ``now`` is the instant "now" means, in milliseconds since the epoch — worth setting in a
        test, because a config with a date generator reads the clock and the same seed would
        otherwise produce different data tomorrow.

        ``engine`` runs on one named engine (1 in memory, 2 streaming, 3 exact on disk), overriding
        everything the config says. NAMING an engine means it refuses rather than quietly running
        another — including engine 3 on a ``<uniq>`` too tight for its bounded repair, which used
        to fall back to the in-memory engine without a word, so a benchmark of engine 3 was a
        benchmark of engine 1. ``mode="disk"`` says what the run may COST instead, and a config
        that says that may still be handed to another engine. Naming one is what makes this useful
        for a benchmark and wrong for ordinary use.

        ``on_progress(phase, done, total)`` is called as the run advances, so a caller with a long
        run can say more than "working". Phases: ``uniq-scan`` (every row's tuple hashed),
        ``uniq-sort`` (piles sorted), ``uniq-repair`` (the tuples that repeat checked and
        rearranged — usually the longest of the four on a large run), ``render`` (rows written).
        It is called often — about two hundred times per phase — so it must be cheap; the command
        line throttles it to once a second before writing anything down.

        Within a phase the numbers only ever RISE, and a phase ends at its own total, so a bar
        drawn from them never jumps backwards and never stops short of full. ``uniq-repair`` is
        several steps of different kinds reported on one growing scale, so its total is what has
        been taken on so far rather than something known in advance.
        """
        if (config_file is None) == (config_string is None):
            raise ValueError("TDC needs exactly one of config_file and config_string")

        path = Path(config_file) if config_file is not None else None
        source = config_string if config_string is not None else path.read_text(encoding="utf-8")

        parsed = facade.parse(source)
        if not parsed.ok:
            # Raised as diagnostics rather than as prose so that a caller — the command line
            # above all — can render the offending line instead of only quoting the message.
            # The hint goes on the FIRST problem only: it explains why nothing ELSE was
            # reported, and repeating it under every line of a torn document would bury the
            # errors it is introducing. Without it a reader with one unclosed tag sees a single
            # complaint and takes it for the whole story — the validator never ran.
            syntax = [
                Diagnostic.error(
                    "TDC001",
                    p.message,
                    _PARSE_FAILED_HINT if i == 0 else "",
                    p.line,
                    p.column,
                )
                for i, p in enumerate(parsed.problems)
            ]
            raise TdcError(summarize(syntax), syntax, source)

        # A pack directory named outright wins; otherwise the project's own tdcv2.config.json is
        # consulted, so a downloaded pack is found by whichever runtime reads the config next.
        self._packs = (
            DataPacks(packs_dir)
            if packs_dir is not None
            else DataPacks.for_project(
                _absolute(path).parent if path is not None else Path.cwd(), data_paths
            )
        )

        # With a config file, a relative src= is relative to that file. With a config string there
        # is no file to be relative to, so the caller says where — and if they do not, the working
        # directory is the only honest answer left.
        config_dir = (
            base_dir if base_dir is not None else (_absolute(path).parent if path else None)
        )

        # Validated before building. A config the reference refuses must be refused here too, or
        # the two implementations disagree about which configs are legal — which is a portability
        # bug even when every value either of them produces is right.
        # `--count` decides how many rows there will be, so the warnings that are
        # arithmetic over the count have to be about that number and not <env>'s.
        problems = validate(parsed.tree, config_dir, self._packs, count)
        if has_errors(problems):
            raise TdcError(summarize(problems), problems, source)
        self._diagnostics = problems

        # The project config's `locale` is the fallback for a config that declares none — the
        # same file the packs came from, so a project that installed `ru` and wrote it down
        # gets Russian without repeating itself in every .tdc.
        project_locale = project_config.load(
            config_dir if config_dir is not None else Path.cwd()
        ).locale
        built = config_builder.build(parsed.tree, project_locale).override(count, seed, locale)
        self._config = built if engine is None else built.with_engine(str(engine))

        # Nothing named a seed, so one is invented — and USED, which is the whole point. Leaving
        # it empty would make every seedless run produce the same bytes while `seed_info` reported
        # a random seed of "", advice that reproduces nothing. Randomness here is the reference's
        # behaviour: a seedless run is a different sample each time, and the seed reported beside
        # it is how you get that sample back.
        #
        # The local `seed` is reassigned on purpose: `self._options` below carries it to the
        # worker processes, and workers each inventing their own would write a file whose halves
        # came from different runs.
        self._seed_generated = self._config.seed == ""
        if self._seed_generated:
            seed = str(random.random())
            self._config = self._config.override(seed=seed)

        # The clock read once, here, rather than per value: a run that straddled midnight would
        # otherwise put two different dates in one file from one "today".
        self._now_millis = now if now is not None else int(time.time() * 1000)
        self._base_dir = config_dir
        self._on_progress = on_progress
        self._uniq_plan = uniq_plan
        self._rendered = None
        self._source = source

        # Enough to rebuild this exact run in another process — see `write_file(workers=…)`. The
        # clock is stored resolved: workers that each read `time.time()` could straddle midnight
        # and put two different "today"s in one file.
        self._config_file = path
        self._options = {
            "count": count,
            "seed": seed,
            "locale": locale,
            "now": self._now_millis,
            "packs_dir": packs_dir,
            "data_paths": data_paths,
            "base_dir": base_dir,
            "engine": engine,
        }

    # ── output ──────────────────────────────────────────────────────────────────────────────

    def __str__(self) -> str:
        """The whole output as one string."""
        return self._run().text()

    def write_file(self, target: str | Path, workers: int | str | None = None) -> None:
        """The output written to a file, replacing whatever is there.

        On a streaming engine the records go to the file as they are produced, so this is the one
        call that can write a run larger than the machine's memory. Asking for the same run as a
        string first would defeat that, so it does not.

        ``workers`` splits the run across that many processes — ``"auto"`` for one per core bar
        one. The output is byte for byte what a single process writes; a row is a function of its
        own index, so the shards need no coordination and none of them can influence another.
        Anything that cannot be split safely quietly runs on one process instead: the in-memory and
        exact engines, a config given as a string rather than a file, Parquet output, and runs too
        short for the process startup to earn its cost.
        """
        path = Path(target)
        # A .parquet name asks for the typed binary form. The extension is the whole switch —
        # there is no flag to remember and no second call to make.
        if path.suffix.lower() == ".parquet":
            with path.open("wb") as out:
                parquet_output.write(self._config, self._run(), out.write, self._on_progress)
            return

        count = self._worker_count(workers)
        if count > 1:
            assert self._config_file is not None  # _worker_count returns 1 without a file
            # Worked out ONCE, here, before a single process exists. Empty for the configs
            # with no env-level group, which is most of them, and then this costs nothing.
            plan: dict = {}
            if self._config.env_uniq_groups:
                from .engine import stream as stream_engine

                stream_engine.plan_uniq(
                    self._config,
                    self._packs,
                    self._now_millis,
                    self._base_dir,
                    self.engine() == 3,
                    self._on_progress,
                    lambda label, moved: plan.__setitem__(label, moved),
                )
            parallel.write_file(
                self._config_file,
                path,
                self._options,
                count,
                self.count,
                self._on_progress,
                plan,
            )
            return

        with path.open("w", encoding="utf-8") as out:
            self._run().write_to(out.write)

    def _worker_count(self, workers: int | str | None) -> int:
        """How many processes to actually use, which is one whenever splitting is not safe."""
        if workers is None:
            return 1
        if workers == "auto":
            asked = parallel.default_workers()
        elif isinstance(workers, int):
            asked = workers
        else:
            raise ValueError(f'workers must be an int or "auto", not {workers!r}')

        # Engine 1 holds the whole run and has nothing to split. Everything else resolves a row
        # from its own number — EXCEPT uniq="true" on a sequence, which rearranges the generators
        # inside one compound column: a worker resolving a row on its own cannot reproduce that.
        # An env-level <uniq> group is not in that class, and splits: the parent works the
        # arrangement out once and hands it to the workers.
        if asked <= 1 or self._config_file is None or self.engine() == 1:
            return 1
        if any(spec.uniq for spec in self._config.sequences):
            return 1
        # A worker that generates a handful of rows spends longer starting up than working.
        return max(1, min(asked, self.count // parallel.MIN_ROWS_PER_WORKER))

    def to_list(self) -> list[Row]:
        """Every record, as rows."""
        result = self._run()
        return [Row(result, i) for i in range(self.count)]

    def to_array(self) -> list[Row]:
        """Every record, as rows — the name the other four implementations use.

        The same thing ``to_list`` returns. One vocabulary across five languages is worth more
        here than each one's local habit, because this library exists to be used BESIDE the
        generator: a reader following an example written in another language should not have to
        translate the method names. ``to_list`` keeps working and is not deprecated.
        """
        return self.to_list()

    def to_string(self) -> str:
        """The whole output as one string.

        ``str(tdc)`` does the same and is the Pythonic spelling; this one exists so the name is
        the same in all five. Neither is preferred over the other.
        """
        return str(self)

    def get_at(self, index: int) -> Row:
        """One record by its position, without materialising the rest."""
        if index < 0 or index >= self.count:
            raise IndexError(f"row {index} is outside a run of {self.count}")
        return Row(self._run(), index)

    def iterate(self):
        """Every record, one at a time.

        A generator rather than a list: a run too large to hold is exactly the case this is for.
        """
        result = self._run()
        for i in range(self.count):
            yield Row(result, i)

    def to_columns(self) -> dict[str, array[float] | list[str | None]]:
        """The run as COLUMNS rather than rows, with numbers as numbers.

        A column comes back as ``array("d", ...)`` — the standard library's array of doubles —
        only when EVERY cell in it is a finite number, and as a plain list otherwise. The type
        therefore says which, and a caller reading a numeric column never has to check for a
        label hiding in it.

        All-or-nothing on purpose: an array of doubles cannot hold "no value", and filling the
        gaps with NaN would put a number nobody generated where a ``parent=`` filter deliberately
        left nothing.

        Not a way to skip the number-to-string conversion: sequences hold their values as text,
        so this parses them. It is for the ergonomics, and for not building the whole file as one
        string first. A caller wanting numpy can hand the array straight to ``numpy.frombuffer``
        or ``numpy.array`` — no copy of ours stands in the way.
        """
        result = self._run()
        out: dict[str, array[float] | list[str | None]] = {}
        for name in result.sequence_names():
            text = [result.value(name, i) for i in range(self.count)]
            numbers = _as_finite_numbers(text)
            out[name] = array("d", numbers) if numbers is not None else text
        return out

    def __iter__(self) -> Iterator[Row]:
        """The records one at a time, without building the list."""
        result = self._run()
        for i in range(self.count):
            yield Row(result, i)

    def __getitem__(self, index: int) -> Row:
        """One record by position."""
        result = self._run()
        if index < 0 or index >= self.count:
            raise IndexError(f"row {index} is outside a run of {self.count}")
        return Row(result, index)

    def __len__(self) -> int:
        return self.count

    # ── what the run is ─────────────────────────────────────────────────────────────────────

    @property
    def count(self) -> int:
        """The number of records this run produces."""
        return self._config.count

    @property
    def source(self) -> str:
        """The config text this run was built from.

        Exposed because a diagnostic names a line, and showing that line is what makes the
        complaint act on rather than look up.
        """
        return self._source

    @property
    def diagnostics(self) -> list[Diagnostic]:
        """Anything the config was warned about but not refused for.

        Errors are raised from the constructor, so whatever is left here is worth saying and not
        worth stopping for.
        """
        return self._diagnostics

    @property
    def config(self) -> Config:
        """The parsed config, for an output format that needs the schema as well as the values."""
        return self._config

    def seed_info(self) -> SeedInfo:
        """The seed in effect.

        ``generated`` is true when the config named no seed, in which case one was invented and
        this is the only record of it — worth logging, since re-running without it produces a
        different sample.
        """
        return SeedInfo(self._config.seed, self._seed_generated)

    def engine(self) -> int:
        """Which engine this config runs on: 1 in memory, 2 streaming, 3 exact on disk.

        Worth exposing because it explains the run's memory profile, and because a config that
        asked for disk mode and got engine 1 back is being told something useful — it uses a
        feature that has to see the whole column.
        """
        return router.resolve(self._config, self._packs)

    def uses_http(self) -> bool:
        """Whether this config calls a service — which makes the run non-reproducible."""
        for spec in self._config.sequences:
            if spec.gen is not None and spec.gen.type == "http":
                return True
            if (
                spec.is_compound
                and spec.fields
                and any(f.gen is not None and f.gen.type == "http" for f in spec.fields)
            ):
                return True
        return False

    def preflight(self, materialized: bool = True) -> Diagnostic | None:
        """What this run is likely to cost in memory, or nothing when the answer is "not much".

        Worth asking before a large run rather than after: a config that will not fit says so in a
        millisecond here, and takes minutes to say so by thrashing. The estimate is deliberately
        crude — a cell is assumed to cost about forty bytes and a rendered record about two hundred
        — because the decision it informs is "is this the right order of magnitude", not "how many
        bytes exactly".

        ``materialized`` is whether the whole output will be held as one string, as ``str()`` does.
        A run written straight to a file does not pay that.
        """
        # A streaming engine holds one row, not the run, so its cost does not grow with count.
        streaming = self.engine() != 1
        slots = 4  # _count, _first, _last, _total
        for spec in self._config.sequences:
            slots += len(spec.fields) if spec.is_compound and spec.fields else 1
        cells = slots if streaming else self._config.count * slots
        estimated = cells * BYTES_PER_CELL
        if not streaming and materialized:
            estimated += self._config.count * BYTES_PER_RENDERED_CARD

        total = _total_memory()
        ratio = estimated / total if total > 0 else float("inf")
        if ratio < WARN_RATIO:
            return None

        estimated_mb = (estimated + 1024 * 1024 - 1) // (1024 * 1024)
        total_mb = total // (1024 * 1024)
        if ratio >= ERROR_RATIO:
            return Diagnostic.error(
                "TDC201",
                f"estimated memory need (~{estimated_mb} MB) exceeds this machine's RAM "
                f"({total_mb} MB) — run will likely thrash or crash",
                "Reduce count, split the generation into smaller batches, or switch to disk mode "
                '(mode="disk") which is bounded-memory.',
                1,
                0,
            )
        return Diagnostic.warning(
            "TDC200",
            f"estimated memory need (~{estimated_mb} MB) is a large share of this machine's RAM "
            f"({total_mb} MB) — may lean on swap and slow down",
            'This will still run; for very large datasets mode="disk" keeps memory flat '
            "regardless of count.",
            1,
            0,
        )

    # ── the run itself ──────────────────────────────────────────────────────────────────────

    def rows(self):
        """The built run, for an output format that walks it directly."""
        return self._run()

    def _run(self):
        """Generated once and kept: asking for text and then for rows must not run it twice."""
        if self._rendered is None:
            self._rendered = self._build()
        return self._rendered

    def _build(self):
        # Routing, and recovering from a streaming refusal, live in `engine` — one place, so the
        # facade and the shared-case harness cannot come to different answers about one config.
        return engine.build(
            self._config,
            self._packs,
            self._now_millis,
            self._base_dir,
            self._on_progress,
            self._uniq_plan,
        )


def _total_memory() -> int:
    """This machine's RAM, or zero when the platform will not say."""
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return 0
