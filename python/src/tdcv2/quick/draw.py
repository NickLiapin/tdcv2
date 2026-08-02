"""The machinery under the quick API: one generator, an endless stream of values.

A quick call has to look like ``faker.person.first_name()`` and cost about what
that costs. Two measured facts shape everything here, and they are the same two
the TypeScript implementation is built around.

FIRST, values depend on the row COUNT, not only on the seed. The same config run
with ``count="3"`` yields ``John | Robert | James``, and run three times with
``count="1"`` yields ``James | James | James``. So a call cannot mean "render one
row", or a loop of calls returns the same value forever. It means "take the next
value from a stream".

SECOND, iteration is lazy: the first three values of a config declaring a
million rows arrive at once. So a stream is cheap to open and cheap to abandon.

A stream is therefore a run of ``BATCH_ROWS`` rows; when it is exhausted the next
run starts under a seed derived from the batch number, so the sequence continues
without bound and stays reproducible from the same starting seed.

Every number and every string here is part of the cross-language contract. The
batch size, the ``#`` in the derived seed, the sequence name ``V`` and the shape
of the synthesised config all match ``typescript/src/quick/draw.ts`` exactly,
which is what makes the same seed give the same values in both.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

from ..packs import DataPacks
from ..tdc import TDC

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pathlib import Path

#: Rows per underlying run. Small enough that opening a stream is free, large
#: enough that a test drawing a few hundred values never reopens one.
#:
#: This number is part of the contract: change it and every seeded value changes,
#: because the draw depends on the declared count.
BATCH_ROWS = 512


class TdcQuickError(Exception):
    """Raised for anything the quick API can explain better than the engine can."""


def _escape(value: str) -> str:
    if '"' in value:
        raise TdcQuickError(f"a double quote is not allowed in a generator value: {value}")
    return value


def _config_for(gen_type: str, attrs: dict[str, str], locale: str | None, seed: str) -> str:
    rendered = "".join(f' {name}="{_escape(value)}"' for name, value in attrs.items())
    local = "" if locale is None else f' local="{_escape(locale)}"'
    return (
        f'<tdc><env count="{BATCH_ROWS}" seed="{_escape(seed)}"{local}>'
        f'<sequence name="V"><gen type="{gen_type}"{rendered}/></sequence></env>'
        "<block><line><data>${{V}}</data></line></block></tdc>"
    )


def _key_of(gen_type: str, attrs: dict[str, str]) -> str:
    pairs = "&".join(f"{k}={v}" for k, v in sorted(attrs.items()))
    return f"{gen_type}|{pairs}"


def _distance(a: str, b: str) -> int:
    """Edit distance, only ever used to say "did you mean"."""
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        carry = prev[0]
        prev[0] = i
        for j in range(1, len(b) + 1):
            keep = prev[j]
            prev[j] = min(prev[j] + 1, prev[j - 1] + 1, carry + (0 if a[i - 1] == b[j - 1] else 1))
            carry = keep
    return prev[len(b)]


def _known_addresses(cwd: Path | None = None) -> list[str]:
    """Every address reachable right now — bundled packs plus the project's own."""
    try:
        return list(DataPacks.for_project(cwd).addresses())
    except Exception:  # pragma: no cover - a broken config must not hide the real error
        return []


def _nearest(typed: str, locale: str, known: list[str]) -> str | None:
    """The nearest reachable address to what was typed.

    Compared against the address as written AND against its locale-qualified
    form, because ``person.firstNam`` and ``en.person.firstNam`` are the same
    typo seen from two sides.
    """
    qualified = f"{locale}.{typed}"
    best: str | None = None
    best_score = len(typed) + len(qualified)
    for address in known:
        score = min(_distance(typed, address), _distance(qualified, address))
        if score < best_score:
            best_score, best = score, address
    # Three edits away is a different address, not a typo.
    return best if best_score <= 3 else None


