"""Diagnostics: what is wrong with a config, where, and how badly."""

from .diagnostic import Diagnostic, Severity, TdcError, has_errors, summarize
from .render import format_diagnostic, format_diagnostics

__all__ = [
    "Diagnostic",
    "Severity",
    "TdcError",
    "format_diagnostic",
    "format_diagnostics",
    "has_errors",
    "summarize",
]
