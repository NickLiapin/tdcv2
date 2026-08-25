"""What the validator has to say about a config, and where.

Every complaint carries a stable ``TDC###`` code. The code is the contract between the
implementations — the wording is edited for clarity over time, and holding three languages to a
sentence would make every improvement a breaking change. The position is part of it too: it is
what an editor underlines, and a diagnostic pointing at the wrong place has named the file rather
than the mistake.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Severity(str, Enum):
    """Worth stopping for, or worth saying."""

    ERROR = "error"
    WARNING = "warning"

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class Diagnostic:
    """One complaint: what is wrong, where, and what to do about it."""

    severity: Severity
    code: str
    message: str
    hint: str
    line: int
    column: int
    #: The near name, when there is one: ``did you mean "person.male.firstName"?``
    #:
    #: Its own line rather than a sentence folded into the hint, because it is the one part a
    #: reader can act on without reading anything else — and because the reference prints it as
    #: ``help:``, above the ``note:``. Folded in, it arrived buried; left out, the reader was
    #: told a name is wrong and not what the right one is.
    suggestion: str = ""

    @staticmethod
    def error(
        code: str, message: str, hint: str, line: int, column: int, suggestion: str = ""
    ) -> Diagnostic:
        return Diagnostic(Severity.ERROR, code, message, hint, line, column, suggestion)

    @staticmethod
    def warning(
        code: str, message: str, hint: str, line: int, column: int, suggestion: str = ""
    ) -> Diagnostic:
        return Diagnostic(Severity.WARNING, code, message, hint, line, column, suggestion)

    def signature(self) -> str:
        """The shape the shared fixtures record: severity, code and position — never wording."""
        return f"{self.severity} {self.code} {self.line}:{self.column}"

    def __str__(self) -> str:
        return f"{self.severity} {self.code} (line {self.line}, col {self.column}): {self.message}"


def has_errors(diagnostics: list[Diagnostic]) -> bool:
    return any(d.severity is Severity.ERROR for d in diagnostics)


class TdcError(ValueError):
    """A config that cannot be run, with everything wrong with it rather than the first thing.

    Reporting one error at a time turns fixing a config into a guessing loop. The validator
    collects them all, and this carries the set — along with the source they refer to, so a caller
    that wants the full block can render the offending lines rather than only naming them.
    """

    def __init__(
        self,
        message: str,
        diagnostics: list[Diagnostic] | None = None,
        source: str | None = None,
    ) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or []
        self.source = source


def summarize(diagnostics: list[Diagnostic]) -> str:
    """The one-line form, for a caller that only logs ``str(error)``.

    Matches the reference implementation's wording, because a script that greps the message should
    not have to know which language produced it.
    """
    if not diagnostics:
        return "TDC: unknown error"
    first = diagnostics[0]
    if len(diagnostics) == 1:
        return f"{first.severity}: {first.message} (line {first.line}, col {first.column + 1})"

    errors = sum(1 for d in diagnostics if d.severity is Severity.ERROR)
    warnings = len(diagnostics) - errors
    parts = []
    if errors:
        parts.append(f"{errors} error{'' if errors == 1 else 's'}")
    if warnings:
        parts.append(f"{warnings} warning{'' if warnings == 1 else 's'}")
    return f"{', '.join(parts)}; first: {first.message} (line {first.line}, col {first.column + 1})"


def closest_match(needle: str, candidates, max_distance: int = 3) -> str:
    """The candidate nearest ``needle``, or "" when nothing is near enough.

    Ported from the reference: a case-only difference always wins, and a best distance past
    ``max_distance`` — or past about half the needle's length — is not a typo but a different
    word, where saying "did you mean" is worse than saying nothing.
    """
    names = list(candidates)
    if not needle or not names:
        return ""
    limit = min(max_distance, max(1, len(needle) // 2 + 1))
    lower = needle.lower()
    for candidate in names:
        if candidate.lower() == lower and candidate != needle:
            return candidate
    best, best_distance = "", None
    for candidate in names:
        d = _distance(needle, candidate)
        if best_distance is None or d < best_distance:
            best, best_distance = candidate, d
    return best if best_distance is not None and best_distance <= limit else ""


def _distance(a: str, b: str) -> int:
    """Levenshtein, the same two-row walk the reference uses."""
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        curr = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[n]
