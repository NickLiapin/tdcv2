"""Writing a run's output so a failed run leaves the destination as it found it.

The output is written to ``<path>.partial`` beside the destination and renamed over it only once
the run has finished; a run that fails removes the partial file and never touches the destination.
The rename is within one directory, so within one filesystem, and therefore atomic: a reader sees
the old file or the new one, never half of either.

Measured before this module, on all five implementations: a run that failed with ``-o out.csv``
truncated an existing ``out.csv`` to nothing — the previous, successful run's output gone — and one
of the five deleted it outright.

A symbolic link is resolved first and its TARGET written, so the link stays a link. A destination
that exists and is not a regular file (``-o /dev/stdout``, a named pipe) cannot be replaced by a
rename, so it is written directly — and so is one whose directory refuses a file beside it
(``/dev/stdout`` redirected to a file resolves to ``/dev/fd/1``). Both are written exactly as they
were before this module.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Any


def partial_path(path: Path) -> Path:
    """The partial file beside a destination."""
    return path.with_name(path.name + ".partial")


def _destination(path: Path) -> tuple[Path, bool]:
    """Where the bytes really go — the file behind a link — and whether a rename can replace it."""
    if not path.exists():
        return path, True
    real = Path(os.path.realpath(path))
    return real, real.is_file()


@contextmanager
def open_atomically(path: str | Path, mode: str, **kwargs: Any) -> Iterator[IO[Any]]:
    """``open(path, mode)`` whose destination changes only if the ``with`` body completes."""
    target, replaceable = _destination(Path(path))
    partial = None
    if replaceable:
        try:
            partial = partial_path(target).open(mode, **kwargs)
        except OSError:
            partial = None
    if partial is None:
        # In place, by the name it was given — exactly as before this module.
        with Path(path).open(mode, **kwargs) as out:
            yield out
        return
    temp = partial_path(target)
    try:
        with partial as out:
            yield out
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    os.replace(temp, target)