def _uninstalled_pack(address: str, known: list[str]) -> str | None:
    """The pack an address names, when that pack is real but not on this machine.

    A wheel carries a starter set — ``common``, ``en``, ``usa`` — and the registry
    carries the other hundred-odd. So ``tdc.lang.ru.person.lastName()`` on a fresh
    install fails not because ``ru`` is a typo but because ``ru`` has not been
    downloaded, and answering it with "did you mean en.person.lastName?" answers a
    question the caller did not ask: they wanted Russian.

    The test is structural rather than a table of locale codes, so it holds for
    packs that do not exist yet: nothing at all sits under the first segment, but
    the REST of the address resolves somewhere. That is a name standing where a
    pack goes. A typo in the tail (``ru.person.lastNam`` with ``ru`` installed, or
    ``persn.lastName``) fails one of the two halves and falls through to the
    nearest address.
    """
    head, _, tail = address.partition(".")
    if not head or not tail:
        return None
    prefix = f"{head}."
    if any(a.startswith(prefix) for a in known):
        return None
    suffix = f".{tail}"
    if any(a == tail or a.endswith(suffix) for a in known):
        return head
    return None


class QuickDraw:
    """Streams held open per generator, for one seed and one locale.

    Keyed by the generator and its attributes: two different addresses draw
    independently, and the same address asked twice continues where it left off.
    """

    __slots__ = ("_cursors", "_locale", "_seed")

    def __init__(self, seed: str, locale: str | None) -> None:
        self._seed = seed
        self._locale = locale
        self._cursors: dict[str, tuple[list[int], Iterator[Any]]] = {}

    def draw(self, gen_type: str, attrs: dict[str, str], count: int) -> list[str]:
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise TdcQuickError(f"count must be a positive whole number, got {count!r}")
        key = _key_of(gen_type, attrs)
        cursor = self._cursors.get(key)
        if cursor is None:
            cursor = ([0], self._open(gen_type, attrs, 0))
            self._cursors[key] = cursor

        batch, rows = cursor
        out: list[str] = []
        while len(out) < count:
            row = next(rows, None)
            if row is None:
                batch[0] += 1
                rows = self._open(gen_type, attrs, batch[0])
                self._cursors[key] = (batch, rows)
                continue
            # One sequence, one column: the row is {"V": <the value>}, and the value
            # of a scalar sequence is a string. A compound row cannot appear here —
            # this layer never builds one.
            value = row["V"]
            out.append(value if isinstance(value, str) else "")
        return out

    def _open(self, gen_type: str, attrs: dict[str, str], batch: int) -> Iterator[Any]:
        seed = self._seed if batch == 0 else f"{self._seed}#{batch}"
        try:
            data = TDC(config_string=_config_for(gen_type, attrs, self._locale, seed))
        except Exception as error:
            raise self._explain(gen_type, attrs, error) from None
        return iter(data)

    def _explain(self, gen_type: str, attrs: dict[str, str], error: Exception) -> Exception:
        """Turn an engine diagnostic about a config the caller never wrote into a
        sentence about the call they did write — but ONLY when the address really
        is what went wrong.

        Rewriting every failure cost an hour once: an attribute the validator
        refused came back as `unknown address "common.internet.email". Did you
        mean "common.internet.email"?`, which is nonsense and hides the one line
        that said what was actually wrong. Anything the address cannot explain is
        raised as it came.
        """
        if gen_type != "template":
            return error
        address = attrs.get("value", "")
        locale = self._locale or "en"
        known = _known_addresses()
        missing = _uninstalled_pack(address, known)
        if missing is not None:
            return TdcQuickError(
                f'the "{missing}" pack is not installed, so "{address}" cannot be drawn. '
                f"Install it with `tdcv2 pack add {missing}` "
                "(run `tdcv2 init` once first, to say where packs go)."
            )
        if address in known or f"{locale}.{address}" in known:
            return error
        near = _nearest(address, locale, known)
        hint = "" if near is None else f'. Did you mean "{near}"?'
        return TdcQuickError(f'unknown address "{address}" (locale "{locale}"){hint}')
