"""``| json`` on a list — TDC312.

A ``repeat=`` column is a LIST joined into one cell with its separator, and ``| json`` cannot see
that: it reads text. Without its argument it prints the whole cell as one string,
``"English;Spanish"``, which is valid JSON and almost never what the config meant. With an argument
that is not the column's separator it prints a one-element array. Both run, both produce a file
that parses, and the mistake surfaces in whatever reads the file — so ``check`` says so here,
naming the separator to write.

Which lists exist is gathered by the validator (it owns the tree walking); this module only reads
one ``<data>`` body against that map.
"""

from __future__ import annotations

import re

_INTERP_REF = re.compile(r"\$\{\{([^}]*)\}\}")


def _writable(separator: str) -> bool:
    """A separator ``json:`` can carry.

    The argument is trimmed, a ``|`` starts the next filter and a ``}`` ends the reference, so a
    list joined with any of those cannot be named after the colon.
    """
    return bool(separator.strip()) and "|" not in separator and "}" not in separator


def check(text: str, lists: dict[str, str], walked=()) -> list[tuple[str, str]]:
    """``(message, hint)`` per ``${{List | json}}`` not splitting on the list's separator.

    ``walked`` are the lists an ``each`` line and its groups walk: there a name is the ELEMENT.
    """
    out: list[tuple[str, str]] = []
    if not lists:
        return out
    for m in _INTERP_REF.finditer(text):
        raw_name, *pieces = m.group(1).split("|")
        name = raw_name.strip()
        separator = lists.get(name)
        if separator is None or name in walked:
            continue
        for piece in pieces:
            colon = piece.find(":")
            if (piece if colon < 0 else piece[:colon]).strip() != "json":
                continue
            arg = None if colon < 0 else piece[colon + 1 :].strip()
            # `json:` with nothing after it is TDC273's to report, and one complaint is enough.
            if arg == "":
                continue
            want = separator.strip()
            if arg == want:
                continue
            message = (
                f'"{name}" is a list joined with "{separator}", and | json prints it as one string'
                if arg is None
                else f'| json:{arg} splits on "{arg}", but "{name}" is joined with "{separator}"'
            )
            hint = (
                f"Write ${{{{{name} | json:{want}}}}} for a JSON array of its elements."
                if _writable(separator)
                else f'"{separator}" cannot be written after json: — give the list another '
                'separator=, such as ";".'
            )
            out.append((message, hint))
    return out
