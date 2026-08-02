"""Diagnostics, printed the way a compiler prints them.

A header carrying severity and code, a ``-->`` line naming the position, the offending source line
with a caret under it, and the hint as a ``note``. The point is that one block pasted into a chat
or an issue is actionable on its own — nobody has to also send the config.

Ported from ``typescript/src/errors/format.ts`` and held to it by
``fixtures/cross-language/cli.json``: a user who runs the same broken config through two
implementations should see the same complaint, not two dialects of it.

    error[TDC071]: unknown template path "nosuch.path"
     --> demo.tdc:3:57
      |
    3 |     <sequence name="N"><gen type="template" value="nosuch.path"/></sequence>
      |                                                         ^
      |
    note: check the pack name
"""

from __future__ import annotations

from .diagnostic import Diagnostic, Severity

_RED = "\x1b[31m"
_YELLOW = "\x1b[33m"
_CYAN = "\x1b[36m"
_BOLD = "\x1b[1m"
_RESET = "\x1b[0m"


def _colorize(text: str, code: str, enabled: bool) -> str:
    return f"{code}{text}{_RESET}" if enabled else text


def format_diagnostic(
    diagnostic: Diagnostic,
    source: str | None = None,
    filename: str = "<input>",
    colors: bool = False,
) -> str:
    """One diagnostic as a block. Without ``source`` only the header and position are printed."""
    severity_color = _RED if diagnostic.severity is Severity.ERROR else _YELLOW
    label = _colorize(
        _colorize(str(diagnostic.severity), severity_color, colors)
        + (f"[{diagnostic.code}]" if diagnostic.code else ""),
        _BOLD,
        colors,
    )

    lines = [
        f"{label}: {diagnostic.message}",
        # The column is held 0-based, as the shared fixtures record it, and printed 1-based, as
        # every editor counts.
        f" --> {filename}:{diagnostic.line}:{diagnostic.column + 1}",
    ]

    if source:
        lines.extend(_snippet(diagnostic, source, colors))
    if diagnostic.hint:
        lines.append(f"{_colorize('note', _CYAN, colors)}: {diagnostic.hint}")

    return "\n".join(lines)


def format_diagnostics(
    diagnostics: list[Diagnostic],
    source: str | None = None,
    filename: str = "<input>",
    colors: bool = False,
) -> str:
    """Every diagnostic as a block, with a count at the end. Empty input gives an empty string."""
    if not diagnostics:
        return ""

    blocks = [format_diagnostic(d, source, filename, colors) for d in diagnostics]
    errors = sum(1 for d in diagnostics if d.severity is Severity.ERROR)
    warnings = len(diagnostics) - errors

    parts = []
    if errors:
        parts.append(f"{errors} error{'' if errors == 1 else 's'}")
    if warnings:
        parts.append(f"{warnings} warning{'' if warnings == 1 else 's'}")

    # "aborted" only when something actually stopped. Warnings alone leave a run that finished,
    # and announcing it as aborted sends the reader looking for a failure that never happened.
    line = "aborted: " + ", ".join(parts) if errors else ", ".join(parts)
    summary = _colorize(line, _BOLD, colors)
    return "\n\n".join([*blocks, "", summary])


def _tag_end(text: str, at: int) -> int:
    """The ``>`` that closes the tag opening at *at* — a ``>`` inside a value ends nothing."""
    quote = ""
    i = at + 1
    while i < len(text):
        c = text[i]
        if quote:
            if c == quote:
                quote = ""
        elif c in "\"'":
            quote = c
        elif c == ">":
            return i
        i += 1
    return -1


def _underline(text: str, column: int) -> int:
    """How many characters the carets cover: the whole of what is wrong, not its first letter.

    Read back off the source line rather than carried on the diagnostic. A position points at one
    of two things — an element, or a value inside its quotes — and both say where they end in the
    text itself, so a hundred call sites do not each have to remember to pass a length they would
    get wrong once and nobody would notice.

    Every diagnostic in the shared fixtures underlines exactly what the reference underlines; a
    position that is neither gets one caret, which is what it had before.
    """
    if column >= len(text):
        return 1

    # A tag: through its closing ``>``, or through the matching ``</name>`` when it has one.
    # ``<!--`` is not a tag, so a comment is not swallowed.
    nxt = text[column + 1 : column + 2]
    if text[column] == "<" and nxt.isascii() and nxt.isalpha():
        open_end = _tag_end(text, column)
        if open_end < 0:
            return len(text) - column
        if text[open_end - 1] == "/":
            return open_end + 1 - column
        depth, k = 1, open_end + 1
        while k < len(text):
            if text[k] != "<":
                k += 1
                continue
            if text[k + 1 : k + 2] == "/":
                close_end = text.find(">", k)
                if close_end < 0:
                    break
                depth -= 1
                if depth == 0:
                    return close_end + 1 - column
                k = close_end + 1
            else:
                end = _tag_end(text, k)
                if end < 0:
                    break
                if text[end - 1] != "/":
                    depth += 1
                k = end + 1
        return len(text) - column

    # Otherwise a value: up to the quote that closes it. An empty one puts the position on that
    # quote already, and underlines the one character.
    close = text.find('"', column)
    return close - column if close > column else 1


# The widest source excerpt a snippet will show. A generated single-line config
# can be arbitrarily long; echoing 100 KB of it (plus as many carets) buries the
# message it was meant to illustrate. The same formula lives in the other four
# implementations' renderers; change them together.
_SNIPPET_WINDOW = 160


def _snippet(diagnostic: Diagnostic, source: str, colors: bool) -> list[str]:
    """The offending line, carets under what is wrong. Nothing when the line is out of range."""
    source_lines = source.split("\n")
    index = diagnostic.line - 1
    if index < 0 or index >= len(source_lines):
        return []
    text = source_lines[index]

    width = len(str(diagnostic.line))
    blank = " " * width
    pipe = _colorize("|", _CYAN, colors)
    column = max(0, diagnostic.column)
    caret_len = _underline(text, column)

    # Window an over-long line around the carets, marking cut edges with "…".
    shown = text
    caret_start = column
    if len(text) > _SNIPPET_WINDOW:
        start = max(0, min(column - 40, len(text) - _SNIPPET_WINDOW))
        end = start + _SNIPPET_WINDOW
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(text) else ""
        shown = prefix + text[start:end] + suffix
        caret_len = max(1, min(caret_len, end - column))
        caret_start = column - start + len(prefix)

    caret = " " * caret_start + _colorize("^" * caret_len, _RED, colors)

    return [
        f"{blank} {pipe}",
        f"{_colorize(str(diagnostic.line).rjust(width), _CYAN, colors)} {pipe} {shown}",
        f"{blank} {pipe} {caret}",
        f"{blank} {pipe}",
    ]
