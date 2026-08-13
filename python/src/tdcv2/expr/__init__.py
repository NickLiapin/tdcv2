"""``if="..."`` — the small expression language that decides whether a line is written."""

from .evaluate import as_condition, as_value, to_boolean
from .parse import parse

__all__ = ["as_condition", "as_value", "parse", "to_boolean"]
