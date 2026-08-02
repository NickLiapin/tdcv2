"""``repeat="1..3"`` — several values in one cell.

An order has line items, a person has phone numbers. Without this a config has to invent a fixed
number of columns and leave most of them empty, which is not what the data looks like.

The lengths are an exact quota rather than a per-row coin flip, and each length group owns one
contiguous block of slots. That is what lets a row's slice follow from its own rank instead of
from a running total over its predecessors — the same property that makes the streaming engine
possible.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from ..distribution import hamilton
from ..prng.prng import Sfc32
from . import accumulate as accumulate_gen

# A ceiling, so one careless attribute cannot make a run a thousand times slower.
MAX_REPEAT = 64
DEFAULT_SEPARATOR = ","


@dataclass(frozen=True, slots=True)
class Spec:
    min: int
    max: int
    separator: str
    #: ``accumulate=``: the list is replaced by its running total before joining.
    accumulate: str | None = None


@dataclass(frozen=True, slots=True)
class Plan:
    """Where each row's values sit in one flat run of slots.

    The lengths are decided before any value exists, so a row's slice follows from its own
    position rather than from a running total over the rows before it. That is what lets the
    streaming engine answer row nine million without having built the first eight.
    """

    spec: Spec
    total_slots: int
    row_cum_lo: list[int]
    slot_offset: list[int]

    def length_at(self, p: int) -> int:
        """How many values the row at permuted position ``p`` keeps."""
        return self.spec.min + self._group_of(p)

    def slot_start_at(self, p: int) -> int:
        """The first slot the row at permuted position ``p`` owns."""
        j = self._group_of(p)
        return self.slot_offset[j] + (p - self.row_cum_lo[j]) * (self.spec.min + j)

    def _group_of(self, p: int) -> int:
        lo, hi = 0, len(self.row_cum_lo) - 1
        while lo < hi:
            mid = (lo + hi + 1) >> 1
            if p >= self.row_cum_lo[mid]:
                lo = mid
            else:
                hi = mid - 1
        return lo


def parse(attrs: dict[str, str]) -> Spec | None:
    """``None`` when the generator has no ``repeat``, which is the ordinary case."""
    raw = attrs.get("repeat")
    if raw is None or not raw.strip():
        return None

    text = raw.strip()
    dots = text.find("..")
    min_text = text if dots < 0 else text[:dots].strip()
    max_text = text if dots < 0 else text[dots + 2 :].strip()

    minimum = _whole(min_text, raw, "minimum")
    maximum = _whole(max_text, raw, "maximum")
    if minimum < 0:
        raise ValueError(f'repeat: minimum of "{raw}" must not be negative')
    if maximum < minimum:
        raise ValueError(f'repeat: "{raw}" has its maximum below its minimum')
    if maximum > MAX_REPEAT:
        raise ValueError(f'repeat: maximum of "{raw}" must not exceed {MAX_REPEAT}')

    return Spec(
        minimum,
        maximum,
        attrs.get("separator", DEFAULT_SEPARATOR),
        accumulate_gen.read(attrs),
    )


def build(spec: Spec, count: int, prng: Sfc32, build_flat: Callable[[int], list[str]]) -> list[str]:
    """One cell per row, each holding its own number of values.

    ``build_flat`` produces every value the run needs as one flat list. Building them together
    rather than per row is what keeps the draws in the same order they would have been in without
    ``repeat`` — the values are the same, only their grouping differs.
    """
    groups = spec.max - spec.min + 1

    # The lengths, as an exact quota rather than a per-row coin flip.
    group_ids = list(range(groups))
    percents = [100.0 / groups] * groups
    per_row_group = hamilton.distribute(count, group_ids, percents, prng)

    counts = [0] * groups
    for j in per_row_group:
        counts[j] += 1

    # Each length group owns one contiguous block of slots, so a row's slice follows from its
    # rank inside its own group and from nothing else.
    offsets = [0] * groups
    acc = 0
    for j in range(groups):
        offsets[j] = acc
        acc += counts[j] * (spec.min + j)
    total_slots = acc

    next_rank = [0] * groups
    starts = [0] * count
    keeps = [0] * count
    for i in range(count):
        j = per_row_group[i]
        length = spec.min + j
        starts[i] = offsets[j] + next_rank[j] * length
        next_rank[j] += 1
        keeps[i] = length

    flat = build_flat(total_slots)

    out: list[str] = []
    for i in range(count):
        parts = [flat[starts[i] + k] if starts[i] + k < len(flat) else "" for k in range(keeps[i])]
        out.append(join(parts, spec))
    return out


def join(parts: list[str], spec: Spec) -> str:
    """The last step every repeat list goes through: accumulate, then join.

    One function rather than four copies because there are four places a list becomes a
    cell — one in the in-memory engine and three in the streaming one — and a running
    total that appeared on one engine and not the other is the failure this shape
    prevents.
    """
    running = accumulate_gen.apply(parts, spec.accumulate) if spec.accumulate else parts
    return spec.separator.join(running)


def plan(spec: Spec, row_count: int, counts: list[int]) -> Plan:
    """Lay out ``row_count`` rows whose lengths were apportioned as ``counts``."""
    groups = spec.max - spec.min + 1
    row_cum_lo = [0] * groups
    slot_offset = [0] * groups
    row_acc = 0
    slot_acc = 0
    for j in range(groups):
        row_cum_lo[j] = row_acc
        slot_offset[j] = slot_acc
        c = counts[j] if j < len(counts) else 0
        row_acc += c
        slot_acc += c * (spec.min + j)
    return Plan(spec, slot_acc, row_cum_lo, slot_offset)


def length_percents(spec: Spec) -> list[float]:
    """An even split across the possible lengths — the shares ``plan`` quotas by."""
    groups = spec.max - spec.min + 1
    return [100.0 / groups] * groups


def without(attrs: dict[str, str]) -> dict[str, str]:
    """The same attributes without ``repeat``, for building one element at a time."""
    return {k: v for k, v in attrs.items() if k != "repeat"}


def split(cell: str, separator: str) -> list[str]:
    """A cell back into its elements — a literal split, since a separator is data."""
    if not cell:
        return []
    return re.split(re.escape(separator), cell)


def item_key(card: int, position: int, lane: int, stride: int) -> int:
    """A stable id for one element of one row's list, unique across the whole run.

    Lanes keep two repeating sequences from minting the same id: each gets its own slice of the
    stride, so a child table keyed on this can hold both without a collision.
    """
    return (card - 1) * stride + lane + position


def _whole(text: str, raw: str, label: str) -> int:
    try:
        return int(text)
    except ValueError:
        raise ValueError(f'repeat: {label} of "{raw}" must be a whole number') from None
