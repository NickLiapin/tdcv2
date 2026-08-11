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

# Bounded retries before a `distinct` draw admits it cannot find a fresh value.
DISTINCT_MAX_TRIES = 64
DEFAULT_SEPARATOR = ","


@dataclass(frozen=True, slots=True)
class Spec:
    min: int
    max: int
    separator: str
    #: ``accumulate=``: the list is replaced by its running total before joining.
    accumulate: str | None = None
    #: ``distinct=``: the row's values are drawn WITHOUT replacement.
    #:
    #: This changes the regime the column is built in, which is why ``percent`` is refused
    #: beside it. Ordinarily a listed column lays its values out over the whole run as an
    #: exact quota; under ``distinct`` it draws per row instead, because holding an exact
    #: whole-run quota AND a per-row guarantee at once costs either streaming or the
    #: randomness of the sample. Frequencies stay approximate, rows stay independent.
    distinct: bool = False


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
        read_distinct(attrs),
    )


def read_distinct(attrs: dict[str, str]) -> bool:
    """``distinct="true"``. Anything but the two words is refused by the validator."""
    return attrs.get("distinct", "").strip() == "true"


def draw_distinct(
    values: list[str],
    weights: list[float],
    keep: int,
    next_uniform: Callable[[], float],
    describe_pool: Callable[[], str],
) -> list[str]:
    """Draw ``keep`` DIFFERENT values from a weighted list, one uniform per pick.

    Weights survive — a frequent name is still likelier to be picked first — but the exact
    whole-run quota does not, which is the documented price of ``distinct`` and the reason
    ``percent`` may not appear beside it.

    Running out throws rather than returning a short list: a cell quietly shorter than
    ``repeat`` asked for is the silent-and-wrong outcome the feature exists to prevent.
    """
    if keep > len(values):
        raise ValueError(
            f'repeat with distinct="true" asks for {keep} different values, '
            f"but {describe_pool()} holds only {len(values)}"
        )

    # Weighted draw without replacement: pick against the remaining weight, then swap the
    # winner out with the last live candidate. The order of what remains is a pure function
    # of the picks already made, so the draw stays deterministic.
    pool = list(values)
    w = list(weights) if len(weights) == len(values) else [1.0] * len(values)
    total = sum(x for x in w if x > 0)

    out: list[str] = []
    for picked in range(keep):
        size = len(pool) - picked
        index = size - 1
        if total > 0:
            target = next_uniform() * total
            for i in range(size):
                target -= max(0.0, w[i])
                if target < 0:
                    index = i
                    break
        else:
            index = min(size - 1, int(next_uniform() * size))
        chosen = pool[index]
        out.append(chosen)
        total -= max(0.0, w[index])
        last = size - 1
        pool[index] = pool[last]
        w[index] = w[last]
        pool[last] = chosen
    return out


def redraw_until_fresh(
    seen: list[str],
    gen_type: str,
    draw: Callable[[str], str],
) -> str:
    return redraw_until_fresh_at(seen, gen_type, draw)[0]


def redraw_until_fresh_at(
    seen: list[str],
    gen_type: str,
    draw: Callable[[str], str],
) -> tuple[str, str]:
    """The same loop, reporting WHICH sub-stream won.

    The anomaly flag needs this. A flag is resolved by re-running the element's draw and
    asking whether it spiked — and under ``distinct`` the value that survived may have come
    from ``r3`` rather than the first attempt. Resolving the flag on the first attempt would
    describe a value that was thrown away: the list would say ``false`` beside a number that
    plainly spiked, which is worse than no flag at all.
    """
    """Ask ``draw`` for a value that is not already in ``seen``.

    A drawn generator has no pool to draw down, so ``distinct`` is rejection sampling.
    ``draw`` receives the sub-stream suffix: empty for the first attempt (so a config
    WITHOUT ``distinct`` reads the very same stream), then ``r1``, ``r2`` and so on.

    Exhausting the tries throws rather than returning a duplicate or a short list.
    ``regex="[01]"`` under ``repeat="5"`` cannot be satisfied by anything, and saying so is
    the entire point of the attribute.
    """
    suffix = ""
    value = draw(suffix)
    attempt = 1
    while value in seen and attempt <= DISTINCT_MAX_TRIES:
        suffix = f"r{attempt}"
        value = draw(suffix)
        attempt += 1
    if value in seen:
        raise ValueError(
            f'repeat with distinct="true" could not find {len(seen) + 1} different values '
            f'for <gen type="{gen_type}"> after {DISTINCT_MAX_TRIES} tries — '
            "the generator does not produce that many"
        )
    return value, suffix


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
