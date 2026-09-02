"""A byte count written the way a person would say it.

``800 B``, ``2.6 KB``, ``123 KB``, ``20.5 GB``.

Why this exists
---------------

Every one of the 294 shipped packs is smaller than a quarter of a megabyte —
the largest is 248 KB and 120 are under 10 KB. Printed in megabytes to one
decimal, as ``pack list`` did, the whole catalogue collapsed into three
strings: ``0.0 MB`` for 194 packs, ``0.1 MB`` for 53, ``0.2 MB`` for the last
47.

A size that cannot tell two packs apart is not a size, it is a decoration; and
``0.0`` actively misinforms, because it reads as "nothing" when the honest
answer is "three kilobytes".

The rules are the ones people already read without noticing:

* below a kilobyte, whole bytes — ``800 B``, never ``0.8 KB``
* below a hundred of a unit, one decimal — ``2.6 KB`` distinguishes packs that
  ``3 KB`` does not
* at a hundred and above, whole numbers — ``123 KB``, because a tenth of a
  kilobyte there is noise

Why the arithmetic looks like this
----------------------------------

All five implementations must produce the same string for the same number: a
shared CLI fixture compares their output byte for byte, so a size that differs
in the last digit is a five-way parity failure. Hence integers throughout — no
float division, no format-spec rounding, and no reliance on how a language
happens to round a half.
"""

#: Kilobyte upwards. Terabytes are the end of it; nothing here measures more.
_UNITS = ("KB", "MB", "GB", "TB")


def _tenths(n: int, d: int) -> int:
    """``round(n * 10 / d)``, without ever forming ``n * 10``.

    The product overflows a signed 64-bit integer above about 800 petabytes in
    the ports that have one, and this file has to agree with them digit for
    digit. Splitting the division is exact for every size any of the five will
    be handed.
    """
    whole, rest = divmod(n, d)
    return whole * 10 + (rest * 10 + d // 2) // d


def human_bytes(size: int) -> str:
    n = int(size)
    if n <= 0:
        return "0 B"
    if n < 1024:
        return f"{n} B"

    # Climb to the unit the number reads in, and one further when rounding has
    # pushed it to a whole 1024 of that unit — 1023.6 KB is 1.0 MB, and nobody
    # writes the other one.
    d = 1024
    unit = _UNITS[0]
    tenths = _tenths(n, d)
    for nxt in _UNITS[1:]:
        if n < d * 1024 and tenths < 10_235:
            break
        d *= 1024
        unit = nxt
        tenths = _tenths(n, d)
    if tenths < 1000:
        return f"{tenths // 10}.{tenths % 10} {unit}"
    return f"{(tenths + 5) // 10} {unit}"
