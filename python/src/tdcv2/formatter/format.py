"""Pretty-printer for ``.tdc`` documents.

Re-emits the parsed tree with consistent indentation, tidy attribute spacing, inline output rows,
and an aligned ``<map>`` table. Built to be SAFE: the formatted text must generate byte-identical
output to the original, which is what the tests check by rendering before and after.

Preserved verbatim:

* ``<data>`` bodies — that is literal generator output, including ``<data pair="…">``.
* Comments, reinjected from the token stream by position.
* Attribute order and values.

Normalized:

* Indentation, four spaces a level, one element per line for structure.
* A single space between attributes; none before ``>`` or ``/>``.
* ``<map>`` rows: on one line when short, else an aligned table.

A document with a syntax error is returned unchanged. Never reformat a file that cannot be fully
parsed — the output would be a guess about what the author meant.

Ported from ``typescript/src/formatter/format.ts``. The three implementations must produce the
same bytes: a team using two of them would otherwise get a formatting diff on every commit, which
is exactly the churn a formatter exists to end.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from antlr4 import CommonTokenStream, InputStream

from ..parser import paired_data
from ..parser.generated.TDCLexer import TDCLexer
from ..parser.generated.TDCParser import TDCParser

INDENT = "    "

#: Tags whose children always go on their own indented lines.
BLOCK_TAGS = frozenset(
    {
        "tdc", "env", "block", "sequence", "mix", "switch", "distinct", "uniq",
        "before", "after", "before_block", "after_block", "delimiter_block",
        "before_line", "after_line", "delimiter_line",
    }
)  # fmt: skip

#: Longest an inlined element may be before it wraps.
INLINE_MAX = 100

#: Longest a one-line ``<map>`` may be before it becomes a table.
MAP_INLINE_MAX = 72


@dataclass
class _Context:
    lines: list[str] = field(default_factory=list)
    comments: list[tuple[int, str]] = field(default_factory=list)
    index: int = 0


def format_tdc(source: str) -> str:
    """A formatted config, or the source unchanged when it does not parse."""
    normalized, paired_problems = paired_data.preprocess(source)
    lexer = TDCLexer(InputStream(normalized))
    lexer.removeErrorListeners()
    tokens = CommonTokenStream(lexer)
    parser = TDCParser(tokens)
    parser.removeErrorListeners()

    problems: list[str] = []

    class _Fail:
        def syntaxError(self, *_args) -> None:  # noqa: N802 — ANTLR's own spelling
            problems.append("x")

        def reportAmbiguity(self, *_args) -> None:  # noqa: N802
            pass

        def reportAttemptingFullContext(self, *_args) -> None:  # noqa: N802
            pass

        def reportContextSensitivity(self, *_args) -> None:  # noqa: N802
            pass

    listener = _Fail()
    lexer.addErrorListener(listener)
    parser.addErrorListener(listener)

    tree = parser.document()
    if problems or paired_problems:
        return source

    tokens.fill()
    context = _Context(
        comments=[
            (t.start, (t.text or "").strip()) for t in tokens.tokens if t.type == TDCLexer.COMMENT
        ]
    )

    for element in tree.element():
        _flush_comments_before(_start(element), 0, context)
        _emit_element(element, 0, context)
    _flush_comments_before(1 << 62, 0, context)

    return "\n".join(context.lines) + "\n"


def _start(node) -> int:
    return node.start.start if node.start is not None else 0


def _flush_comments_before(position: int, depth: int, context: _Context) -> None:
    while context.index < len(context.comments):
        at, text = context.comments[context.index]
        if at >= position:
            break
        context.lines.append(INDENT * depth + text)
        context.index += 1


def _emit_element(element, depth: int, context: _Context) -> None:
    map_element = element.mapElement()
    if map_element is not None:
        _emit_map(map_element, depth, context)
        return

    data = element.dataElement()
    if data is not None:
        context.lines.append(INDENT * depth + _data_string(data))
        return

    self_closing = element.selfClosingElement()
    if self_closing is not None:
        name = self_closing.name.text
        context.lines.append(f"{INDENT * depth}<{name}{_attr_string(self_closing)}/>")
        return

    open_element = element.openCloseElement()
    if open_element is not None:
        _emit_open(open_element, depth, context)


def _emit_open(node, depth: int, context: _Context) -> None:
    name = node.name.text
    open_tag = f"<{name}{_attr_string(node)}>"
    children = _children(node.content())
    pad = INDENT * depth

    if not children:
        context.lines.append(f"{pad}{open_tag}</{name}>")
        return

    inline = None
    if name not in BLOCK_TAGS and not _has_comment_within(node, context):
        inline = _try_inline_open(node)
    if inline is not None and len(pad + inline) <= INLINE_MAX:
        context.lines.append(pad + inline)
        return

    context.lines.append(pad + open_tag)
    for child in children:
        _flush_comments_before(_start(child), depth + 1, context)
        _emit_element(child, depth + 1, context)
    context.lines.append(f"{pad}</{name}>")


def _children(content) -> list:
    return [] if content is None else list(content.element())


def _try_inline(element) -> str | None:
    """One-line rendering, or ``None`` when the element must span several."""
    map_element = element.mapElement()
    if map_element is not None:
        return _inline_map(map_element)

    data = element.dataElement()
    if data is not None:
        return _data_string(data)

    self_closing = element.selfClosingElement()
    if self_closing is not None:
        return f"<{self_closing.name.text}{_attr_string(self_closing)}/>"

    open_element = element.openCloseElement()
    return _try_inline_open(open_element) if open_element is not None else ""


def _try_inline_open(node) -> str | None:
    name = node.name.text
    if name in BLOCK_TAGS:
        return None
    open_tag = f"<{name}{_attr_string(node)}>"
    children = _children(node.content())
    if not children:
        return f"{open_tag}</{name}>"

    inner = []
    for child in children:
        part = _try_inline(child)
        if part is None:
            return None
        inner.append(part)
    return f"{open_tag}{''.join(inner)}</{name}>"


# ── <data> ──────────────────────────────────────────────────────────────────────────────────


def _data_string(node) -> str:
    attrs = _attr_string(node)
    content = node.dataContent() if hasattr(node, "dataContent") else None
    if content is None:
        # A self-closing <data …/> has no body.
        return f"<data{attrs}/>"
    pair = _attr_map(node).get("pair")
    close = f'</data pair="{pair}">' if pair is not None else "</data>"
    return f"<data{attrs}>{paired_data.restore(content.getText())}{close}"


# ── <map> ───────────────────────────────────────────────────────────────────────────────────


def _map_rows(map_element) -> list[tuple[str, str]]:
    content = map_element.mapContent() if hasattr(map_element, "mapContent") else None
    if content is None:
        return []

    rows: list[tuple[str, str]] = []
    for raw in content.getText().split(","):
        row = raw.strip()
        if not row:
            continue
        colon = row.find(":")
        if colon < 0:
            continue
        keys = "|".join(part.strip() for part in row[:colon].split("|") if part.strip())
        if not keys:
            continue
        rows.append((keys, row[colon + 1 :].strip()))
    return rows


def _inline_map(map_element) -> str:
    body = ", ".join(f"{keys}:{value}" for keys, value in _map_rows(map_element))
    return f"<map{_attr_string(map_element)}>{body}</map>"


def _emit_map(map_element, depth: int, context: _Context) -> None:
    pad = INDENT * depth
    rows = _map_rows(map_element)
    if not rows:
        context.lines.append(f"{pad}<map{_attr_string(map_element)}></map>")
        return

    inline = _inline_map(map_element)
    if len(rows) <= 1 or len(pad + inline) <= MAP_INLINE_MAX:
        context.lines.append(pad + inline)
        return

    # An aligned table: keys padded to the widest, a " : " separator, and a trailing comma on all
    # but the last row — the map reader splits on commas.
    width = max(len(keys) for keys, _ in rows)
    context.lines.append(f"{pad}<map{_attr_string(map_element)}>")
    for i, (keys, value) in enumerate(rows):
        comma = "," if i < len(rows) - 1 else ""
        context.lines.append(f"{pad}{INDENT}{keys.ljust(width)} : {value}{comma}")
    context.lines.append(f"{pad}</map>")


# ── attributes and comments ─────────────────────────────────────────────────────────────────


def _attr_list(node) -> list:
    attr = getattr(node, "attr", None)
    return attr() if callable(attr) else []


def _attr_map(node) -> dict[str, str]:
    out: dict[str, str] = {}
    for a in _attr_list(node):
        if a.attrName is None:
            continue
        value = a.attrValue.text if a.attrValue is not None else ""
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        out[a.attrName.text] = value
    return out


def _attr_string(node) -> str:
    out = []
    for name, value in _attr_map(node).items():
        if name:
            out.append(f' {name}="{value}"')
    return "".join(out)


def _has_comment_within(node, context: _Context) -> bool:
    start = node.start.start if node.start is not None else 0
    stop = node.stop.stop if node.stop is not None else start
    return any(start < at < stop for at, _ in context.comments)
