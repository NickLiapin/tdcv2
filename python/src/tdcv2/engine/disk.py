"""Engine 3: everything the in-memory engine does, for runs that do not fit in memory.

It is not a third implementation. It is the streaming engine with one setting changed — a ``uniq``
sequence is built to its exact shares and then verified on disk, instead of being given uniform
combinations — and a fallback for the configs that setting cannot satisfy.

The fallback is the honest part. A config that turns out to need the whole column, or a uniqueness
constraint so tight the bounded repair cannot place every row, goes to the in-memory engine and
produces correct data at the cost of the memory profile. Which is the right trade: an engine chosen
for its memory behaviour must not answer differently from the one that was not.
"""

from __future__ import annotations

from pathlib import Path

from ..model.config import Config
from ..packs import DataPacks
from . import memory, stream
from .exact_uniq import RepairNeededError


def rows(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None = None,
    on_progress=None,
    uniq_plan=None,
):
    """The run as addressable records, exact and bounded — or in memory when it cannot be both."""
    try:
        return stream.rows(config, packs, now_millis, base_dir, True, on_progress, uniq_plan)
    except (stream.UnsupportedError, RepairNeededError):
        return memory.build(config, packs, now_millis, base_dir, on_progress)


def render(config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None = None) -> str:
    return rows(config, packs, now_millis, base_dir).text()
