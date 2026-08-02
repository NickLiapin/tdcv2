"""Config text into a parse tree.

The grammar comes from ``../grammar`` — the same files the other implementations generate their
parsers from. One grammar is what stops three languages from slowly accepting different dialects.

ANTLR's default is to print syntax errors and carry on with a best-effort tree. That is wrong for
a data generator: a config that half-parsed would produce data that looks plausible and is not
what was asked for. Errors are collected here and the caller decides.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from antlr4 import CommonTokenStream, InputStream
from antlr4.error.ErrorListener import ErrorListener
from antlr4.tree.Tree import ParseTreeListener

from .generated.TDCLexer import TDCLexer
from .generated.TDCParser import TDCParser

# A hard ceiling on element nesting. The parser recurses once per nested
# element, so input depth IS stack depth: a runaway document must be refused,
# not parsed until the stack gives out. Real configs nest a handful of levels.
MAX_ELEMENT_DEPTH = 64


@dataclass(frozen=True, slots=True)
class SyntaxProblem:
    """One syntax error, with the position a user can act on."""

    line: int
    column: int
    message: str

    def __str__(self) -> str:
        return f"{self.line}:{self.column} {self.message}"


@dataclass(frozen=True, slots=True)
class Result:
    """A parse tree plus whatever went wrong producing it."""

    tree: TDCParser.DocumentContext
    problems: list[SyntaxProblem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


class _Collector(ErrorListener):
    """Gathers syntax errors instead of writing them to the console."""

    def __init__(self) -> None:
        super().__init__()
        self.problems: list[SyntaxProblem] = []

    def syntaxError(  # noqa: N802 - the name is ANTLR's
        self, recognizer, offending_symbol, line, column, msg, e
    ) -> None:
        self.problems.append(SyntaxProblem(line, column, msg))


class _ElementDepthError(Exception):
    """Raised when a document nests elements deeper than MAX_ELEMENT_DEPTH."""

    def __init__(self, line: int, column: int) -> None:
        super().__init__(
            f"elements nested deeper than {MAX_ELEMENT_DEPTH} levels — "
            "refusing a runaway document"
        )
        self.line = line
        self.column = column


class _DepthGuard(ParseTreeListener):
    """Counts ``element`` rule entries and refuses the level past the ceiling.

    A parse listener fires before the rule body recurses — exactly the moment
    the 65th level is about to open and the stack is still shallow.
    """

    def __init__(self) -> None:
        self._depth = 0

    def enterEveryRule(self, ctx) -> None:  # noqa: N802 - the name is ANTLR's
        if ctx.getRuleIndex() != TDCParser.RULE_element:
            return
        self._depth += 1
        if self._depth > MAX_ELEMENT_DEPTH:
            start = ctx.start
            raise _ElementDepthError(start.line, start.column)

    def exitEveryRule(self, ctx) -> None:  # noqa: N802 - the name is ANTLR's
        if ctx.getRuleIndex() == TDCParser.RULE_element:
            self._depth -= 1


def parse(source: str) -> Result:
    """Parse a config, collecting syntax errors rather than printing them."""
    collector = _Collector()

    lexer = TDCLexer(InputStream(_normalize(source)))
    lexer.removeErrorListeners()
    lexer.addErrorListener(collector)

    parser = TDCParser(CommonTokenStream(lexer))
    parser.removeErrorListeners()
    parser.addErrorListener(collector)
    parser.addParseListener(_DepthGuard())

    try:
        tree = parser.document()
    except _ElementDepthError as refusal:
        # Past the ceiling there is no tree worth building — parsing it IS the
        # danger. Callers get what garbage input gets: an empty document plus
        # the problem that explains it.
        problems = list(collector.problems)
        problems.append(SyntaxProblem(refusal.line, refusal.column, str(refusal)))
        return Result(_empty_document(), problems)
    return Result(tree, list(collector.problems))


def _empty_document() -> TDCParser.DocumentContext:
    """A tree with nothing in it, for when the source is refused mid-parse."""
    return TDCParser(CommonTokenStream(TDCLexer(InputStream("")))).document()


def _normalize(source: str) -> str:
    """Rewrite paired raw text before lexing.

    A hook rather than a transformation today: the grammar keeps one static ``</data>`` close
    token, and a future paired form would need rewriting here — in every implementation, or they
    would disagree about any config using it.
    """
    return source
