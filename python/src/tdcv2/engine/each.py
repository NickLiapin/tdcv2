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
from ..model.config import Group


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
    out = []
    for overlay in _overlays(name, line.if_expr, row, each_info, pools, value, has):
        look, known = _views(overlay, value, has)
        template = "".join(part.text for part in line.parts if _holds(part.if_expr, look, known))
        out.append(interpolate.apply(template, inject, look) + "\n")
    return out


def render_group(
    group,
    row: int,
    inject: str,
    each_info,
    pools,
    value: Callable[[str], str | None],
    has: Callable[[str], bool],
) -> list[str]:
    """``<group>``: its lines and groups, once per element it walks — or once, or not at all.

    With ``each`` the items print once per element of a list or record of a pool, with that
    element in scope for every one of them, so an inner ``each`` can keep the doctors of the
    department being printed (``Doctors.dept.id == Depts.id``). Without it, ``if`` decides all of
    them at once, in the scope around the group.
    """
    name = (group.each or "").strip()
    if name:
        overlays = _overlays(name, group.if_expr, row, each_info, pools, value, has)
    else:
        overlays = [{}] if _holds(group.if_expr, value, has) else []
    out: list[str] = []
    for overlay in overlays:
        look, known = _views(overlay, value, has)
        for item in group.items:
            out.extend(render_item(item, row, inject, each_info, pools, look, known))
    return out


def render_item(
    item,
    row: int,
    inject: str,
    each_info,
    pools,
    value: Callable[[str], str | None],
    has: Callable[[str], bool],
) -> list[str]:
    """One line or group inside a group, in the scope the groups around it put in place."""
    if isinstance(item, Group):
        return render_group(item, row, inject, each_info, pools, value, has)
    name = None if item.each is None else item.each.strip()
    if name:
        return render(item, name, row, inject, each_info, pools, value, has)
    if not _holds(item.if_expr, value, has):
        return []
    template = "".join(part.text for part in item.parts if _holds(part.if_expr, value, has))
    return [interpolate.apply(template, inject, value) + "\n"]


def _overlays(
    name: str,
    keep: str | None,
    row: int,
    each_info,
    pools,
    value: Callable[[str], str | None],
    has: Callable[[str], bool],
) -> list[dict[str, str]]:
    """One overlay per element printed, positions included, after ``keep`` has dropped some."""
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

    kept = [o for o in candidates if _holds(keep, *_views(o, value, has))]
    return [
        {
            **overlay,
            f"{name}._item": str(k + 1),
            f"{name}._first": "true" if k == 0 else "false",
            f"{name}._last": "true" if k == len(kept) - 1 else "false",
        }
        for k, overlay in enumerate(kept)
    ]


def _views(overlay: dict[str, str], value, has):
    """The scope around, with one element's names laid over it."""

    def look(n: str) -> str | None:
        return overlay[n] if n in overlay else value(n)

    def known(n: str) -> bool:
        return n in overlay or has(n)

    return look, known


def _holds(expression: str | None, look, known) -> bool:
    if expression is None:
        return True
    return as_condition(expression, known, lambda n: look(n) or "")
