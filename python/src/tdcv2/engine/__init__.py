"""The engines: three ways to answer the same question about a row.

Which one a config gets is the router's decision, but routing alone is not the whole story. The
router decides on the evidence in the config; the streaming engine can then discover, while
building its resolvers, that this particular config needs the whole column after all. A running
total is the plain case — row 900,000,000 IS the sum of everything before it.

So dispatch lives HERE, once, rather than at each call site. It used to live in two: the facade
recovered from a streaming refusal by rebuilding in memory, and the shared-case harness — which
dispatched for itself — did not. The two disagreed about what a config produces, which is the one
thing a cross-language contract cannot afford, and it stayed hidden because no shared case ran a
running total without pinning ``mode="memory"`` first.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from . import disk, exact_uniq, external_sort, memory, router, stream

if TYPE_CHECKING:  # pragma: no cover - import cycle at runtime, fine for annotations
    from ..model import Config
    from ..packs import DataPacks

__all__ = [
    "build",
    "disk",
    "engine_was_named",
    "exact_uniq",
    "external_sort",
    "memory",
    "render",
    "router",
    "stream",
]


def engine_was_named(config: Config) -> bool:
    """Whether the config NAMED its engine rather than describing its constraint.

    ``engine="2"`` and the older ``mode="stream"`` both say which engine to use. That makes a
    refusal the answer: quietly running somewhere else would hide exactly what the author asked to
    be told. ``mode="disk"`` says what the run may COST instead, so falling back to a slower engine
    still honours it.
    """
    engine = config.engine
    mode = config.mode
    return bool(engine and engine.strip()) or (mode is not None and mode.strip() == "stream")


def render(config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None = None) -> str:
    """The run as text, on whichever engine the router picked."""
    engine = router.resolve(config, packs)
    if engine == 1:
        return memory.render(config, packs, now_millis, base_dir)
    if engine == 3:
        # Engine 3 falls back on its own, so a config it cannot do exactly still renders.
        return disk.render(config, packs, now_millis, base_dir)
    try:
        return stream.render(config, packs, now_millis, base_dir)
    except stream.UnsupportedError:
        if engine_was_named(config):
            raise  # named outright, so the refusal is the answer
        # Routed here rather than asked for: the config turned out to need the whole column
        # after all, and correct data matters more than the memory profile.
        return memory.render(config, packs, now_millis, base_dir)


def build(config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None = None):
    """The run as rows, on whichever engine the router picked."""
    # Can the uniq groups cover `count` at all? Asked before an engine is chosen,
    # because the answer does not depend on which one runs. It used to be asked
    # inside the in-memory builder alone, so a config routed anywhere else got no
    # answer — an infeasible run went ahead and filled the disk instead of being
    # turned away in milliseconds. The check reads the SPECS; no column is built.
    memory.check_env_uniq_capacity(config, config.count)
    engine = router.resolve(config, packs)
    if engine == 1:
        return memory.build(config, packs, now_millis, base_dir)
    if engine == 3:
        return disk.rows(config, packs, now_millis, base_dir)
    try:
        return stream.rows(config, packs, now_millis, base_dir)
    except stream.UnsupportedError:
        if engine_was_named(config):
            raise
        return memory.build(config, packs, now_millis, base_dir)
