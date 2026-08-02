"""The compute layer: a check digit written as a tag tree rather than as code."""

from .evaluate import Scope, evaluate, evaluate_predicate
from .value import ComputeError, Value

__all__ = ["ComputeError", "Scope", "Value", "evaluate", "evaluate_predicate"]
