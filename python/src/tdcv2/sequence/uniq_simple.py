"""``uniq="true"`` on a SIMPLE sequence: every row gets a different value.

A compound's ``uniq`` rearranges what was already drawn — it can keep the per-value
proportions because a tuple has room to vary. A single column has no such room:
proportions and uniqueness contradict each other the moment any value's share exceeds
one row. So here ``uniq`` changes the DRAW itself: values are sampled WITHOUT
REPLACEMENT. A weighted pool keeps its meaning — frequent values are more likely to
make the cut — but nothing appears twice.

Draw budget: exactly one PRNG draw per pick, whatever the pool — part of the
cross-language contract, like every other generator's budget. The reference is
``typescript/src/sequence/uniq-simple.ts``; the numbers here must match it byte for
byte.
"""

from __future__ import annotations

import math
import re

from ..generators import file as file_gen


class UniqSimpleError(RuntimeError):
    """A unique draw that cannot be completed — always with the numbers that decide it.

    A RuntimeError like the engine's own EngineError (which lives in engine/memory,
    importing this module — hence a class of our own rather than a cycle).
    """

_INT_RANGE = re.compile(r"^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$")

# The two template paths that are generators rather than lists — resolved before the
# pack registry everywhere, so they can never enumerate.
_GENERATOR_TEMPLATES = ("person.b_day", "date.range")


def build_unique_values(name: str, gen, count: int, run) -> list[str]:
    """``count`` pairwise-different values, or a refusal that names both numbers."""
    if gen.type == "number":
        return _unique_numbers(name, gen, count, run.prng)

    values, weights = _pool_of(name, gen, run)
    if len(values) < count:
        raise UniqSimpleError(
            f'uniq: sequence "{name}" cannot produce {count} unique values — its source '
            f"holds only {len(values)} distinct values. Add more values, or lower the count."
        )
    return _sample_without_replacement(values, weights, count, run.prng)


def _sample_without_replacement(values, weights, count: int, prng) -> list[str]:
    """One draw per pick: a point in the remaining total weight, walked in pool order."""
    remaining = list(weights)
    total = 0.0
    for w in remaining:
        total += w
    taken = [False] * len(remaining)
    out: list[str] = []
    for _ in range(count):
        target = prng.next() * total
        acc = 0.0
        picked = -1
        for i, w in enumerate(remaining):
            if taken[i]:
                continue
            acc += w
            if target < acc:
                picked = i
                break
        # Floating summation can leave the target a hair past the last value's edge;
        # the last remaining value is the only honest answer then.
        if picked < 0:
            for i in range(len(remaining) - 1, -1, -1):
                if not taken[i]:
                    picked = i
                    break
        if picked < 0:
            break
        taken[picked] = True
        total -= remaining[picked]
        out.append(values[picked])
    return out


def _unique_numbers(name: str, gen, count: int, prng) -> list[str]:
    """Unique integers from a plain ``a..b`` range: draw normally, redraw on a repeat."""
    bounds = _plain_int_range(gen)
    if bounds is None:
        raise UniqSimpleError(f'uniq: sequence "{name}" — {unsupported_reason(gen)}')
    lo, hi = bounds
    size = hi - lo + 1
    if size < count:
        raise UniqSimpleError(
            f'uniq: sequence "{name}" cannot produce {count} unique values — the range '
            f"{lo}..{hi} holds only {size} integers. Widen the range, or lower the count."
        )
    seen: set[int] = set()
    out: list[str] = []
    while len(out) < count:
        n = lo + math.floor(prng.next() * size)
        if n in seen:
            continue
        seen.add(n)
        out.append(str(n))
    return out


def unsupported_reason(gen) -> str:
    """Why this gen cannot take the without-replacement path, for the refusal."""
    if gen.type == "number":
        return (
            "its values are not a plain integer range — uniq supports value=\"a..b\" "
            "without decimals=, distribution=, include=, exclude= or first_zero="
        )
    return (
        f'its values cannot be enumerated (type="{gen.type}") — uniq on a simple sequence '
        "supports text lists, template packs, file columns and plain integer ranges"
    )


def _plain_int_range(gen) -> tuple[int, int] | None:
    for blocked in ("distribution", "decimals", "include", "exclude", "first_zero"):
        if gen.attrs.get(blocked, "").strip():
            return None
    m = _INT_RANGE.match(gen.attrs.get("value", ""))
    if not m:
        return None
    lo, hi = int(m.group(1)), int(m.group(2))
    return (lo, hi) if lo <= hi else None


def _pool_of(name: str, gen, run) -> tuple[list[str], list[float]]:
    """The distinct values a gen can produce, with weights; duplicates merge."""
    if gen.type == "text" and not gen.attrs.get("percent", "").strip():
        values = [s.strip() for s in gen.attrs.get("value", "").split(",")]
        return _merge_duplicates(values, None)
    if gen.type == "template":
        path = gen.attrs.get("value", "")
        if path in _GENERATOR_TEMPLATES:
            raise UniqSimpleError(
                f'uniq: sequence "{name}" — template "{path}" does not resolve to a value '
                "list, so its values cannot be enumerated for a unique draw"
            )
        # `local=` on the <gen> picks the pack here too -- a unique draw over a German
        # surname list must enumerate the German file, not the English one.
        entry = run.packs.load(path, gen.attrs.get("local") or run.config.locale)
        if entry.is_generator or not entry.values:
            raise UniqSimpleError(
                f'uniq: sequence "{name}" — template "{path}" does not resolve to a value '
                "list, so its values cannot be enumerated for a unique draw"
            )
        weights = list(entry.percents) if entry.weighted and entry.percents else None
        return _merge_duplicates(list(entry.values), weights)
    if gen.type == "file" and not gen.attrs.get("row", "").strip():
        weighted = file_gen.load_weighted(gen.attrs, run.base_dir, run.packs.data_roots)
        if weighted is not None:
            return _merge_duplicates(list(weighted.values), list(weighted.percents))
        values = file_gen.load(gen.attrs, run.base_dir, run.packs.data_roots)
        return _merge_duplicates(list(values), None)
    raise UniqSimpleError(f'uniq: sequence "{name}" — {unsupported_reason(gen)}')


def _merge_duplicates(values, weights) -> tuple[list[str], list[float]]:
    index: dict[str, int] = {}
    out_values: list[str] = []
    out_weights: list[float] = []
    for i, value in enumerate(values):
        weight = weights[i] if weights is not None else 1.0
        at = index.get(value)
        if at is None:
            index[value] = len(out_values)
            out_values.append(value)
            out_weights.append(weight)
        else:
            out_weights[at] += weight
    return out_values, out_weights
