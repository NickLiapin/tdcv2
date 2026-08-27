"""Config text into a parse tree.

The grammar comes from ``../grammar`` — the same files the other implementations generate their
parsers from. One grammar is what stops three languages from slowly accepting different dialects.

ANTLR's default is to print syntax errors and carry on with a best-effort tree. That is wrong for
a data generator: a config that half-parsed would produce data that looks plausible and is not
what was asked for. Errors are collected here and the caller decides.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from antlr4 import CommonTokenStream, InputStream, Token
from antlr4.error.ErrorListener import ErrorListener
from antlr4.tree.Tree import ParseTreeListener

from . import paired_data
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


# The grammar rules that open a tag, and what the tag is called. ``None`` means the rule
# carries its own ``name=NAME`` and the name is read off the context.
_TAG_RULES = {"openCloseElement": None, "dataElement": "data", "mapElement": "map"}


def _enclosing_open_tag(recognizer) -> str | None:
    """The tag that was still open when the input ended.

    ANTLR's own words for this are ``mismatched input '<EOF>' expecting '</data>'`` and
    ``missing END_TAG at '<EOF>'`` — the first names the tag in a shape a reader has to
    decode, the second does not name it at all. The parser knows which rule it was inside
    and that rule carries the tag's name, so the question is answerable: walk out to the
    nearest tag-opening rule and read it.

    ``None`` when no such rule is on the stack, in which case ANTLR's message stands — a
    wrong guess about which tag is open would be worse than jargon.
    """
    ctx = recognizer._ctx
    while ctx is not None:
        rule = recognizer.ruleNames[ctx.getRuleIndex()]
        if rule in _TAG_RULES:
            fixed = _TAG_RULES[rule]
            if fixed is not None:
                return fixed
            named = getattr(ctx, "name", None)
            return named.text if named is not None and named.text else None
        ctx = ctx.parentCtx
    return None


class _Collector(ErrorListener):
    """Gathers syntax errors instead of writing them to the console."""

    def __init__(self) -> None:
        super().__init__()
        self.problems: list[SyntaxProblem] = []

    def syntaxError(  # noqa: N802 - the name is ANTLR's
        self, recognizer, offending_symbol, line, column, msg, e
    ) -> None:
        if (
            getattr(recognizer, "ruleNames", None)
            and offending_symbol is not None
            and offending_symbol.type == Token.EOF
        ):
            open_tag = _enclosing_open_tag(recognizer)
            if open_tag is not None:
                msg = f"<{open_tag}> is never closed"
        self.problems.append(SyntaxProblem(line, column, msg))


class _ElementDepthError(Exception):
    """Raised when a document nests elements deeper than MAX_ELEMENT_DEPTH."""

    def __init__(self, line: int, column: int) -> None:
        super().__init__(
            f"elements nested deeper than {MAX_ELEMENT_DEPTH} levels — refusing a runaway document"
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


class _ClosingTagGuard(ParseTreeListener):
    """Records the first closing tag whose name is not its element's.

    ``openCloseElement : LT name=NAME attr* GT content endTag=END_TAG ;`` takes ANY name in the
    closing tag, so ``<sequence>...</gen>`` was a structurally valid document and nothing
    downstream compared the two: the element is built under its OPENING name and the closing tag
    is thrown away.

    Only the first is kept. A closing tag on the wrong element shifts every closing tag after it,
    so one typo would otherwise produce a mismatch per remaining level — all describing the same
    typo, and only the first one placed where the author can act on it.
    """

    def __init__(self) -> None:
        self.found: SyntaxProblem | None = None

    def enterEveryRule(self, ctx) -> None:  # noqa: N802 - the name is ANTLR's
        """The closing tag is not read until the rule exits."""

    def exitEveryRule(self, ctx) -> None:  # noqa: N802 - the name is ANTLR's
        if self.found is not None or ctx.getRuleIndex() != TDCParser.RULE_openCloseElement:
            return
        open_tag, close = ctx.name, ctx.endTag
        # Recovery can leave either token missing or synthesised. A guess about what the author
        # meant to close is worth less than the parser's own complaint about the tag itself.
        if open_tag is None or close is None or close.type != TDCParser.END_TAG:
            return
        closes = _closing_name(close.text or "")
        if closes is None or closes == open_tag.text:
            return
        self.found = SyntaxProblem(
            close.line,
            close.column,
            f"</{closes}> closes <{open_tag.text}>, which was opened on line {open_tag.line}",
        )


def _closing_name(text: str) -> str | None:
    """``</gen>`` to ``gen``. None for anything that is not a closing tag."""
    if not text.startswith("</") or not text.endswith(">"):
        return None
    return text[2:-1]


def _with_closing_tag_mismatch(
    problems: list[SyntaxProblem], mismatch: SyntaxProblem | None
) -> list[SyntaxProblem]:
    """Put the mismatch in its place, and drop what the parser said after it.

    Everything reported past a misplaced closing tag is reading a tree that has already gone
    wrong — ``extraneous input '</tdc>'`` at the bottom of the file being the usual one. What was
    said BEFORE it is about a part of the document the mismatch had not reached.
    """
    if mismatch is None:
        return problems
    before = [
        p
        for p in problems
        if p.line < mismatch.line or (p.line == mismatch.line and p.column < mismatch.column)
    ]
    return [*before, mismatch]


def parse(source: str) -> Result:
    """Parse a config, collecting syntax errors rather than printing them."""
    collector = _Collector()

    normalized, paired_problems = paired_data.preprocess(source)
    # Ahead of ANTLR's own, because they were found ahead of it: a config whose paired tags do not
    # line up is misread from that point on, and the first thing said about it should say why.
    problems = [SyntaxProblem(line, column, message) for line, column, message in paired_problems]

    lexer = TDCLexer(InputStream(normalized))
    lexer.removeErrorListeners()
    lexer.addErrorListener(collector)

    parser = TDCParser(CommonTokenStream(lexer))
    parser.removeErrorListeners()
    parser.addErrorListener(collector)
    parser.addParseListener(_DepthGuard())
    closing_tags = _ClosingTagGuard()
    parser.addParseListener(closing_tags)

    try:
        tree = parser.document()
    except _ElementDepthError as refusal:
        # Past the ceiling there is no tree worth building — parsing it IS the
        # danger. Callers get what garbage input gets: an empty document plus
        # the problem that explains it.
        problems.extend(collector.problems)
        problems.append(SyntaxProblem(refusal.line, refusal.column, str(refusal)))
        return Result(_empty_document(), problems)
    problems.extend(_with_closing_tag_mismatch(collector.problems, closing_tags.found))
    return Result(tree, problems)


def _empty_document() -> TDCParser.DocumentContext:
    """A tree with nothing in it, for when the source is refused mid-parse."""
    return TDCParser(CommonTokenStream(TDCLexer(InputStream("")))).document()
