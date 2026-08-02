"""Config text into a parse tree, from the grammar every implementation shares."""

from .facade import Result, SyntaxProblem, parse

__all__ = ["Result", "SyntaxProblem", "parse"]
