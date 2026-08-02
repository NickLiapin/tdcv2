"""``if="..."`` — the small expression language that decides whether a line is written."""

from .evaluate import as_condition, to_boolean
from .parse import parse

__all__ = ["as_condition", "parse", "to_boolean"]
