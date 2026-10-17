"""``each="NAME"`` on a ``<line>`` — one output line per element of a list or record of a pool.

Shared by the in-memory and the streaming engine, which used to carry a copy each. Both copies
asked a ``<data if=…>`` once per ROW, so a condition naming the element — ``_item``, or the list
itself — saw the row instead; the reference asks it once per element, with the element in scope.

The walked name is a list (a ``repeat=`` sequence) or a pool. A list element overlays the name
itself; a pool record overlays every field as ``Pool.field``, nested records included
(``Doctors.dept.name``), since the pool table publishes them under those paths. The line's own
``if=`` is asked of each element too, and the positions — ``Pool._item``, ``Pool._first``,
``Pool._last`` — are counted over the elements it KEEPS: ``_last`` is the last line printed, which
is what a JSON array needs to know before its comma, whatever the filter dropped after it.
"""

from __future__ import annotations

from collections.abc import Callable

from ..expr import as_condition
from ..format import interpolate
from ..generators import repeat as repeat_gen

POSITIONS = ("_item", "_first", "_last")


def render(
    line,
    name: str,
    row: int,
    inject: str,
    each_info,
    pools,
    value: Callable[[str], str | None],
    has: Callable[[str], bool],
) -> list[str]:
    """The output lines of one ``each`` line on one row, each with its newline attached."""
    candidates: list[dict[str, str]] = []
    table = None if has(name) else (pools or {}).get(name)
    if table is not None:
        for m in range(table.count):
            overlay = {"_item": str(m + 1), "_item_id": str(m + 1)}
            for field in table.fields:
                overlay[f"{name}.{field}"] = table.columns[field][m]
            candidates.append(overlay)
    else:
        spec = each_info.get(name)
        separator = repeat_gen.DEFAULT_SEPARATOR if spec is None else spec.separator
        elements = repeat_gen.split(value(name) or "", separator)
        # Lanes: two repeating sequences write into the same child table, so each gets its own
        # slice of every card's key block rather than sharing one counter.
        lane = 0
        stride = 0
        for other, info in each_info.items():
            if other == name:
                lane = stride
            stride += info.max
        if stride == 0:
            stride = len(elements)
        for k, element in enumerate(elements):
            candidates.append(
                {
                    name: element,
                    "_item": str(k + 1),
                    "_item_id": str(repeat_gen.item_key(row + 1, k + 1, lane, stride)),
                }
            )

    def views(overlay: dict[str, str]):
        def look(n: str) -> str | None:
            return overlay[n] if n in overlay else value(n)

        def known(n: str) -> bool:
            return n in overlay or has(n)

        return look, known

    def holds(expression: str | None, overlay: dict[str, str]) -> bool:
        if expression is None:
            return True
        look, known = views(overlay)
        return as_condition(expression, known, lambda n: look(n) or "")

    kept = [overlay for overlay in candidates if holds(line.if_expr, overlay)]
    out = []
    for k, overlay in enumerate(kept):
        overlay = {
            **overlay,
            f"{name}._item": str(k + 1),
            f"{name}._first": "true" if k == 0 else "false",
            f"{name}._last": "true" if k == len(kept) - 1 else "false",
        }
        template = "".join(part.text for part in line.parts if holds(part.if_expr, overlay))
        out.append(interpolate.apply(template, inject, views(overlay)[0]) + "\n")
    return out
