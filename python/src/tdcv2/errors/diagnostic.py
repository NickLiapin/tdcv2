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

    @staticmethod
    def error(code: str, message: str, hint: str, line: int, column: int) -> Diagnostic:
        return Diagnostic(Severity.ERROR, code, message, hint, line, column)

    @staticmethod
    def warning(code: str, message: str, hint: str, line: int, column: int) -> Diagnostic:
        return Diagnostic(Severity.WARNING, code, message, hint, line, column)

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
