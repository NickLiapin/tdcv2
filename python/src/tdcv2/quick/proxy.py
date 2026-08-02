"""What ``tdc.person.lastName()`` actually is.

Three objects, each answering ``__getattr__`` by building the next one:

* :class:`Quick` — the root. Knows ``seed``, ``locale``, ``gen``, and the two
  signposts ``lang`` and ``country``; anything else starts an address.
* :class:`_Address` — a partial address that is also callable. Calling it draws
  one value; ``.many(n)`` draws n.
* :class:`_Gen` — ``tdc.gen.<type>(…)``, the engine's own generators, which take
  attributes rather than addresses.

Attribute access is the whole interface, so the guard rails matter more than the
code does. Python looks dunders up on the TYPE, not the instance, but plenty of
libraries reach for ordinary-looking names behind the reader's back — ``pytest``
asks for ``__wrapped__``, ``copy`` for ``__deepcopy__``, IPython for
``_ipython_canary_method_should_not_exist_``. Answering those with a live
address makes the object lie about what it is, so they are refused with the
``AttributeError`` the caller is testing for.
"""

from __future__ import annotations

from secrets import token_hex
from typing import Any

from .draw import QuickDraw

#: Words the API answers to at the ROOT, so no data CATEGORY may be called one of
#: them. ``location.country`` is fine — ``country`` there is a leaf, and only the
#: first name after ``tdc.`` is intercepted.
RESERVED_ROOT_NAMES = frozenset({"gen", "seed", "locale", "lang", "country"})

#: Words the API answers to at EVERY level of an address, so no segment anywhere
#: may be called one of them. There is exactly one, and a test holds the bundled
#: packs to it.
RESERVED_PATH_NAMES = frozenset({"many"})


def _is_a_segment(name: str) -> bool:
    """Whether a name is the reader asking for data, rather than the runtime probing."""
    return not (name.startswith("_") or name.endswith("__"))


def _attributes(params: dict[str, Any] | None) -> dict[str, str]:
    return {k: str(v) for k, v in (params or {}).items()}


class _Address:
    """A dotted address under construction, which is also the call that draws it."""

    __slots__ = ("_draw", "_segments")

    def __init__(self, draw: QuickDraw, segments: tuple[str, ...]) -> None:
        self._draw = draw
        self._segments = segments

    def __getattr__(self, name: str) -> _Address:
        if not _is_a_segment(name):
            raise AttributeError(name)
        return _Address(self._draw, (*self._segments, name))

    def __call__(self, **params: Any) -> str:
        return self._drawn(1, params)[0]

    def many(self, count: int, **params: Any) -> list[str]:
        return self._drawn(count, params)

    def _drawn(self, count: int, params: dict[str, Any]) -> list[str]:
        attrs = {"value": ".".join(self._segments), **_attributes(params)}
        return self._draw.draw("template", attrs, count)

    def __repr__(self) -> str:
        return f"<tdcv2 address {'.'.join(self._segments)}>"


class _GenCall:
    """One engine generator: ``tdc.gen.number("20..30")`` or ``.many(5, value=…)``."""

    __slots__ = ("_draw", "_type")

    def __init__(self, draw: QuickDraw, gen_type: str) -> None:
        self._draw = draw
        self._type = gen_type

    def __call__(self, value: str | None = None, **params: Any) -> str:
        return self._drawn(1, value, params)[0]

    def many(self, count: int, value: str | None = None, **params: Any) -> list[str]:
        return self._drawn(count, value, params)

    def _drawn(self, count: int, value: str | None, params: dict[str, Any]) -> list[str]:
        attrs = _attributes(params)
        # A bare string argument is the `value` attribute, which is what nearly
        # every call wants: tdc.gen.number("20..30") rather than value="20..30".
        if value is not None:
            attrs = {"value": str(value), **attrs}
        return self._draw.draw(self._type, attrs, count)

    def __repr__(self) -> str:
        return f"<tdcv2 gen {self._type}>"


class _Gen:
    """``tdc.gen.<type>`` — the generators, which live under one name because the
    pack categories are already called ``date``, ``text`` and ``word``, so the top
    level is not free."""

    __slots__ = ("_draw",)

    def __init__(self, draw: QuickDraw) -> None:
        self._draw = draw

    def __getattr__(self, name: str) -> _GenCall:
        if not _is_a_segment(name):
            raise AttributeError(name)
        return _GenCall(self._draw, name)

    def __repr__(self) -> str:
        return "<tdcv2 gen>"


class _Pack:
    """What ``lang`` and ``country`` are: whatever name comes next starts the
    address. ``tdc.country.usa.docs.ssn()`` is the address ``usa.docs.ssn``."""

    __slots__ = ("_draw",)

    def __init__(self, draw: QuickDraw) -> None:
        self._draw = draw

    def __getattr__(self, name: str) -> _Address:
        if not _is_a_segment(name):
            raise AttributeError(name)
        return _Address(self._draw, (name,))

    def __repr__(self) -> str:
        return "<tdcv2 pack>"


class Quick:
    """The object exported as ``tdc``.

    ``seed()`` and ``locale()`` return a NEW object rather than changing this one,
    so two tests can hold different seeds at the same time and neither leaks into
    the other.
    """

    __slots__ = ("_draw", "_locale", "_seed")

    def __init__(self, seed: str, locale: str | None) -> None:
        self._seed = seed
        self._locale = locale
        self._draw = QuickDraw(seed, locale)

    def seed(self, value: str) -> Quick:
        return Quick(value, self._locale)

    def locale(self, value: str) -> Quick:
        return Quick(self._seed, value)

    @property
    def gen(self) -> _Gen:
        return _Gen(self._draw)

    @property
    def lang(self) -> _Pack:
        return _Pack(self._draw)

    @property
    def country(self) -> _Pack:
        return _Pack(self._draw)

    def __getattr__(self, name: str) -> _Address:
        if not _is_a_segment(name):
            raise AttributeError(name)
        return _Address(self._draw, (name,))

    def __repr__(self) -> str:
        where = "" if self._locale is None else f" locale={self._locale}"
        return f"<tdcv2 quick seed={self._seed}{where}>"


#: The default entry point: random per process, locale from the project config.
#:
#: Without ``tdc.seed(...)`` the quick API is random per process, the way a faker
#: is — a test that wants the same values twice asks for them by name.
tdc = Quick(token_hex(8), None)
