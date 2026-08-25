"""Engine 3: everything the in-memory engine does, for runs that do not fit in memory.

It is not a third implementation. It is the streaming engine with one setting changed — a ``uniq``
sequence is built to its exact shares and then verified on disk, instead of being given uniform
combinations — and a fallback for the configs that setting cannot satisfy.

The fallback is the honest part. A config that turns out to need the whole column, or a uniqueness
constraint so tight the bounded repair cannot place every row, goes to the in-memory engine and
produces correct data at the cost of the memory profile. Which is the right trade: an engine chosen
for its memory behaviour must not answer differently from the one that was not.

Two things it must NOT do, and both used to happen here.

It must not fall back for a caller that NAMED this engine. ``engine="3"`` and ``--engine 3`` say
WHICH engine to run, so quietly running another hides exactly what the author asked to be told —
the rule the streaming side has followed all along. Measured before the fix: a tight ``<uniq>``
under ``--engine 3`` produced byte-identical output to ``--engine 1``, so anyone benchmarking
engine 3 on a tight config was benchmarking engine 1.

And it must not fall back past what the in-memory engine can hold. There the fallback does not
fail fast; it fails after half an hour of materialising, out of memory, with nothing written.
"""

from __future__ import annotations

from pathlib import Path

from ..model.config import Config
from ..packs import DataPacks
from . import memory, stream
from .exact_uniq import IN_MEMORY_FALLBACK_MAX_ROWS, RepairNeededError


def rows(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None = None,
    on_progress=None,
    uniq_plan=None,
    named: bool = False,
):
    """The run as addressable records, exact and bounded — or in memory when it cannot be both.

    ``named`` says the caller asked for this engine by name rather than describing a constraint.
    """
    try:
        return stream.rows(config, packs, now_millis, base_dir, True, on_progress, uniq_plan)
    except (stream.UnsupportedError, RepairNeededError) as e:
        _refuse_if_it_must(e, config.count, named and isinstance(e, RepairNeededError))
        return memory.build(config, packs, now_millis, base_dir, on_progress)


def _refuse_if_it_must(error: Exception, count: int, named: bool) -> None:
    """Raise instead of falling back, in the two cases where falling back is the wrong answer.

    ``named`` here means "named AND stopped by the repair cap". A shape the lazy path cannot
    express at all — a weighted pack generator, say — means engine 3 never got to run the config,
    and covering that is what engine 3 IS. The cap is the other case: engine 3 DID run this
    config, got most of the way, and gave up on a memory budget — the very property the caller
    named this engine to get.
    """
    # The refusals share a first half — up to the em dash — and differ in the advice after it.
    said = str(error).split(" — ")[0]
    if count > IN_MEMORY_FALLBACK_MAX_ROWS:
        raise RuntimeError(
            f"{said} — and at {count} rows the in-memory engine cannot take over. Widen the "
            "uniq columns' values (more distinct names, wider ranges…) or lower the count."
        )
    if named:
        raise RuntimeError(
            f"{said} — and engine 3 was asked for by name, so it refuses rather than quietly "
            "running another engine. Remove the engine choice to let a uniq this tight go to "
            "the in-memory engine, which is what has been happening here all along."
        )


def render(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None = None,
    named: bool = False,
) -> str:
    return rows(config, packs, now_millis, base_dir, named=named).text()
