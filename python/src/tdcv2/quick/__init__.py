"""The quick API: one value, one line, no config file.

    from tdcv2 import tdc

    tdc.person.male.first_name()          # John  -- no: see the rule below
    tdc.person.male.firstName()           # John
    tdc.country.usa.docs.ssn()            # 690070001, check digits and all
    tdc.lang.ru.person.lastName()         # Иванов
    tdc.person.lastName.many(10)          # ten of them
    tdc.seed("demo").locale("ru").person.lastName()
    tdc.gen.number("20..30")              # "23"

ONE RULE: a dot in the code is a dot in the address, and a segment is spelled
the way the pack spells it. ``person.male.firstName`` here is
``person.male.firstName`` in a config, in the reference, and in the TypeScript
quick API. That is why the names are camelCase in a Python module: they are not
Python identifiers we chose, they are addresses the data already has. Renaming
them to ``first_name`` would be a second vocabulary to keep in step with the
docs and with four other implementations, and ``getattr`` would still be the
only way to reach an address held in a variable.

A leading segment may be left out, exactly as in a config: then the address is
read against the active locale. ``tdc.person.lastName()`` gives Williams in
``en`` and Иванов in ``ru``.

To name a pack outright, say what kind it is: ``tdc.lang.ru.…`` for a language
and ``tdc.country.usa.…`` for a country. Those two words carry no meaning inside
an address — they are there so that the first name after ``tdc.`` stays a
CATEGORY rather than one of a hundred-odd locale and country codes.

WHAT THIS IS NOT. Every call is independent. Nothing here ties one value to
another — no ``<switch>`` on a drawn column, no ``parent=``, no ``uniq``, no
``<compute>``. A coherent record is a config; this is the drawer of loose values
that a faker occupies, answered from the same data packs.

Values are always strings, including numbers and dates: the engine's world is
text, and a result type that changed with the address would be a different
contract in every implementation.

The seed scheme is the TypeScript one, deliberately: the same seed and address
give the same value in both, and a test pins that.
"""

from __future__ import annotations

from .draw import BATCH_ROWS, QuickDraw, TdcQuickError
from .proxy import RESERVED_PATH_NAMES, RESERVED_ROOT_NAMES, Quick, tdc

__all__ = [
    "BATCH_ROWS",
    "RESERVED_PATH_NAMES",
    "RESERVED_ROOT_NAMES",
    "Quick",
    "QuickDraw",
    "TdcQuickError",
    "tdc",
]
