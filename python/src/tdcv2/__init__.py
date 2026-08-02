"""TDC — The Data Constructor. Deterministic test data from a declarative config."""

from .errors import Diagnostic, Severity, TdcError
from .quick import TdcQuickError, tdc
from .tdc import TDC, Row, SeedInfo

__all__ = [
    "TDC",
    "Diagnostic",
    "Row",
    "SeedInfo",
    "Severity",
    "TdcError",
    "TdcQuickError",
    "tdc",
]
